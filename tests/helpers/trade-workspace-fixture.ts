import type Database from "better-sqlite3";
import { defaultBacktestCosts } from "../../src/lib/backtest/backtest-costs";
import {
  positionFor,
  tradeFees,
  tradeInputSchema,
  type Trade,
} from "../../src/lib/portfolio/trade-ledger";
import { TradeLedgerStore } from "../../src/server/portfolio/trade-ledger-store";
import { seedLedger } from "./signal-ledger-fixture";

/** Synthetic, deterministic local facts. No credentials, provider calls or orders. */
export function seedTradeWorkspace(db: Database.Database, count = 10000) {
  const calendar: string[] = [];
  for (let day = 0; day < 250; day++) {
    const date = new Date(Date.UTC(2026, 0, 1 + day));
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
      calendar.push(date.toISOString().slice(0, 10));
  }
  seedLedger(db, 10000);
  const trades: Trade[] = [];
  const insert = db.prepare("INSERT INTO trade_ledger VALUES(?,?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const security = i % 200,
        round = Math.floor(i / 200);
      const input = tradeInputSchema.parse({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        symbol: `sh${600000 + security}`,
        date: calendar[round],
        side: round % 2 ? "sell" : "buy",
        price: 10,
        quantity: round % 2 ? 100 : 200,
        lowerLimit: 9,
        upperLimit: 11,
        limitSource: "隔离合成当日限价",
        signalId:
          security < 60 && round % 2 === 0
            ? `fixture:${String(security).padStart(6, "0")}`
            : null,
        stop: 9,
        note: i % 9 === 0 ? "补录核对 中文备注" : "隔离基线",
      });
      const trade: Trade = {
        ...input,
        createdAt: Date.UTC(2026, 8, 1) + Math.floor(i / 3),
        fees: tradeFees(input),
        costs: { ...defaultBacktestCosts },
        methods: ["astock-market-rules", "mock-trading"].map((skillId) => ({
          skillId,
          ruleVersion: "synthetic-1",
          outputSchema: "fixture",
          files: [{ file: "SKILL.md", hash: "a".repeat(64) }],
          prerequisites: ["合成规则出处".repeat(20)],
        })),
      };
      trades.push(trade);
      insert.run(trade.id, trade.symbol, trade.date, JSON.stringify(trade));
    }
  })();
  const store = new TradeLedgerStore(db);
  for (let i = 0; i < 200; i++) {
    const symbol = `sh${600000 + i}`;
    const position = positionFor(symbol, trades, calendar.at(-1)!, calendar, {
      source: "synthetic dividend evidence, not provider data",
      coverageEnd: calendar.at(-1)!,
      events: [1, 2, 3, 4, 5].map((n) => ({
        date: calendar[n * 8]!,
        category: 1,
        name: "除息",
        dividend: 0.01,
      })),
    });
    // Validate every full chronology; never seed an impossible sale just to inflate rows.
    if (position.quantity < 0) throw new Error("Invalid fixture position");
    store.archive(position.adjustments);
  }
  return { calendar, count, securities: 200, signals: 10000 };
}
