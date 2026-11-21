import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrate } from "~/server/db/migrations";
import { migrate as v15 } from "../fixtures/r2b-v15-migrations";
import { AlertRepository } from "~/server/db/alert-repository";
import { StrategyRepository } from "~/server/db/strategy-repository";
import type { StrategyObjectInput } from "trading-strategies";
const strategy: StrategyObjectInput = {
  id: "migration",
  version: 1,
  market: "crypto",
  period: "day",
  universe: { kind: "symbols", symbols: ["BTCUSDT"] },
  entry: { kind: "constant", value: false },
  exit: {},
  sizing: { kind: "weight", weight: 1 },
  sleeve: "swing",
};
function old() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  v15(db);
  db.prepare("INSERT INTO records VALUES('sentinel','fixture','{}',17)").run();
  new StrategyRepository(db).saveStrategy(strategy);
  return db;
}
it("v15 data and foreign keys survive v16; repeat is idempotent; actual v15 app refuses upgrade", () => {
  const db = old();
  try {
    const repo = new StrategyRepository(db);
    const event = {
      key: JSON.stringify([strategy.id, 1, "crypto", "BTCUSDT", "2026-11-13"]),
      strategyId: strategy.id,
      version: 1,
      market: "crypto" as const,
      symbol: "BTCUSDT",
      bar: "2026-11-13",
      type: "entry" as const,
      price: 10,
      sleeve: "swing",
      stop: null,
      target: null,
    };
    repo.record(strategy, event);
    const before = db.prepare("SELECT * FROM watch_events").all();
    const records = db.prepare("SELECT * FROM records").all();
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(23);
    expect(db.prepare("SELECT * FROM watch_events").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM records").all()).toEqual(records);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const schema = db
      .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
      .all();
    migrate(db);
    expect(
      db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    ).toEqual(schema);
    expect(() => v15(db)).toThrow("数据库版本高于此应用版本");
  } finally {
    db.close();
  }
});
it("v16 migration failure rolls back schema, data and user_version", () => {
  const db = old();
  try {
    db.exec(
      "CREATE TABLE watch_events_v16 (sentinel TEXT); INSERT INTO watch_events_v16 VALUES ('keep')",
    );
    const schema = db
      .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
      .all();
    expect(() => migrate(db)).toThrow("already exists");
    expect(db.pragma("user_version", { simple: true })).toBe(15);
    expect(
      db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    ).toEqual(schema);
    expect(db.prepare("SELECT * FROM watch_events_v16").all()).toEqual([
      { sentinel: "keep" },
    ]);
  } finally {
    db.close();
  }
});
it("null-priced regime events work; unsupported event types and dangling plans are rejected", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  migrate(db);
  const repo = new AlertRepository(db);
  try {
    expect(() =>
      db
        .prepare(
          "INSERT INTO watch_events VALUES('x','missing',1,'BTCUSDT','2026-11-13','stop',10,'shadow',NULL,'{}')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO watch_events VALUES('x','missing',1,'BTCUSDT','2026-11-13','bogus',NULL,'shadow',NULL,'{}')",
        )
        .run(),
    ).toThrow();
    expect(repo.plans()).toEqual([]);
  } finally {
    db.close();
  }
});
