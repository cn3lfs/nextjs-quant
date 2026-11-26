import { z } from "zod";
import {
  defaultPortfolioRiskPolicy,
  evaluatePortfolioRisk,
} from "quant-execution";
import { sqlite } from "./index";

export const accountKeySchema = z.object({
  accountScope: z.enum([
    "real",
    "paper",
    "local_sim",
    "ths_mock",
    "crypto_sim",
    "futures_sim",
  ]),
  accountId: z.string().trim().min(1),
});
export type AccountKey = z.infer<typeof accountKeySchema>;

const stateSchema = accountKeySchema.extend({
  asOfDate: z.string().date(),
  unitNav: z.number().finite().positive(),
  peakUnitNav: z.number().finite().positive(),
  drawdownPct: z.number().finite().nonnegative(),
  regime: z.enum(["normal", "reduced", "halted"]),
  recoveryStreak: z.number().int().safe().nonnegative().default(0),
  updatedAt: z.number().int().safe().default(Date.now),
});
export type AccountRiskState = z.output<typeof stateSchema>;

const columns = `account_scope AS accountScope, account_id AS accountId, as_of_date AS asOfDate,
  unit_nav AS unitNav, peak_unit_nav AS peakUnitNav, drawdown_pct AS drawdownPct,
  regime, recovery_streak AS recoveryStreak, updated_at AS updatedAt`;

export function getAccountRiskState(account: AccountKey, db = sqlite()) {
  return (
    db
      .prepare<AccountKey, AccountRiskState>(
        `SELECT ${columns} FROM account_risk_states
    WHERE account_scope=@accountScope AND account_id=@accountId`,
      )
      .get(accountKeySchema.parse(account)) ?? null
  );
}

export function upsertAccountRiskState(
  input: z.input<typeof stateSchema>,
  db = sqlite(),
) {
  const state = stateSchema.parse(input);
  db.prepare(
    `INSERT INTO account_risk_states (account_scope,account_id,as_of_date,unit_nav,
    peak_unit_nav,drawdown_pct,regime,recovery_streak,updated_at)
    VALUES (@accountScope,@accountId,@asOfDate,@unitNav,@peakUnitNav,@drawdownPct,@regime,@recoveryStreak,@updatedAt)
    ON CONFLICT(account_scope,account_id) DO UPDATE SET as_of_date=excluded.as_of_date,
    unit_nav=excluded.unit_nav,peak_unit_nav=excluded.peak_unit_nav,drawdown_pct=excluded.drawdown_pct,
    regime=excluded.regime,recovery_streak=excluded.recovery_streak,updated_at=excluded.updated_at`,
  ).run(state);
  return state;
}

export function listAccountRiskStates(db = sqlite()) {
  return db
    .prepare<[], AccountRiskState>(
      `SELECT ${columns} FROM account_risk_states ORDER BY account_scope,account_id`,
    )
    .all();
}

/** One transition per completed account close, shared by all deployments.
 * Retain its observation so historical reads never borrow a future peak. */
export function recordAccountRiskClose(
  account: AccountKey,
  date: string,
  unitNav: number,
  previousSessionDate: string,
  db = sqlite(),
) {
  const historyId = JSON.stringify([
    "pipeline-account-risk-close",
    account.accountScope,
    account.accountId,
    date,
  ]);
  return db
    .transaction(() => {
      const prior = getAccountRiskState(account, db);
      if (prior && prior.asOfDate >= date) {
        const row = db
          .prepare<[string], { payload: string }>(
            "SELECT payload FROM records WHERE id=? AND kind='pipeline-account-risk-close'",
          )
          .get(historyId);
        const saved = row
          ? stateSchema.parse(JSON.parse(row.payload))
          : prior.asOfDate === date
            ? prior
            : null;
        return saved?.unitNav === unitNav ? saved : null;
      }
      const previousMode =
        prior?.regime === "halted" ? "paused" : prior?.regime;
      const state = evaluatePortfolioRisk({
        date,
        unitNav,
        previousSessionDate,
        previous:
          prior && previousMode
            ? {
                date: prior.asOfDate,
                unitNav: prior.unitNav,
                peakUnitNav: prior.peakUnitNav,
                drawdown: prior.drawdownPct,
                mode: previousMode,
                scale:
                  previousMode === "normal"
                    ? 1
                    : previousMode === "paused"
                      ? 0
                      : defaultPortfolioRiskPolicy.reducedScale,
                recoveryCloses: prior.recoveryStreak,
              }
            : null,
      });
      const saved = upsertAccountRiskState(
        {
          ...account,
          asOfDate: date,
          unitNav,
          peakUnitNav: state.peakUnitNav,
          drawdownPct: state.drawdown,
          regime: state.mode === "paused" ? "halted" : state.mode,
          recoveryStreak: state.recoveryCloses,
        },
        db,
      );
      db.prepare(
        "INSERT INTO records (id,kind,payload,updated_at) VALUES (?,'pipeline-account-risk-close',?,?)",
      ).run(historyId, JSON.stringify(saved), saved.updatedAt);
      return saved;
    })
    .immediate();
}
