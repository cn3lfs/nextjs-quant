import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { migrate } from "../src/server/db/migrations";
import { RpsStore } from "../src/server/rps-store";
import { runRpsJob } from "../src/server/rps-job";
import {
  industrySnapshotSchema,
  aggregateIndustryRps,
} from "../src/lib/industry-rps";
import { industrySnapshot, industryDay } from "./industry-rps-fixture";
import { rpsDay, rpsDate, rpsDeps, rpsProgress } from "./rps-fixture";
import { industryRpsPage } from "../src/server/industry-rps-query";

const dbs: Database.Database[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
function setup() {
  const db = new Database(":memory:");
  dbs.push(db);
  migrate(db);
  const store = new RpsStore(db, "concept");
  const progress = { ...rpsProgress(), target: "concept" as const };
  store.claim(progress);
  return { db, store, progress };
}
const snapshot = () => ({
  ...industrySnapshot(),
  category: "concept" as const,
});
const now = Date.parse(`${rpsDate}T15:05:00+08:00`);
const request = { target: "concept", mode: "backfill", days: 1 } as const;
it("stores independent concept rankings with unchanged stock and industry snapshots, and refuses cross-category writes", async () => {
  const { db, store, progress } = setup();
  const stock = rpsDay(),
    industry = industryDay();
  const stockStore = new RpsStore(db),
    industryStore = new RpsStore(db, "industry");
  stockStore.saveDay(stock.day, stock.rows);
  industryStore.saveDay(industry.day, industry.rows);
  const result = await runRpsJob(
    store,
    { ...rpsDeps(), industries: async () => snapshot() },
    request,
    progress,
    now,
  );
  expect(result.status).toBe("complete");
  expect(store.latest()?.industry?.snapshot.category).toBe("concept");
  expect(store.latest()?.counts).toEqual([3, 3, 3, 3, 3, 3]);
  expect(stockStore.day(stock.day.date)).toEqual(stock.day);
  expect(industryStore.day(industry.day.date)).toEqual(industry.day);
  expect(
    industryRpsPage(store, { period: 50 }).rows.map((r) => r.name),
  ).toEqual(["乙", "丙", "甲"]);
  expect(() => industryStore.saveDay(store.latest()!, [])).toThrow("不匹配");
  expect(() => store.saveDay(industry.day, [])).toThrow("不匹配");
  const previous = store.curve("甲");
  expect(store.saveDay(store.latest()!, [])).toBe(false);
  expect(store.curve("甲")).toEqual(previous);
});
it("supports more than 256 concepts while retaining the existing industry limit and tie semantics", () => {
  const groups = Object.fromEntries(
    Array.from({ length: 452 }, (_, i) => [`概念${i}`, ["sz000001"]]),
  );
  const data = { ...industrySnapshot(groups), category: "concept" as const };
  expect(industrySnapshotSchema.safeParse(data).success).toBe(true);
  expect(
    industrySnapshotSchema.safeParse(industrySnapshot(groups)).success,
  ).toBe(false);
  const stock = rpsDay();
  const result = aggregateIndustryRps(data, {
    rows: stock.rows,
    excluded: stock.day.excluded,
  });
  expect(result.rows).toHaveLength(452);
  expect(result.rows[0]!.values[0]!.rank).toBe(226.5);
  expect(result.counts).toEqual([452, 452, 452, 452, 452, 452]);
});
it("rejects industry snapshots in concept tasks and publishes nothing on cancellation", async () => {
  const { store, progress } = setup();
  const failed = await runRpsJob(
    store,
    { ...rpsDeps(), industries: async () => industrySnapshot() },
    request,
    progress,
    now,
  );
  expect(failed.status).toBe("failed");
  expect(failed.error).toContain("分类");
  expect(store.latest()).toBeNull();
  const next = { ...rpsProgress(), target: "concept" as const };
  store.claim(next);
  const cancelled = await runRpsJob(
    store,
    { ...rpsDeps(), industries: async () => snapshot() },
    request,
    next,
    now,
    () => {},
    () => true,
  );
  expect(cancelled.status).toBe("cancelled");
  expect(store.latest()).toBeNull();
});
