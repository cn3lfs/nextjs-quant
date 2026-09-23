import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { migrate } from "../../../src/server/db/migrations";
import { RpsStore } from "../../../src/server/screening/rps-store";
import { rpsPolicy } from "../../../src/lib/screening/rps";
import { rpsDay, rpsProgress } from "../../rps-fixture";

const connections: Database.Database[] = [];
function database() {
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  return db;
}
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
});
it("new migration preserves existing records; packed queries match the six-period calculation exactly", () => {
  const db = database(),
    store = new RpsStore(db),
    { day, rows } = rpsDay();
  db.prepare("INSERT INTO records VALUES('old','snapshot','{}',1)").run();
  migrate(db);
  store.saveDay(day, rows);
  expect(db.prepare("SELECT * FROM records").all()).toEqual([
    { id: "old", kind: "snapshot", payload: "{}", updated_at: 1 },
  ]);
  expect(
    db
      .prepare(
        "SELECT count(*) n, min(length(values_blob)) bytes FROM rps_values",
      )
      .get(),
  ).toEqual({ n: 10, bytes: 96 });
  for (const [i, p] of day.periods.entries())
    expect(store.ranking(day.date, p)).toEqual(
      [...rows].reverse().map((r) => ({ symbol: r.symbol, ...r.values[i]! })),
    );
  expect(store.curve("sz000009")[0]!.values).toEqual(rows[9]!.values);
  expect(store.curve("sz999999")).toEqual([]);
  expect(store.ranking("1990-01-01", 5)).toEqual([]);
  expect(store.day(day.date)).toEqual(day);
});
it("existing dates and backfill provenance are immutable, future insert does not change curve prefix", () => {
  const store = new RpsStore(database()),
    { day, rows } = rpsDay();
  expect(store.saveDay(day, rows)).toBe(true);
  const before = store.curve(rows[0]!.symbol);
  expect(store.saveDay({ ...day, mode: "forward" }, [])).toBe(false);
  store.saveDay({ ...day, date: "2030-01-01", mode: "forward" }, rows);
  expect(store.curve(rows[0]!.symbol).slice(0, 1)).toEqual(before);
  expect(store.curve(rows[0]!.symbol).map((v) => v.mode)).toEqual([
    "backfill",
    "forward",
  ]);
});
it("failed or cancelled transaction publishes neither partial date nor rows", () => {
  const db = database(),
    store = new RpsStore(db),
    { day, rows } = rpsDay();
  let checks = 0;
  expect(() =>
    store.saveDay(day, rows, () => {
      if (++checks === 2) throw new Error("cancelled");
    }),
  ).toThrow("cancelled");
  expect(store.day(day.date)).toBeNull();
  expect(db.prepare("SELECT count(*) n FROM rps_values").get()).toEqual({
    n: 0,
  });
});
it("curve includes null vectors for excluded dates instead of joining across gaps", () => {
  const store = new RpsStore(database()),
    { day, rows } = rpsDay();
  store.saveDay(day, rows);
  store.saveDay({ ...day, date: "2030-01-01" }, []);
  expect(store.curve("sz000009")[1]!.values).toEqual([
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
  expect(store.curve("sz000009")[1]!.policy).toEqual(day.policy);
});
it("750-day retention deletes dependent vectors; cleanup failure rolls back new publication", () => {
  const db = database(),
    store = new RpsStore(db),
    { day, rows } = rpsDay();
  for (let i = 0; i < rpsPolicy.retentionDays; i++)
    store.saveDay(
      {
        ...day,
        date: new Date(Date.UTC(2000, 0, i + 1)).toISOString().slice(0, 10),
      },
      [rows[0]!],
    );
  db.exec(
    "CREATE TRIGGER rps_delete_failure BEFORE DELETE ON rps_days BEGIN SELECT RAISE(ABORT,'cleanup failed'); END",
  );
  expect(() =>
    store.saveDay({ ...day, date: "2030-01-01" }, [rows[0]!]),
  ).toThrow("cleanup failed");
  expect(store.day("2030-01-01")).toBeNull();
  db.exec("DROP TRIGGER rps_delete_failure");
  store.saveDay({ ...day, date: "2030-01-01" }, [rows[0]!]);
  expect(store.day("2000-01-01")).toBeNull();
  expect(db.prepare("SELECT count(*) n FROM rps_values").get()).toEqual({
    n: 750,
  });
  expect(db.prepare("SELECT count(*) n FROM rps_days").get()).toEqual({
    n: 750,
  });
});
it("one durable job lease excludes competitors, preserves cancel, recovers crashes and fences old writers", () => {
  const db = database(),
    store = new RpsStore(db),
    first = rpsProgress(),
    second = rpsProgress();
  expect(store.claim(first)).toBe(true);
  expect(store.claim(second)).toBe(false);
  store.cancel();
  expect(() => store.checkpoint(first)).toThrow("rps-cancelled");
  db.prepare("UPDATE rps_job SET lease_until=1").run();
  expect(store.progress()!.status).toBe("failed");
  expect(store.claim(second)).toBe(true);
  expect(() => store.checkpoint(first)).toThrow("租约");
  store.finish({ ...first, status: "complete" });
  expect(store.progress()!.id).toBe(second.id);
  expect(db.prepare("SELECT count(*) n FROM rps_job").get()).toEqual({ n: 1 });
});
