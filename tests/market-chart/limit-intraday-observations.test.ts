import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sqlite } from "../../src/server/db";
import type { LimitObservation } from "../../src/server/market/limit-sentiment-observations";
import {
  insertLimitObservation,
  readLimitObservations,
} from "../../src/server/db/limit-sentiment-observations";
import { splitIntradaySegments } from "../../src/components/market/limit-intraday-series";

const mocks = vi.hoisted(() => {
  const row = (symbol: string) => ({
    symbol,
    name: symbol,
    price: 1,
    changePct: 10,
    amount: null,
    floatCap: null,
    turnover: null,
    industry: "",
    streak: 1,
    firstSeal: null,
    lastSeal: null,
    sealFund: null,
    breaks: null,
    limitPrice: null,
    stat: null,
  });
  return {
    row,
    fetchLimitPool: vi.fn(),
    pools: {} as Record<string, ReturnType<typeof row>[]>,
  };
});

vi.mock("../../src/server/data-sources/eastmoney/em-limit-pool", () => ({
  fetchLimitPool: mocks.fetchLimitPool,
}));

/** 北京时间 → epoch 毫秒；UTC 偏移由 Date.UTC 自动跨日。 */
function atBeijing(date: string, hour: number, minute: number, second = 0) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!, hour - 8, minute, second);
}

let nowSpy: ReturnType<typeof vi.spyOn>;
const setNow = (epoch: number) => nowSpy.mockReturnValue(epoch);

beforeEach(() => {
  nowSpy = vi.spyOn(Date, "now");
  mocks.pools = {
    zt: [mocks.row("a"), mocks.row("b")],
    zb: [mocks.row("c")],
    dt: [mocks.row("d")],
    yzt: [mocks.row("e")],
  };
  mocks.fetchLimitPool.mockReset();
  mocks.fetchLimitPool.mockImplementation(
    async (kind: string) => mocks.pools[kind] ?? null,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("同一分钟重复写入只保留第一条", () => {
  setNow(atBeijing("2026-11-18", 10, 0, 10));
  const point: LimitObservation = {
    date: "2026-11-18",
    minute: "10:00",
    at: Date.now(),
    limitUp: 0,
    broken: 0,
    limitDown: 0,
  };
  expect(insertLimitObservation(point)).toBe(true);
  expect(insertLimitObservation(point)).toBe(false);
  expect(readLimitObservations("2026-11-18")).toEqual([point]);
});

it("请求日期与完成本地日期不同不写", async () => {
  setNow(atBeijing("2026-11-19", 0, 30, 10));
  const { limitSentiment } =
    await import("../../src/server/market/limit-sentiment");
  const result = await limitSentiment("2026-11-17");
  expect(result.available).toBe(true);
  expect(result.intraday.points).toEqual([]);
  expect(readLimitObservations("2026-11-17")).toEqual([]);
});

it("四池未全部返回时不写", async () => {
  setNow(atBeijing("2026-11-16", 10, 0, 10));
  mocks.fetchLimitPool.mockImplementation(async (kind: string) =>
    kind === "zt" ? null : (mocks.pools[kind] ?? null),
  );
  const { limitSentiment } =
    await import("../../src/server/market/limit-sentiment");
  const result = await limitSentiment("2026-11-16");
  expect(result.available).toBe(false);
  expect(result.intraday.points).toEqual([]);
  expect(readLimitObservations("2026-11-16")).toEqual([]);
});

it("缓存命中不追加新分钟", async () => {
  setNow(atBeijing("2026-11-20", 10, 0, 10));
  const { limitSentiment } =
    await import("../../src/server/market/limit-sentiment");
  const first = await limitSentiment("2026-11-20");
  expect(first.intraday.points.map((point) => point.minute)).toEqual(["10:00"]);
  // 55 秒后、已跨到下一分钟，但仍在 60 秒实时缓存内。
  setNow(atBeijing("2026-11-20", 10, 1, 5));
  const second = await limitSentiment("2026-11-20");
  expect(second.intraday.points.map((point) => point.minute)).toEqual([
    "10:00",
  ]);
  expect(mocks.fetchLimitPool).toHaveBeenCalledTimes(4);
});

it("同日读取包含刚写入的真实观测，允许真实 0", async () => {
  setNow(atBeijing("2026-11-24", 10, 0, 10));
  mocks.pools.dt = [];
  const { limitSentiment } =
    await import("../../src/server/market/limit-sentiment");
  const first = await limitSentiment("2026-11-24");
  expect(first.intraday.points).toEqual([
    {
      date: "2026-11-24",
      minute: "10:00",
      at: Date.now(),
      limitUp: 2,
      broken: 1,
      limitDown: 0,
    },
  ]);
  // 70 秒后实时缓存已过期，重新取四池并追加下一分钟。
  setNow(atBeijing("2026-11-24", 10, 1, 20));
  const second = await limitSentiment("2026-11-24");
  expect(second.intraday.points.map((point) => point.minute)).toEqual([
    "10:00",
    "10:01",
  ]);
  expect(second.intraday.points[1]).toMatchObject({
    limitUp: 2,
    broken: 1,
    limitDown: 0,
  });
});

it.each([
  ["午休", "2026-11-25", 12, 0],
  ["盘后", "2026-11-26", 15, 5],
] as const)("%s 不写", async (_label, date, hour, minute) => {
  setNow(atBeijing(date, hour, minute, 10));
  const { limitSentiment } =
    await import("../../src/server/market/limit-sentiment");
  const result = await limitSentiment(date);
  expect(result.available).toBe(true);
  expect(result.intraday.points).toEqual([]);
  expect(readLimitObservations(date)).toEqual([]);
});

it("读取拒绝 at/分钟不符、无效时段与非整型家数的坏行", () => {
  setNow(atBeijing("2026-11-27", 10, 0, 10));
  const base: LimitObservation = {
    date: "2026-11-27",
    minute: "10:00",
    at: atBeijing("2026-11-27", 10, 0, 10),
    limitUp: 1,
    broken: 0,
    limitDown: 0,
  };
  insertLimitObservation(base);
  insertLimitObservation({ ...base, minute: "10:01" });
  insertLimitObservation({
    ...base,
    minute: "12:00",
    at: atBeijing("2026-11-27", 12, 0, 10),
  });
  insertLimitObservation({
    ...base,
    minute: "10:02",
    at: atBeijing("2026-11-27", 10, 2, 10),
    limitUp: 1.5,
  });
  expect(readLimitObservations("2026-11-27")).toEqual([base]);
});

it("持久化 id 与 payload 的日期/分钟一致", () => {
  setNow(atBeijing("2026-11-30", 10, 0, 10));
  const point: LimitObservation = {
    date: "2026-11-30",
    minute: "10:00",
    at: atBeijing("2026-11-30", 10, 0, 10),
    limitUp: 1,
    broken: 0,
    limitDown: 0,
  };
  insertLimitObservation(point);
  const row = sqlite()
    .prepare("SELECT id,payload FROM records WHERE id=?")
    .get("limit-sentiment-observation:2026-11-30:10:00") as
    { id: string; payload: string } | undefined;
  expect(row).toBeDefined();
  const payload = JSON.parse(row!.payload) as LimitObservation;
  expect(row!.id).toBe(
    `limit-sentiment-observation:${payload.date}:${payload.minute}`,
  );
  expect(readLimitObservations("2026-11-30")).toEqual([point]);
});

it("历史定稿分支即使本地时钟跳回请求日也不写", async () => {
  nowSpy.mockReturnValueOnce(atBeijing("2026-12-02", 10, 0, 10));
  nowSpy.mockReturnValue(atBeijing("2026-12-01", 10, 0, 10));
  const { limitSentiment } =
    await import("../../src/server/market/limit-sentiment");
  const result = await limitSentiment("2026-12-01");
  expect(result.final).toBe(true);
  expect(result.available).toBe(true);
  expect(readLimitObservations("2026-12-01")).toEqual([]);
});

it("读取计划只走 records 主键日期区间，不建临时排序", () => {
  const memory = new Database(":memory:");
  try {
    memory.exec(
      "CREATE TABLE records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);" +
        "CREATE INDEX records_kind ON records(kind,updated_at);",
    );
    const plan = memory
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id,kind,payload FROM records WHERE id>=? AND id<? ORDER BY id LIMIT ?",
      )
      .all(
        "limit-sentiment-observation:2026-11-27:",
        "limit-sentiment-observation:2026-11-27;",
        242,
      ) as { detail: string }[];
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("id>? AND id<?");
    expect(details).not.toContain("records_kind");
    expect(details).not.toContain("TEMP B-TREE");
  } finally {
    memory.close();
  }
});

it("图表在上午/下午与显著间隔处断线，空态为空", () => {
  const point = (
    minute: string,
    hour: number,
    min: number,
  ): LimitObservation => ({
    date: "2026-11-18",
    minute,
    at: atBeijing("2026-11-18", hour, min),
    limitUp: 1,
    broken: 0,
    limitDown: 0,
  });
  expect(splitIntradaySegments([])).toEqual([]);
  const segments = splitIntradaySegments([
    point("09:30", 9, 30),
    point("09:31", 9, 31),
    point("09:40", 9, 40),
    point("11:29", 11, 29),
    point("11:30", 11, 30),
    point("13:00", 13, 0),
    point("13:01", 13, 1),
    point("14:00", 14, 0),
  ]);
  expect(
    segments.map((segment) => [
      segment.session,
      segment.points.map((item) => item.minute),
    ]),
  ).toEqual([
    ["morning", ["09:30", "09:31"]],
    ["morning", ["09:40"]],
    ["morning", ["11:29", "11:30"]],
    ["afternoon", ["13:00", "13:01"]],
    ["afternoon", ["14:00"]],
  ]);
});
