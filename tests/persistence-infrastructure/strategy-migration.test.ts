import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { migrate } from "~/server/db/migrations";
import { sqlite } from "~/server/db";
import { StrategyRepository } from "~/server/db/strategy-repository";
import { watchStrategy } from "~/server/strategies/drivers/watch";
import type { StrategyObjectInput } from "trading-strategies";
import { migrate as migrateOldApplication } from "../fixtures/r1c-v14-migrations";
import { persistWatch } from "~/server/strategies/drivers/persist-watch";

const parent = resolve(process.env.QUANT_DATA_DIR!, "strategy-migrations");
mkdirSync(parent, { recursive: true });
process.env.QUANT_DATA_DIR = parent;
const dbFor = (name: string) =>
  new Database(join(parent, `${name}-${process.pid}-${Date.now()}.sqlite`));
function oldDatabase(name: string) {
  const db = dbFor(name);
  migrateOldApplication(db);
  db.prepare("INSERT INTO records VALUES(?,?,?,?)").run(
    "original",
    "snapshot",
    '{"immutable":"原始记录"}',
    17,
  );
  return db;
}
it("empty disk database upgrades to 19 and repeat migration is idempotent", () => {
  const db = dbFor("empty");
  try {
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(19);
    const schema = db
      .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
      .all();
    migrate(db);
    expect(
      db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    ).toEqual(schema);
    for (const table of ["strategies", "trade_plans", "watch_events"])
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({
        n: 0,
      });
  } finally {
    db.close();
  }
});
it("frozen R1b schema with old records upgrades without changing existing data", () => {
  const db = oldDatabase("old");
  try {
    const before = db.prepare("SELECT * FROM records").all();
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(19);
    expect(db.prepare("SELECT * FROM records").all()).toEqual(before);
  } finally {
    db.close();
  }
});
it("failure part way through migration rolls back schema, data and version", () => {
  const db = oldDatabase("rollback");
  try {
    db.exec(
      "CREATE TABLE watch_events (sentinel TEXT); INSERT INTO watch_events VALUES('keep')",
    );
    const before = db
      .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
      .all();
    const records = db.prepare("SELECT * FROM records").all();
    expect(() => migrate(db)).toThrow("already exists");
    expect(db.pragma("user_version", { simple: true })).toBe(14);
    expect(
      db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    ).toEqual(before);
    expect(db.prepare("SELECT * FROM records").all()).toEqual(records);
    expect(db.prepare("SELECT * FROM watch_events").all()).toEqual([
      { sentinel: "keep" },
    ]);
  } finally {
    db.close();
  }
});
it("current application refuses a newer database without changing it", () => {
  const db = oldDatabase("newer");
  try {
    db.pragma("user_version=20");
    expect(() => migrate(db)).toThrow("数据库版本高于此应用版本");
    expect(db.pragma("user_version", { simple: true })).toBe(20);
  } finally {
    db.close();
  }
});
it("application initialization rejects a newer database on every retry and releases its handle", () => {
  const directory = join(parent, `entry-${process.pid}-${Date.now()}`);
  mkdirSync(directory);
  const db = new Database(join(directory, "quant.sqlite"));
  db.pragma("user_version=20");
  db.close();
  const previous = process.env.QUANT_DATA_DIR;
  process.env.QUANT_DATA_DIR = directory;
  try {
    expect(() => sqlite()).toThrow("数据库版本高于此应用版本");
    expect(() => sqlite()).toThrow("数据库版本高于此应用版本");
    const verify = new Database(join(directory, "quant.sqlite"));
    expect(verify.pragma("user_version", { simple: true })).toBe(20);
    verify.close();
  } finally {
    process.env.QUANT_DATA_DIR = previous;
  }
});
it("the frozen R1b application's actual migration entry refuses the upgraded version-19 database", () => {
  const db = oldDatabase("old-app");
  try {
    migrate(db);
    const schema = db
      .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
      .all();
    expect(() => migrateOldApplication(db)).toThrow("数据库版本高于此应用版本");
    expect(db.pragma("user_version", { simple: true })).toBe(19);
    expect(
      db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    ).toEqual(schema);
  } finally {
    db.close();
  }
});
it("versioned strategies, deduped events and linked plans commit atomically", () => {
  const db = dbFor("repository");
  try {
    migrate(db);
    const repository = new StrategyRepository(db);
    const strategy: StrategyObjectInput = {
      id: "gold",
      version: 1,
      market: "crypto",
      period: "day",
      universe: { kind: "symbols", symbols: ["BTCUSDT"] },
      entry: { kind: "constant", value: true },
      exit: {},
      sizing: { kind: "weight", weight: 1 },
      sleeve: "swing",
    };
    const bars = [
      {
        date: "2026-10-12",
        open: 10,
        high: 10,
        low: 10,
        close: 10,
        volume: 1,
        amount: 10,
      },
    ];
    const event = watchStrategy(
      strategy,
      { market: "crypto", symbol: "BTCUSDT", bars },
      bars[0]!.date,
    )[0]!;
    const plan = {
      id: "plan",
      strategyId: strategy.id,
      strategyVersion: 1,
      symbol: "BTCUSDT",
      sleeve: "swing",
      triggerKey: event.key,
      entry: 10,
      stop: null,
      target: null,
      quantity: 1,
      tranches: 2,
      expiresAt: null,
      status: "open" as const,
    };
    expect(repository.record(strategy, event, plan)).toBe(true);
    expect(repository.record(strategy, event, { ...plan, quantity: 2 })).toBe(
      false,
    );
    expect(repository.plan("plan")).toEqual(plan);
    expect(repository.events(1)).toEqual({ items: [event], next: null });
    expect(() =>
      repository.saveStrategy({
        ...strategy,
        sizing: { kind: "weight", weight: 0.5 },
      }),
    ).toThrow("immutable");
    expect(repository.saveStrategy({ ...strategy, version: 2 }).version).toBe(
      2,
    );
    expect(repository.strategy("gold", 1)).toMatchObject({ version: 1 });
    expect(() =>
      repository.record(
        { ...strategy, id: "rollback" },
        { ...event, key: "bad" },
      ),
    ).toThrow("identity");
    expect(repository.strategy("rollback", 1)).toBeNull();
    expect(() => repository.events(0)).toThrow("page size");
    const next = { ...bars[0]!, date: "2026-10-13" };
    const series = {
      market: "crypto" as const,
      symbol: "BTCUSDT",
      bars: [...bars, next],
    };
    expect(
      persistWatch(
        strategy,
        series,
        next.date,
        {
          capital: {
            equity: 100,
            cash: 100,
            riskPerTrade: 0.01,
            step: 0.01,
            minimum: 0.01,
          },
        },
        repository,
      ),
    ).toHaveLength(1);
    expect(persistWatch(strategy, series, next.date, {}, repository)).toEqual(
      [],
    );
    const page = repository.events(1);
    expect(page.next).not.toBeNull();
    expect(repository.events(1, page.next!).items[0]).toMatchObject({
      bar: next.date,
    });
    expect(db.prepare("SELECT count(*) AS n FROM trade_plans").get()).toEqual({
      n: 2,
    });
  } finally {
    db.close();
  }
});
