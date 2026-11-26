import type Database from "better-sqlite3";
import Big from "big.js";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { VenueBinding } from "trading-strategies";
import { z } from "zod";
import {
  getAccountRiskState,
  upsertAccountRiskState,
} from "../db/account-risk-state-repository";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { records } from "../db/schema";
import { planningAccount } from "./account-coordinator";
import type { PipelineAccountState } from "./signal-risk-runner";

const checkpointSchema = z.object({
  inceptionEquity: z.number().finite().positive(),
  equity: z.number().finite().positive(),
  drawdownPct: z.number().finite().min(0).max(1),
});

/** External snapshots expose total equity without a unit count or cash-flow ledger.
 * Use the first priced equity as the unit basis, shared across deployments. */
export function externalAccountDrawdown(
  binding: VenueBinding,
  date: string,
  state: PipelineAccountState,
  db: Database.Database,
) {
  if (
    !Number.isFinite(state.equity) ||
    state.equity <= 0 ||
    !Number.isFinite(state.cash) ||
    state.cash < 0 ||
    state.positions.some(
      (p) =>
        p.sellable > p.quantity ||
        (p.quantity > 0 && (p.lastPrice === null || p.lastPrice <= 0)),
    )
  )
    return null;
  const account = planningAccount(binding);
  const kind = "pipeline-external-equity";
  const checkpointId = (day: string) =>
    JSON.stringify([kind, account.accountScope, account.accountId, day]);
  const workspace = new AccountWorkspaceRepository(db);
  return workspace.atomic(() => {
    const prior = getAccountRiskState(account, db);
    const checkpoint =
      prior &&
      checkpointSchema.safeParse(
        workspace.record(
          checkpointId(date < prior.asOfDate ? date : prior.asOfDate),
        ),
      );
    if (checkpoint && !checkpoint.success) return null;
    if (prior && date < prior.asOfDate)
      return checkpoint?.data?.equity === state.equity
        ? checkpoint.data.drawdownPct
        : null;
    const inceptionEquity = checkpoint?.data?.inceptionEquity ?? state.equity;
    const unitNav = new Big(state.equity).div(inceptionEquity).toNumber();
    // A bridge can already know a peak predating our first observation.
    const reported = state.drawdownPct;
    if (
      reported !== null &&
      (!Number.isFinite(reported) || reported < 0 || reported >= 1)
    )
      return null;
    const reportedPeak = reported
      ? new Big(unitNav).div(new Big(1).minus(reported)).toNumber()
      : unitNav;
    const peakUnitNav = Math.max(
      prior?.peakUnitNav ?? 1,
      unitNav,
      reportedPeak,
    );
    if (
      !Number.isFinite(unitNav) ||
      unitNav <= 0 ||
      !Number.isFinite(peakUnitNav)
    )
      return null;
    const drawdownPct = new Big(peakUnitNav)
      .minus(unitNav)
      .div(peakUnitNav)
      .toNumber();
    if (
      prior?.asOfDate === date &&
      prior.unitNav === unitNav &&
      prior.peakUnitNav === peakUnitNav &&
      prior.regime === (state.riskRegime ?? "normal")
    )
      return prior.drawdownPct;
    const saved = upsertAccountRiskState(
      {
        ...account,
        asOfDate: date,
        unitNav,
        peakUnitNav,
        drawdownPct,
        regime: state.riskRegime ?? "normal",
      },
      db,
    );
    const payload = { inceptionEquity, equity: state.equity, drawdownPct };
    drizzle(db)
      .insert(records)
      .values({
        id: checkpointId(date),
        kind,
        payload,
        updatedAt: saved.updatedAt,
      })
      .onConflictDoUpdate({
        target: records.id,
        set: { payload, updatedAt: saved.updatedAt },
      })
      .run();
    return drawdownPct;
  });
}
