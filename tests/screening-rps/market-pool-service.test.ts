import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "../../src/server/db/migrations";
import { RpsStore } from "../../src/server/db/rps-store";
import { rpsDay } from "../helpers/rps-fixture";
import {
  marketPoolPage,
  marketPoolRows,
} from "../../src/server/market/market-pool-service";

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  root: "fixture",
  coverageRoot: "fixture",
  coverage: "ready" as "ready" | "empty" | "missing",
}));
vi.mock("../../src/server/db/index", () => ({
  sqlite: () => state.db,
  get: () =>
    state.coverage === "missing"
      ? null
      : {
          root: state.coverageRoot,
          securities:
            state.coverage === "empty"
              ? []
              : [
                  { symbol: "sz000009", period: "day" },
                  { symbol: "sh600001", period: "day" },
                ],
        },
}));
vi.mock("../../src/server/infra/settings", () => ({
  settings: () => ({ tdxRoot: state.root, industryBlocksRoot: "blocks" }),
}));
vi.mock("../../src/server/market/securities", () => ({
  securityDirectory: async () => ({
    entries: Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `sz${String(i).padStart(6, "0")}`,
        { name: `样本${i}` },
      ]),
    ),
  }),
}));
vi.mock("../../src/server/market/market-pool-files", () => ({
  readMarketPool: async () => ({
    category: "index",
    name: "中证A500",
    file: "中证A500.txt",
    root: "blocks",
    hash: "hash",
    mtimeMs: 1,
    observedAt: 2,
    members: ["sz000009", "sz000001", "sz000020", "bj920001"],
  }),
}));

beforeEach(() => {
  state.root = state.coverageRoot = "fixture";
  state.coverage = "ready";
  state.db = new Database(":memory:");
  migrate(state.db);
  const { day, rows } = rpsDay();
  new RpsStore(state.db).saveDay(day, rows);
});
afterEach(() => state.db?.close());

it("includes imported securities without pretending their local day files were scanned", async () => {
  state
    .db!.prepare("INSERT INTO records VALUES (?,?,?,?)")
    .run(
      "tdx-full-day-current-sh600519",
      "tdx-full-day-current",
      JSON.stringify({ snapshotId: "imported" }),
      1,
    );
  const result = await marketPoolRows({ search: "sh600519" });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({
    symbol: "sh600519",
    localDay: false,
    fullDayCache: true,
  });
  const unrelatedPool = await marketPoolRows({
    pool: { category: "index", name: "中证A500" },
  });
  expect(unrelatedPool.rows.some((row) => row.symbol === "sh600519")).toBe(
    false,
  );
});

it("paged results concatenate to export ordering without reranking the selected pool", async () => {
  const first = await marketPoolPage({});
  const second = await marketPoolPage({ page: 1 });
  const exported = await marketPoolRows({});
  expect(first.total).toBe(26);
  expect(first.unmatchedLocalCount).toBe(1);
  expect(exported.rows.find((row) => row.symbol === "sh600001")).toMatchObject({
    name: "邯郸钢铁",
    localDay: true,
    identity: { status: "delisted", date: "2009-12-29" },
  });
  expect([...first.rows, ...second.rows]).toEqual(exported.rows);
  expect(first.rps?.count).toBe(10);
  expect(first.period).toBe(50);
  expect(first.availability).toEqual({ rps: "ready", dailyIndex: "ready" });
  const subset = await marketPoolPage({
    pool: { category: "index", name: "中证A500" },
  });
  expect(subset.total).toBe(3);
  expect(subset.excludedMarket).toBe(1);
  expect(subset.rows[0]!.value?.rps).toBe(90);
  expect(subset.rows[0]).toEqual(first.rows[0]);
  expect(subset.rows[2]!.value).toBeNull();
  expect(subset.source).not.toHaveProperty("members", expect.any(Array));
});
it("explicit threshold excludes missing values and filtering agrees with export", async () => {
  const query = { minimumRps: 90 };
  const page = await marketPoolPage(query);
  expect(page.rows.map((r) => r.symbol)).toEqual(["sz000009"]);
  expect(page.rows).toEqual((await marketPoolRows(query)).rows);
});
it("shows new 1/3-day ranks and keeps their unavailable legacy history explicit", async () => {
  for (const period of [1, 3]) {
    const current = await marketPoolPage({ period, minimumRps: 90 });
    expect(current.rps?.count).toBe(10);
    expect(current.rows.map((row) => row.symbol)).toEqual(["sz000009"]);
  }
  const { day, rows } = rpsDay();
  // Replace only this in-memory fixture with an authentic six-column layout.
  state.db!.exec("DELETE FROM rps_values; DELETE FROM rps_days;");
  new RpsStore(state.db!).saveDay(
    {
      ...day,
      periods: [5, 10, 20, 50, 120, 250],
      counts: Array(6).fill(10),
      missing: Array(6).fill(0),
    },
    rows.map((row) => ({
      ...row,
      values: [...row.values.slice(2), row.values.at(-1)!],
    })),
  );
  for (const period of [1, 3]) {
    const legacy = await marketPoolPage({ period });
    expect(legacy.rps?.count).toBeNull();
    expect(legacy.period).toBe(period);
    expect(legacy.availability.rps).toBe("period-missing");
    expect(
      legacy.rows.every(
        (row) =>
          row.value === null &&
          row.reason === "该历史批次未计算此周期，等待新批次",
      ),
    ).toBe(true);
  }
  expect((await marketPoolPage({ period: 50 })).rows[0]!.value?.rps).toBe(90);
});
it("navigates across page boundaries using the same server ordering and stops at pool edges", async () => {
  const all = await marketPoolRows({});
  const page = await marketPoolPage({ selected: all.rows[19]!.symbol });
  expect(page.next).toEqual({ symbol: all.rows[20]!.symbol, page: 1 });
  const next = await marketPoolPage({ selected: page.next!.symbol, page: 1 });
  expect(next.previous).toEqual({ symbol: all.rows[19]!.symbol, page: 0 });
  expect(
    (await marketPoolPage({ selected: all.rows[0]!.symbol })).previous,
  ).toBeNull();
  expect(
    (await marketPoolPage({ selected: all.rows.at(-1)!.symbol })).next,
  ).toBeNull();
  expect((await marketPoolPage({ selected: "sz999999" })).next).toBeNull();
});
it("changing the configured data root does not present old coverage or old RPS as current", async () => {
  state.root = "other-root";
  const page = await marketPoolPage({});
  expect(page.rps).toBeNull();
  expect(page.availability).toEqual({
    rps: "missing",
    dailyIndex: "not-scanned",
  });
  expect(page.rows.every((r) => !r.localDay && r.value === null)).toBe(true);
  expect(page.rows[0]!.reason).toContain("当前数据源");
});

it("keeps batch availability independent of filters, pages and individual missing ranks", async () => {
  const empty = await marketPoolPage({ search: "no-match" });
  const beyond = await marketPoolPage({ page: 100 });
  const unranked = await marketPoolPage({ search: "sz000020" });
  expect(empty.rows).toEqual([]);
  expect(beyond.rows).toEqual([]);
  expect(unranked.rows[0]).toMatchObject({
    value: null,
    reason: "该周期数据不足或未覆盖",
  });
  for (const page of [empty, beyond, unranked])
    expect(page.availability).toEqual({ rps: "ready", dailyIndex: "ready" });
});

it("distinguishes no scan from an empty scan without changing exported reasons", async () => {
  state.db!.exec("DELETE FROM rps_values; DELETE FROM rps_days;");
  for (const [coverage, dailyIndex] of [
    ["missing", "not-scanned"],
    ["empty", "empty"],
    ["ready", "ready"],
  ] as const) {
    state.coverage = coverage;
    const exported = await marketPoolRows({});
    const page = await marketPoolPage({});
    expect(page.availability).toEqual({ rps: "missing", dailyIndex });
    expect(exported.availability).toEqual(page.availability);
    expect(
      exported.rows.every(
        (row) =>
          row.value === null && row.reason === "尚无当前数据源的RPS，请先计算",
      ),
    ).toBe(true);
    expect(page.rows).toEqual(exported.rows.slice(0, 20));
  }
});
