import type Database from "better-sqlite3";
import type {
  LedgerSignal,
  Outcome,
} from "../../src/lib/strategy-facts/signal-ledger";
import {
  notificationPolicySchema,
  type NotificationDecision,
} from "../../src/lib/strategy-facts/notification-policy";
import type { LedgerRun } from "../../src/server/monitoring/signal-ledger-store";

/** Deterministic read-model fixtures; never run a scan or enqueue a notification. */
export function seedLedger(db: Database.Database, count: number) {
  const signal = db.prepare("INSERT INTO signal_ledger VALUES (?,?,?,?)");
  const outcome = db.prepare(
    "INSERT INTO signal_ledger_outcomes VALUES (?,?,?,?)",
  );
  const record = db.prepare("INSERT OR REPLACE INTO records VALUES (?,?,?,?)");
  const run = db.prepare(
    "INSERT OR REPLACE INTO signal_ledger_runs VALUES (?,?)",
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const date = new Date(Date.UTC(2025, 0, 1 + Math.floor(i / 60)))
        .toISOString()
        .slice(0, 10);
      const row: LedgerSignal = {
        id: `fixture:${String(i).padStart(6, "0")}`,
        symbol: `sh${String(600000 + (i % 60))}`,
        observedDate: date,
        endpointDate: date,
        strategy: i % 2 ? "czsc" : "dual-breakout",
        direction: i % 3 ? "long" : "short",
        quality: i % 2 ? "confirmed" : "4",
        score: i % 60,
        evidence: JSON.stringify({ note: "合成证据".repeat(400) }),
        invalidation: "合成失效条件",
        snapshotHash: `hash:${i}`,
        strategyVersion: "fixture-v1",
        dllVersion: i % 2 ? "fixture-dll" : null,
        source: "tdx-local",
      };
      signal.run(row.id, row.symbol, date, JSON.stringify(row));
      for (const horizon of [5, 10, 20] as const) {
        if (i % 5 === 0) continue;
        const settled = i % 5 !== 1;
        const blank = i % 5 === 2;
        const value: Outcome = {
          horizon,
          settled,
          entryDate: date,
          exitDate: date,
          entry: 10,
          exit: 10,
          returnPct: settled && !blank ? (i % 9) - 4 : null,
          action: blank ? "除权状态未知" : "区间无除权",
          reasons: !settled ? ["T+N K线未完成"] : blank ? ["除权状态未知"] : [],
          calendarSource: "fixture",
          actionSource: "fixture",
          actionCoverageEnd: blank ? null : "2026-09-28",
        };
        outcome.run(row.id, horizon, Number(settled), JSON.stringify(value));
      }
      if (i % 5 === 0) {
        const decision: NotificationDecision = {
          id: `fixture:decision:${i}`,
          symbol: row.symbol,
          strategy: row.strategy,
          date,
          endpointDate: date,
          direction: row.direction,
          score: row.score,
          tier: "ledger",
          reasons: ["fixture，不外发"],
          policy: notificationPolicySchema.parse({}),
          createdAt: Date.parse(date),
        };
        record.run(
          decision.id,
          "notification-decision",
          JSON.stringify(decision),
          decision.createdAt,
        );
      }
    }
    for (let i = 0; i < 121; i++) {
      const date = new Date(Date.UTC(2025, 0, i + 1))
        .toISOString()
        .slice(0, 10);
      const value: LedgerRun = {
        date,
        status: i % 3 ? "complete" : "partial",
        total: 60,
        scanned: 60,
        signals: 15,
        elapsedMs: 1000,
        errors: [],
        calendarSource: "fixture",
        actionCoverageEnd: "2025-06-01",
        phase: "结束",
      };
      run.run(date, JSON.stringify(value));
    }
    // Terminal today and an invalid source root keep automatic runtime scans isolated.
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    run.run(
      today,
      JSON.stringify({
        date: today,
        status: "cancelled",
        total: 0,
        scanned: 0,
        signals: 0,
        elapsedMs: 0,
        errors: [],
        calendarSource: "fixture",
        phase: "隔离验证",
      } satisfies LedgerRun),
    );
    record.run(
      "settings",
      "settings",
      JSON.stringify({ tdxRoot: "Z:\\quant-fixture-unavailable" }),
      1,
    );
    record.run(
      "intraday-config",
      "intraday-config",
      JSON.stringify({
        enabled: false,
        source: "tdx-local",
        pool: null,
        rpsPeriod: 50,
        minimumRps: 90,
        czscConfig: 0,
        noon: "11:20",
        late: "14:40",
      }),
      1,
    );
  })();
}
