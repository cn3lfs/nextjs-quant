import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "../../src/server/db/migrations";
import { RpsStore } from "../../src/server/db/rps-store";
import { rpsDate, rpsDay } from "../helpers/rps-fixture";
import {
  marketPoolPage,
  marketPoolRows,
} from "../../src/server/market/market-pool-service";

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  root: "fixture",
  coverageRoot: "fixture",
  coverage: "ready" as "ready" | "empty" | "missing",
  observation: null as null | Record<string, unknown>,
}));
vi.mock("../../src/server/db/rps-observations", () => ({
  latestRpsObservation: () => state.observation,
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
  state.observation = null;
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
  expect(subset.rows[0]!.value).toMatchObject({ symbol: "sz000009", rps: 90 });
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
it("reads one stored batch per page and sorts the pool by full-market period values", async () => {
  const { day, rows } = rpsDay();
  const index20 = day.periods.indexOf(20);
  const leader = rows.find((row) => row.symbol === "sz000009")!;
  // Move only the 20-day leader to a symbol without any other ranked period.
  const partial = day.periods.map((period) =>
    period === 20 ? leader.values[index20]! : null,
  );
  leader.values[index20] = null;
  new RpsStore(state.db!).saveDay({ ...day, date: "2099-01-01" }, [
    ...rows,
    { symbol: "sz000020", values: partial },
  ]);
  const pool = { category: "index", name: "中证A500" };
  const read = vi.spyOn(RpsStore.prototype, "rows");
  try {
    const descending = await marketPoolPage({
      pool,
      order: { id: "rps:20", desc: true },
    });
    expect(read.mock.calls).toEqual([["2099-01-01"]]);
    expect(descending.rows.map((row) => row.symbol)).toEqual([
      "sz000020",
      "sz000001",
      "sz000009",
    ]);
    expect(descending.rows[0]!.value).toBeNull();
    expect(descending.rows[0]!.rpsValues).toEqual({
      "1": null,
      "3": null,
      "5": null,
      "10": null,
      "20": { rank: 1, rps: 90, return: partial[index20]!.return },
      "50": null,
      "120": null,
    });
    expect(descending.rows[2]!.rpsValues).toEqual(
      Object.fromEntries(
        day.periods.map((period, index) => [period, leader.values[index]]),
      ),
    );
    const ascending = await marketPoolPage({
      pool,
      order: { id: "rps:5", desc: false },
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(ascending.rows.map((row) => row.symbol)).toEqual([
      "sz000001",
      "sz000009",
      "sz000020",
    ]);
    expect(ascending.rows[0]!.rpsValues?.["5"]?.rank).toBe(9);
  } finally {
    read.mockRestore();
  }
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
    expect(Object.keys(legacy.rows[0]!.rpsValues!)).toEqual([
      "5",
      "10",
      "20",
      "50",
      "120",
      "250",
    ]);
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

it("applies multi-period conditions from one batch before paging and keeps per-period bases", async () => {
  state.db!.exec("DELETE FROM rps_values; DELETE FROM rps_days;");
  const { day } = rpsDay();
  // Stored rank is what survives; RPS is recomputed from the batch counts.
  const value = (rank: number, rps: number) => ({ return: 0, rank, rps });
  const custom = {
    ...day,
    periods: [20, 50],
    counts: [100, 100],
    missing: [0, 2],
    total: 5,
    pool: 5,
  };
  new RpsStore(state.db!).saveDay(custom, [
    { symbol: "sz000001", values: [value(5, 95), value(10, 90)] },
    // Missing RPS50 must not be treated as zero or pass another period.
    { symbol: "sz000002", values: [value(5, 95), null] },
    { symbol: "sz000003", values: [value(15, 85), value(10, 90)] },
    { symbol: "sz000004", values: [value(100, 0), value(0, 100)] },
    // Exactly on both thresholds.
    { symbol: "sz000005", values: [value(10, 90), value(20, 80)] },
  ]);
  const conditions = [
    { period: 20, side: "gte" as const, value: 90 },
    { period: 50, side: "gte" as const, value: 80 },
  ];
  const page = await marketPoolPage({ conditions });
  expect(page.rows.map((row) => row.symbol)).toEqual(["sz000001", "sz000005"]);
  expect(page.total).toBe(2);
  expect(page.rows[0]!.value).toEqual(value(10, 90));
  expect(page.rows[0]!.conditionValues).toEqual({
    "20": value(5, 95),
    "50": value(10, 90),
  });
  expect(page.rps?.count).toBe(100);
  expect(page.rps?.conditions).toEqual([
    { ...conditions[0], count: 100, periodMissing: false },
    { ...conditions[1], count: 100, periodMissing: false },
  ]);
  const exported = await marketPoolRows({ conditions });
  expect(page.rows).toEqual(exported.rows);
  expect((await marketPoolPage({ conditions, page: 1 })).rows).toEqual([]);
  // A selected security outside the filtered set has no neighbours.
  expect(
    await marketPoolPage({ conditions, selected: "sz000004" }),
  ).toMatchObject({ previous: null, next: null });
  expect(
    await marketPoolPage({ conditions, selected: "sz000001" }),
  ).toMatchObject({
    previous: null,
    next: { symbol: "sz000005", page: 0 },
  });
});

it("filters before paging so a later-page security enters page 1 and a real zero stays normal", async () => {
  state.db!.exec("DELETE FROM rps_values; DELETE FROM rps_days;");
  const { day } = rpsDay();
  const value = (rank: number, rps: number) => ({ return: 0, rank, rps });
  const symbols = Array.from(
    { length: 21 },
    (_, index) => `sz${String(index).padStart(6, "0")}`,
  );
  new RpsStore(state.db!).saveDay(
    {
      ...day,
      periods: [20, 50],
      counts: [100, 100],
      total: 21,
      pool: 21,
    },
    symbols.map((symbol, index) =>
      index === 20
        ? // Ranks last on the display period, but is the only condition match.
          { symbol, values: [value(1, 99), value(21, 79)] }
        : { symbol, values: [value(100, 0), value(index + 1, 99 - index)] },
    ),
  );
  const unfiltered = await marketPoolPage({});
  expect(unfiltered.rows.map((row) => row.symbol)).not.toContain("sz000020");
  const sorted = await marketPoolPage({ order: { id: "rps:20", desc: true } });
  expect(sorted.rows[0]!.symbol).toBe("sz000020");
  expect(
    (await marketPoolPage({ page: 1 })).rows.map((row) => row.symbol),
  ).toContain("sz000020");
  const conditions = [{ period: 20, side: "gte" as const, value: 50 }];
  const filtered = await marketPoolPage({ conditions });
  expect(filtered.total).toBe(1);
  expect(filtered.rows.map((row) => row.symbol)).toEqual(["sz000020"]);
  expect(filtered.rows[0]!.conditionValues?.["20"]?.rps).toBe(99);
  expect(filtered.rps?.conditions).toEqual([
    { ...conditions[0], count: 100, periodMissing: false },
  ]);
  // Periods exist and every value is real: this is a genuine zero-hit result.
  const zero = await marketPoolPage({
    conditions: [{ period: 20, side: "gte", value: 100 }],
  });
  expect(zero.total).toBe(0);
  expect(zero.rows).toEqual([]);
  expect(zero.rps?.conditions).toEqual([
    { period: 20, side: "gte", value: 100, count: 100, periodMissing: false },
  ]);
});

it("does not fill a missing condition value even at threshold zero, and reports a missing period", async () => {
  state.db!.exec("DELETE FROM rps_values; DELETE FROM rps_days;");
  const { day } = rpsDay();
  const value = (rank: number, rps: number) => ({ return: 0, rank, rps });
  new RpsStore(state.db!).saveDay(
    { ...day, periods: [20, 50], counts: [10, 10], total: 3, pool: 3 },
    [
      // A real RPS 0 (rank 10 of 10) passes ≥ 0; a null never does.
      { symbol: "sz000001", values: [value(10, 0), value(1, 90)] },
      { symbol: "sz000002", values: [value(1, 90), null] },
      { symbol: "sz000003", values: [null, value(1, 90)] },
    ],
  );
  const zero = await marketPoolPage({
    conditions: [{ period: 20, side: "gte", value: 0 }],
  });
  expect(zero.rows.map((row) => row.symbol)).toEqual(["sz000001", "sz000002"]);
  const missing = await marketPoolPage({
    period: 20,
    conditions: [{ period: 1, side: "gte", value: 0 }],
  });
  expect(missing.availability.rps).toBe("ready");
  expect(missing.rps?.conditions).toEqual([
    { period: 1, side: "gte", value: 0, count: null, periodMissing: true },
  ]);
  expect(missing.rows).toEqual([]);
});

it("uses the newer observation alone for every condition and never falls back to the stored day", async () => {
  state.observation = {
    id: "observation",
    phase: "noon",
    date: "2099-01-01",
    createdAt: Date.now(),
    baseline: rpsDate,
    root: "fixture",
    fresh: 1,
    total: 5,
    coverage: 0.5,
    reused: ["sz000009"],
    missing: ["sz000008"],
    day: {
      ...rpsDay().day,
      date: "2099-01-01",
      mode: "forward",
      periods: [20, 50],
      counts: [10, 8],
      total: 5,
      pool: 5,
    },
    rows: [
      {
        symbol: "sz000001",
        values: [
          { return: 0, rank: 9, rps: 10 },
          { return: 0, rank: 1, rps: 87.5 },
        ],
      },
    ],
    groups: {},
  };
  const page = await marketPoolPage({
    conditions: [{ period: 20, side: "gte", value: 0 }],
  });
  // The stored day has sz000009, but a newer observation is the only batch.
  expect(page.rows.map((row) => row.symbol)).toEqual(["sz000001"]);
  expect(page.rows[0]!.rpsValues).toEqual({
    "20": { return: 0, rank: 9, rps: 10 },
    "50": { return: 0, rank: 1, rps: 87.5 },
  });
  const missing = await marketPoolPage({ search: "sz000009" });
  expect(missing.rows[0]!.rpsValues).toEqual({ "20": null, "50": null });
  expect(page.rows[0]!.conditionValues).toEqual({
    "20": { return: 0, rank: 9, rps: 10 },
  });
  expect(page.rps).toMatchObject({
    date: "2099-01-01",
    mode: "forward",
    count: 8,
    observation: { phase: "noon", coverage: 0.5, reused: 1, missing: 1 },
    conditions: [{ period: 20, count: 10, periodMissing: false }],
  });
});

it("marks close as persistent only when the same day exists in the RPS store", async () => {
  const { day } = rpsDay();
  const base = {
    id: "close-observation",
    phase: "close" as const,
    createdAt: 2,
    baseline: rpsDate,
    root: "fixture",
    fresh: 1,
    total: 1,
    coverage: 0.5,
    reused: [] as string[],
    missing: [] as string[],
    day: {
      ...day,
      periods: [20, 50],
      counts: [100, 100],
      total: 1,
      pool: 1,
    },
    rows: [
      {
        symbol: "sz000001",
        values: [
          { return: 0, rank: 1, rps: 99 },
          { return: 0, rank: 1, rps: 99 },
        ],
      },
    ],
    groups: {},
  };
  state.observation = {
    ...base,
    date: day.date,
    day: { ...base.day, date: day.date },
  };
  expect((await marketPoolPage({})).rps?.observation).toMatchObject({
    phase: "close",
    persistedClose: true,
  });
  state.observation = {
    ...base,
    date: "2099-01-01",
    day: { ...base.day, date: "2099-01-01" },
  };
  expect((await marketPoolPage({})).rps?.observation).toMatchObject({
    phase: "close",
    persistedClose: false,
  });
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
