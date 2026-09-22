import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IndustryRpsStatus } from "../src/components/industry-rps-status";
import { migrate } from "../src/server/db/migrations";
import { RpsStore } from "../src/server/screening/rps-store";
import { runRpsJob } from "../src/server/screening/rps-job";
import { industryRpsPage } from "../src/server/screening/industry-rps-query";
import { industrySnapshot, industryDay } from "./industry-rps-fixture";
import { rpsDate, rpsDay, rpsDeps, rpsProgress } from "./rps-fixture";

const dbs: Database.Database[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
function setup() {
  const db = new Database(":memory:");
  dbs.push(db);
  migrate(db);
  const store = new RpsStore(db, "industry"),
    progress = { ...rpsProgress(), target: "industry" as const };
  store.claim(progress);
  return { db, store, progress };
}
const now = Date.parse(`${rpsDate}T15:05:00+08:00`);
const deps = () => ({
  ...rpsDeps(),
  industries: async () => industrySnapshot(),
});
const request = { target: "industry", mode: "backfill", days: 3 } as const;

it("industry backfill reuses the S1 job and stores independent immutable results and membership evidence", async () => {
  const { db, store, progress } = setup(),
    stockStore = new RpsStore(db),
    stock = rpsDay();
  stockStore.saveDay(stock.day, stock.rows);
  const result = await runRpsJob(store, deps(), request, progress, now);
  expect(result.status).toBe("complete");
  expect(result.completedDays).toBe(3);
  expect(store.latest()!.counts).toEqual([3, 3, 3, 3, 3, 3]);
  expect(store.latest()!.industry!.snapshot).toEqual(industrySnapshot());
  expect(stockStore.day(rpsDate)).toEqual(stock.day);
  const saved = store.curve("甲");
  const next = { ...rpsProgress(), target: "industry" as const };
  store.claim(next);
  expect(
    (
      await runRpsJob(
        store,
        {
          ...deps(),
          industries: async () => industrySnapshot({ 新名单: ["sz000000"] }),
        },
        { ...request, mode: "forward", days: 1 },
        next,
        now,
      )
    ).completedDays,
  ).toBe(0);
  expect(store.curve("甲")).toEqual(saved);
  expect(store.latest()!.mode).toBe("backfill");
  expect(
    db
      .prepare(
        "SELECT count(*) n, min(length(values_blob)) bytes FROM industry_rps_values",
      )
      .get(),
  ).toEqual({ n: 9, bytes: 96 });
});
it("industry cancellation preserves committed days and resumption fills only missing dates", async () => {
  const { store, progress } = setup();
  const result = await runRpsJob(store, deps(), request, progress, now, (p) => {
    if (p.completedDays === 1) store.cancel();
  });
  expect(result.status).toBe("cancelled");
  expect(result.completedDays).toBe(1);
  const next = { ...rpsProgress(), target: "industry" as const };
  store.claim(next);
  expect(
    (await runRpsJob(store, deps(), request, next, now)).completedDays,
  ).toBe(2);
  expect(store.curve("甲")).toHaveLength(3);
});
it("whole empty industry set publishes explicit null audit without a false zero ranking", async () => {
  const { store, progress } = setup();
  expect(
    (
      await runRpsJob(
        store,
        { ...deps(), industries: async () => industrySnapshot({ 空行业: [] }) },
        { ...request, days: 1 },
        progress,
        now,
      )
    ).status,
  ).toBe("complete");
  expect(store.latest()!.counts).toEqual([0, 0, 0, 0, 0, 0]);
  expect(store.ranking(rpsDate, 20)).toEqual([]);
  expect(industryRpsPage(store, { period: 20 }).rows[0]!.reason).toBe(
    "empty-list",
  );
});
it("a missing previously used industry file fails explicitly; changed membership only affects new dates", async () => {
  const { store, progress } = setup(),
    fixture = industryDay();
  store.saveDay({ ...fixture.day, date: "2023-01-01" }, fixture.rows);
  const absent = await runRpsJob(
    store,
    {
      ...deps(),
      industries: async () => industrySnapshot({ 甲: ["sz000001"] }),
    },
    { ...request, days: 1 },
    progress,
    now,
  );
  expect(absent.status).toBe("failed");
  expect(absent.error).toContain("名单文件缺失");
  expect(store.day(rpsDate)).toBeNull();
  const next = { ...rpsProgress(), target: "industry" as const };
  store.claim(next);
  const changed = industrySnapshot({
    甲: ["sz000009"],
    乙: ["sz000008"],
    丙: [],
  });
  expect(
    (
      await runRpsJob(
        store,
        { ...deps(), industries: async () => changed },
        { ...request, mode: "forward", days: 1 },
        next,
        now,
      )
    ).status,
  ).toBe("complete");
  expect(store.latest()!.industry!.snapshot.hash).toBe(changed.hash);
  expect(store.day("2023-01-01")!.industry).toEqual(fixture.day.industry);
  expect(store.curve("甲").map((r) => r.mode)).toEqual(["backfill", "forward"]);
});
it("industry transactions share the global lease and roll back failed publication/cleanup", () => {
  const { db, store } = setup(),
    fixture = industryDay();
  expect(new RpsStore(db).claim(rpsProgress())).toBe(false);
  let checks = 0;
  expect(() =>
    store.saveDay(fixture.day, fixture.rows, () => {
      if (++checks === 2) throw new Error("cancelled");
    }),
  ).toThrow("cancelled");
  expect(store.latest()).toBeNull();
  for (let i = 0; i < 750; i++)
    store.saveDay(
      {
        ...fixture.day,
        date: new Date(Date.UTC(2000, 0, i + 1)).toISOString().slice(0, 10),
      },
      fixture.rows,
    );
  db.exec(
    "CREATE TRIGGER industry_cleanup_failure BEFORE DELETE ON industry_rps_days BEGIN SELECT RAISE(ABORT,'cleanup failed'); END",
  );
  expect(() => store.saveDay(fixture.day, fixture.rows)).toThrow(
    "cleanup failed",
  );
  expect(store.day(rpsDate)).toBeNull();
  db.exec("DROP TRIGGER industry_cleanup_failure");
  store.saveDay(fixture.day, fixture.rows);
  expect(store.day("2000-01-01")).toBeNull();
  expect(db.prepare("SELECT count(*) n FROM industry_rps_days").get()).toEqual({
    n: 750,
  });
  expect(
    db.prepare("SELECT count(*) n FROM industry_rps_values").get(),
  ).toEqual({ n: 2250 });
  expect(new RpsStore(db).latest()).toBeNull();
});
it("server query orders by rank, paginates, exposes file evidence and retains empty industries at the end", async () => {
  const { store, progress } = setup();
  const groups = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [
      `行业${String(i).padStart(2, "0")}`,
      i < 24 ? [`sz00000${i % 10}`] : [],
    ]),
  );
  expect(
    (
      await runRpsJob(
        store,
        { ...deps(), industries: async () => industrySnapshot(groups) },
        { ...request, days: 1 },
        progress,
        now,
      )
    ).status,
  ).toBe("complete");
  const first = industryRpsPage(store, { period: 20, page: 0 }),
    second = industryRpsPage(store, { period: 20, page: 1 });
  expect(first.total).toBe(25);
  expect(first.rows).toHaveLength(20);
  expect(second.rows).toHaveLength(5);
  expect(first.rows[0]!.name).toBe("行业09");
  expect(second.rows.at(-1)).toMatchObject({
    name: "行业24",
    reason: "empty-list",
    value: null,
  });
  expect(first.rows[0]!.file).toMatchObject({
    hash: industrySnapshot(groups).files[9]!.hash,
    mtimeMs: 1000,
  });
  expect(first.rows[0]!.file).not.toHaveProperty("members");
  expect(industryRpsPage(store, { date: "1990-01-01", period: 5 })).toEqual({
    day: null,
    rows: [],
    total: 0,
  });
});
it("UI explicitly warns of incomparable Tongdaxin weighting, drift, six periods, exclusions and separate forward/backfill tags", () => {
  const fixture = industryDay().day;
  const latest = { ...fixture, excluded: fixture.industry!.excluded };
  const html = renderToStaticMarkup(
    createElement(IndustryRpsStatus, { latest }),
  );
  for (const text of [
    "等权平均",
    "通达信",
    "不能直接比较",
    "成分漂移",
    "生存者偏差",
    "回填",
    "向前新增",
    "RPS5",
    "RPS10",
    "RPS20",
    "RPS50",
    "RPS120",
    "RPS250",
    "20/50/120",
    "750",
  ])
    expect(html).toContain(text);
  expect(
    renderToStaticMarkup(
      createElement(IndustryRpsStatus, {
        latest: { ...latest, mode: "forward" },
      }),
    ),
  ).toContain("向前新增（当次成分快照）");
});
