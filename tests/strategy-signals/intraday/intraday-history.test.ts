import Database from "better-sqlite3";
import {
  migrate,
  intradaySummaryIndexes,
} from "../../../src/server/db/migrations";
import { expect, it } from "vitest";
import {
  intradayHistory,
  intradayRuns,
} from "../../../src/server/monitoring/intraday-history";

it("counts all matching observations, distinguishes no signal and retry, and pages without evidence", () => {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT,payload TEXT,updated_at INTEGER)",
  );
  db.exec(intradaySummaryIndexes);
  const insert = db.prepare("INSERT INTO records VALUES(?,?,?,?)");
  try {
    insert.run("run", "intraday-run", JSON.stringify({ slot: "noon" }), 1);
    for (let i = 0; i < 41; i++) {
      insert.run(
        `p-${String(i).padStart(2, "0")}`,
        "intraday-preview",
        JSON.stringify({
          sessionId: "run",
          barCutoff: "2026-09-28T11:20:00+08:00",
          rps: 95,
          rpsDate: "2026-09-25",
          snapshot: {
            symbol: "sh600000",
            source: "tdx-local",
            bars: ["must not travel"],
          },
          signals: i % 2 === 0 ? [{ key: "buy" }] : [],
        }),
        100,
      );
      if (i < 10)
        insert.run(
          `c-${i}`,
          "intraday-close",
          JSON.stringify({
            observationId: `p-${String(i).padStart(2, "0")}`,
            close: { signalKeys: i < 5 ? null : ["buy"] },
          }),
          200,
        );
    }
    const first = intradayHistory(db, {});
    expect(first.total).toBe(41);
    expect(first.stats).toEqual({
      candidates: 21,
      pending: 31,
      retry: 5,
      settled: 5,
    });
    expect(first.rows).toHaveLength(20);
    // Negative control: old current-page count cannot satisfy the total pending contract.
    expect(first.rows.filter((row) => row.state === "pending").length).not.toBe(
      first.stats.pending,
    );
    expect(JSON.stringify(first)).not.toContain("must not travel");
    const second = intradayHistory(db, { cursor: first.nextCursor! });
    const third = intradayHistory(db, { cursor: second.nextCursor! });
    expect(second.stats).toEqual(first.stats);
    expect(third.rows).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
    insert.run(
      "new-observation",
      "intraday-preview",
      JSON.stringify({
        sessionId: "run",
        barCutoff: "2026-09-28T11:20:00+08:00",
        rps: 95,
        rpsDate: "2026-09-25",
        snapshot: { symbol: "sh600000", source: "tdx-local" },
        signals: [],
      }),
      101,
    );
    expect(intradayHistory(db, { cursor: first.nextCursor! }).rows).toEqual(
      second.rows,
    );
    db.prepare("DELETE FROM records WHERE id='new-observation'").run();
    expect(
      new Set(
        [...first.rows, ...second.rows, ...third.rows].map((row) => row.id),
      ).size,
    ).toBe(41);
    expect(intradayHistory(db, { signalsOnly: true }).total).toBe(21);
    expect(intradayHistory(db, { state: "retry" }).total).toBe(5);
    expect(intradayHistory(db, { slot: "late" }).total).toBe(0);
    expect(intradayHistory(db, { from: "2026-09-29" }).total).toBe(0);
    expect(() =>
      intradayHistory(db, { state: "retry", cursor: first.nextCursor! }),
    ).toThrow("分页条件");
    expect(() => intradayHistory(db, { from: "2026-02-30" })).toThrow("日期");
    insert.run(
      "settled-later",
      "intraday-close",
      JSON.stringify({ observationId: "p-00", close: { signalKeys: [] } }),
      300,
    );
    expect(intradayHistory(db, {}).stats).toEqual({
      candidates: 21,
      pending: 31,
      retry: 4,
      settled: 6,
    });
  } finally {
    db.close();
  }
});

it("reaches batches beyond the old 100 limit and keeps updates from changing pagination order", () => {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT,payload TEXT,updated_at INTEGER)",
  );
  try {
    const insert = db.prepare("INSERT INTO records VALUES(?,?,?,?)");
    for (let i = 0; i < 121; i++)
      insert.run(
        `r-${String(i).padStart(3, "0")}`,
        "intraday-run",
        JSON.stringify({
          date: "2026-09-28",
          slot: "noon",
          status: "complete",
          startedAt: 100,
          results: [{ symbol: "sh600000" }],
          pool: { rows: [{ symbol: "sh600000" }] },
        }),
        i,
      );
    let page = intradayRuns(db, {});
    const ids = page.rows.map((row) => row.id);
    expect(page.total).toBe(121);
    expect(JSON.stringify(page)).not.toContain("sh600000");
    db.prepare("UPDATE records SET updated_at=99999 WHERE id='r-000'").run();
    while (page.nextCursor) {
      page = intradayRuns(db, { cursor: page.nextCursor });
      ids.push(...page.rows.map((row) => row.id));
    }
    expect(ids).toHaveLength(121);
    expect(new Set(ids).size).toBe(121);
    expect(ids.at(-1)).toBe("r-000");
    expect(intradayRuns(db, { status: "running" }).total).toBe(0);
  } finally {
    db.close();
  }
});

it("adds metadata indexes without rewriting evidence and rejects a newer schema", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const version = db.pragma("user_version", { simple: true }) as number;
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'intraday_%'",
        )
        .all(),
    ).toHaveLength(2);
    db.prepare("INSERT INTO records VALUES(?,?,?,?)").run(
      "observation",
      "intraday-preview",
      JSON.stringify({
        sessionId: "run",
        snapshot: { symbol: "sh600000", bars: [{ close: 1 }] },
        signals: [],
      }),
      1,
    );
    const before = db
      .prepare("SELECT payload FROM records WHERE id='observation'")
      .get();
    migrate(db);
    expect(
      db.prepare("SELECT payload FROM records WHERE id='observation'").get(),
    ).toEqual(before);
    db.pragma(`user_version=${version + 1}`);
    expect(() => migrate(db)).toThrow("数据库版本高于");
  } finally {
    db.close();
  }
});
