import type Database from "better-sqlite3";
import { defaultBacktestCosts } from "~/lib/backtest-costs";
import {
  positionFor,
  tradeFees,
  tradeInputSchema,
  type Trade,
  type CorporateEvidence,
  type CostAdjustment,
} from "~/lib/trade-ledger";
import type { SkillUse } from "../research/research-skills";
import { createHash } from "node:crypto";

export class TradeLedgerStore {
  constructor(readonly db: Database.Database) {}
  trades(): Trade[] {
    return (
      this.db
        .prepare("SELECT payload FROM trade_ledger ORDER BY trade_date,id")
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as Trade);
  }
  record(
    input: unknown,
    context: {
      today: string;
      calendar: string[];
      methods: SkillUse[];
      evidence: CorporateEvidence;
    },
  ) {
    const t = tradeInputSchema.parse(input);
    return this.db
      .transaction(() => {
        const trades = this.trades();
        const existing = trades.find((v) => v.id === t.id);
        if (existing) {
          if (
            JSON.stringify(tradeInputSchema.parse(existing)) !==
            JSON.stringify(t)
          )
            throw new Error("交易编号已用于不同内容");
          return existing;
        }
        if (t.date > context.today || !context.calendar.includes(t.date))
          throw new Error("交易日期未到或不在本地交易日历内");
        if (t.signalId) {
          const row = this.db
            .prepare(
              "SELECT symbol,observed_date FROM signal_ledger WHERE id=?",
            )
            .get(t.signalId) as
            { symbol: string; observed_date: string } | undefined;
          if (!row || row.symbol !== t.symbol || row.observed_date > t.date)
            throw new Error("关联信号不存在、标的不符或晚于交易");
        }
        if (
          !context.methods.some(
            (m) => m.skillId === "astock-market-rules" && m.files.length,
          ) ||
          !context.methods.some(
            (m) => m.skillId === "mock-trading" && m.files.length,
          )
        )
          throw new Error("交易规则出处缺失");
        const trade: Trade = {
          ...t,
          createdAt: Math.max(
            Date.now(),
            ...trades.map((v) => v.createdAt + 1),
          ),
          methods: context.methods,
          costs: { ...defaultBacktestCosts },
          fees: tradeFees(t),
        };
        // Validate the entire chronology, including subsequent recorded sales when
        // a backdated fill is added. One transaction prevents concurrent overselling.
        positionFor(
          t.symbol,
          [...trades, trade],
          context.today,
          context.calendar,
          context.evidence,
        );
        this.db
          .prepare("INSERT INTO trade_ledger VALUES (?,?,?,?)")
          .run(t.id, t.symbol, t.date, JSON.stringify(trade));
        return trade;
      })
      .immediate();
  }
  archive(adjustments: CostAdjustment[]) {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO trade_adjustments VALUES (?,?,?)",
    );
    this.db.transaction(() => {
      for (const a of adjustments) {
        const id = createHash("sha256").update(a.id).digest("hex");
        insert.run(id, a.symbol, JSON.stringify({ ...a, id }));
      }
    })();
  }
  adjustments(): CostAdjustment[] {
    return (
      this.db
        .prepare("SELECT payload FROM trade_adjustments ORDER BY rowid DESC")
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as CostAdjustment);
  }
}
