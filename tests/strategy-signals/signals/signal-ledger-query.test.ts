import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrate } from "../../../src/server/db/migrations";
import { seedLedger } from "../../helpers/signal-ledger-fixture";
import {
  ledgerHistory,
  ledgerAnalysis,
  ledgerDetail,
  ledgerRuns,
  ledgerDecisions,
} from "../../../src/server/monitoring/signal-ledger-query";
import {
  ledgerHistorySchema,
  ledgerDateSchema,
} from "../../../src/lib/strategy-facts/signal-ledger-query";
import { SignalLedgerStore } from "../../../src/server/monitoring/signal-ledger-store";
import { aggregateLedger } from "../../../src/lib/strategy-facts/signal-ledger";
import { signalInformation } from "../../../src/lib/strategy-facts/signal-information";
import { ledgerUnit } from "../../../src/server/infra/notification-policy-store";
import { notificationPolicySchema } from "../../../src/lib/strategy-facts/notification-policy";

it("pages the full population, keeps state counts independent of the page, and excludes raw evidence", () => {
  const db = new Database(":memory:");
  migrate(db);
  seedLedger(db, 121);
  try {
    const first = ledgerHistory(db, {});
    expect(first).toMatchObject({
      total: 121,
      totalAll: 121,
      pending: 49,
      valid: 48,
      blank: 24,
      pendingSignals: 49,
      horizon: 5,
    });
    expect(first.rows).toHaveLength(20);
    const ids = first.rows.map((row) => row.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = ledgerHistory(db, { cursor });
      expect(page.total).toBe(121);
      ids.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor;
    }
    expect(ids).toHaveLength(121);
    expect(new Set(ids).size).toBe(121);
    expect(JSON.stringify(first)).not.toContain("evidence");
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(65536);
    for (const state of ["pending", "valid", "blank"] as const) {
      const page = ledgerHistory(db, { state });
      expect(page.total).toBe(first[state]);
      expect(page[state]).toBe(page.total);
    }
    expect(
      ledgerHistory(db, { symbol: "sh600004", state: "valid" }).rows.some(
        (row) => row.outcomes.some((out) => out.returnPct === 0),
      ),
    ).toBe(true);
    expect(ledgerHistory(db, { symbol: "sz000001" })).toMatchObject({
      total: 0,
      totalAll: 121,
      rows: [],
    });
    expect(() =>
      ledgerHistory(db, { state: "blank", cursor: first.nextCursor! }),
    ).toThrow("筛选条件");
    expect(ledgerHistorySchema.safeParse({ from: "2025-02-30" }).success).toBe(
      false,
    );
    expect(
      ledgerHistorySchema.safeParse({ from: "2025-02-01", to: "2025-01-01" })
        .success,
    ).toBe(false);
    const detail = ledgerDetail(db, ids[0]!);
    expect(detail.signal.evidence).toContain("合成证据");
    expect(detail.schemaVersion).toBe(1);
    expect(() => ledgerDetail(db, "missing")).toThrow("不存在");
    const sample = first.rows[0]!;
    // Same sort prefix but a newer ID after the first page boundary never repeats an existing page member.
    const old = new SignalLedgerStore(db).rows()[0]!;
    db.prepare("INSERT INTO signal_ledger VALUES(?,?,?,?)").run(
      "!new",
      sample.symbol,
      sample.observedDate,
      JSON.stringify({ ...old, id: "!new" }),
    );
    const second = ledgerHistory(db, { cursor: first.nextCursor! });
    expect(
      second.rows.every((row) => !first.rows.some((old) => old.id === row.id)),
    ).toBe(true);
  } finally {
    db.close();
  }
});

it("keeps full-population analytics equivalent and fresh after backfill without evidence projection", () => {
  const db = new Database(":memory:");
  migrate(db);
  seedLedger(db, 121);
  try {
    const store = new SignalLedgerStore(db);
    const expected = signalInformation(store.rows());
    const result = ledgerAnalysis(db);
    expect(result.groups).toEqual(aggregateLedger(store.rows()));
    expect(result.information.decay).toEqual(expected.decay);
    for (const group of expected.groups) {
      const actual = result.information.groups.find(
        (row) =>
          row.strategy === group.strategy &&
          row.direction === group.direction &&
          row.horizon === group.horizon,
      )!;
      const { daily, ...summary } = group;
      expect(actual).toMatchObject(summary);
      expect(actual).not.toHaveProperty("daily");
      expect(daily.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(result)).not.toContain("合成证据");
    ledgerHistory(db, { state: "valid", symbol: "sh600004" });
    expect(ledgerAnalysis(db)).toMatchObject({
      sampleCount: 121,
      groups: result.groups,
    });
    const out = store
      .rows()
      .find((row) => row.outcomes[0] && !row.outcomes[0].settled)!;
    store.outcome(out.id, {
      ...out.outcomes[0]!,
      settled: true,
      returnPct: 5,
      reasons: [],
    });
    expect(ledgerAnalysis(db).groups).not.toEqual(result.groups);
    expect(ledgerAnalysis(db).groups).toEqual(aggregateLedger(store.rows()));
  } finally {
    db.close();
  }
});

it("reaches all task and notification history and returns accurate idempotent cancel outcomes", () => {
  const db = new Database(":memory:");
  migrate(db);
  seedLedger(db, 605);
  try {
    const runs = ledgerRuns(db, {}),
      dates = runs.rows.map((row) => row.date);
    let cursor = runs.nextCursor;
    while (cursor) {
      const page = ledgerRuns(db, { cursor });
      dates.push(...page.rows.map((row) => row.date));
      cursor = page.nextCursor;
    }
    expect(dates).toHaveLength(122);
    expect(new Set(dates).size).toBe(122);
    expect(ledgerRuns(db, { status: "partial" }).total).toBe(41);
    const decisions = ledgerDecisions(db, {}),
      ids = decisions.rows.map((row) => row.id);
    let decisionCursor = decisions.nextCursor;
    while (decisionCursor) {
      const page = ledgerDecisions(db, { cursor: decisionCursor });
      ids.push(...page.rows.map((row) => row.id));
      decisionCursor = page.nextCursor;
    }
    expect(ids).toHaveLength(121);
    expect(new Set(ids).size).toBe(121);
    expect(ledgerDecisions(db, { tier: "immediate" }).rows).toEqual([]);
    expect(() =>
      ledgerDecisions(db, {
        symbol: "sh600000",
        cursor: decisions.nextCursor!,
      }),
    ).toThrow("筛选条件");
    const store = new SignalLedgerStore(db),
      date = dates.at(-1)!;
    expect(store.cancel("2020-01-01").outcome).toBe("not-found");
    expect(store.cancel(date).outcome).toBe("finished");
    store.saveRun({ ...store.run(date)!, status: "running" });
    expect(store.cancel(date)).toMatchObject({
      outcome: "requested",
      run: { status: "running", cancelRequested: true },
    });
    expect(store.cancel(date).outcome).toBe("already-requested");
    store.saveRun({ ...store.run(date)!, status: "complete" });
    expect(store.cancel(date).outcome).toBe("finished");
    expect(ledgerDateSchema.safeParse("2025-02-30").success).toBe(false);
  } finally {
    db.close();
  }
});

it("joins only the original local signal point and never treats a decision as a delivery", () => {
  const db = new Database(":memory:");
  migrate(db);
  seedLedger(db, 2);
  try {
    const store = new SignalLedgerStore(db);
    const signal = store.rows().find((row) => row.strategy === "czsc")!;
    signal.evidence = JSON.stringify({ config: 0, point: { kind: 1 } });
    db.prepare("UPDATE signal_ledger SET payload=? WHERE id=?").run(
      JSON.stringify(signal),
      signal.id,
    );
    const insert = db.prepare("INSERT INTO records VALUES(?,?,?,?)");
    for (const [id, pointKey, source] of [
      ["match", ledgerUnit(signal).pointKey, "tdx-local"],
      ["wrong-point", "different", "tdx-local"],
      ["wrong-source", ledgerUnit(signal).pointKey, "eastmoney"],
    ] as const) {
      insert.run(`source:${id}`, "signal", JSON.stringify({ source }), 1);
      insert.run(
        id,
        "notification-decision",
        JSON.stringify({
          ...ledgerUnit(signal),
          id,
          pointKey,
          signalId: `source:${id}`,
          tier: "summary",
          reasons: ["合成匹配"],
          policy: notificationPolicySchema.parse({}),
          createdAt: 1,
        }),
        1,
      );
    }
    const detail = ledgerDetail(db, signal.id);
    expect(detail.notifications.map((row) => row.id)).toEqual(["match"]);
    expect(detail.notifications[0]).not.toHaveProperty("deliveryId");
    expect(detail.notifications).toEqual(
      store.rows().find((row) => row.id === signal.id)!.notifications,
    );
    expect(
      db
        .prepare("SELECT count(*) AS n FROM records WHERE kind='delivery'")
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
