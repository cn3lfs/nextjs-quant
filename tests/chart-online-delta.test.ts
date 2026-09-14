import { afterEach, expect, it, vi } from "vitest";
import type { Bar, Snapshot } from "../src/lib/domain";
import { put } from "../src/server/db";
import { saveSettings, settings } from "../src/server/settings";
import { chartBars } from "../src/server/chart-bars";
import { mergeOnlineDailyTail } from "../src/server/chart-online-delta";
import * as chartHistory from "../src/server/chart-history";
import * as mcp from "../src/server/mcp";
afterEach(() => vi.restoreAllMocks());

/** 交易日（周一至周五）倒推，避免周末混进本地或日历。 */
function weekdaysEndingAt(end: string, count: number) {
  const days: string[] = [];
  let stamp = Date.parse(`${end}T00:00:00Z`);
  while (days.length < count) {
    const weekday = new Date(stamp).getUTCDay();
    if (weekday !== 0 && weekday !== 6)
      days.unshift(new Date(stamp).toISOString().slice(0, 10));
    stamp -= 86400000;
  }
  return days;
}
/** 本地 lday 口径：成交量股、成交额元。 */
const localVolume = 1000;
const bar = (date: string, close: number, shares = localVolume): Bar => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume: shares,
  amount: close * shares,
});
/** 供应商口径：成交量按手取整（股数的 1/100），成交额仍是全天的元。 */
function providerBar(local: Bar): Bar {
  return { ...local, volume: Math.round(local.volume / 100) };
}
function providerDay(date: string, close: number, shares: number): Bar {
  return { ...bar(date, close, shares), volume: Math.round(shares / 100) };
}
function localSnapshot(symbol: string, bars: Bar[]): Snapshot {
  return {
    id: `local-${symbol}`,
    hash: `local-hash-${symbol}`,
    symbol,
    period: "day",
    source: "tdx-local",
    adjustment: "none",
    createdAt: 1,
    bars,
  };
}
const note = { source: "东方财富在线", requests: 1 } as const;

it("appends only bars newer than the local tail after checking the overlap", () => {
  const days = weekdaysEndingAt("2026-09-11", 5);
  const source = localSnapshot("sh600001", [
    ...days.slice(0, 4).map((day, index) => bar(day, 10 + index)),
    // 末根故意不是整手：本地 1050 股，供应商按手取整报 11 手，允许 ±半手。
    bar(days[4]!, 14, 1050),
  ]);
  const tail = [
    providerBar(source.bars[3]!),
    providerBar(source.bars[4]!),
    providerDay("2026-09-14", 9.5, 1200),
  ];
  expect(tail[1]!.volume).toBe(11);
  const { snapshot, added } = mergeOnlineDailyTail(source, tail, note);
  expect(added).toBe(1);
  expect(snapshot.bars.slice(0, source.bars.length)).toEqual(source.bars);
  expect(snapshot.bars.at(-1)).toEqual(bar("2026-09-14", 9.5, 1200));
  expect(source.bars).toHaveLength(5);
  expect(snapshot.hash).not.toBe(source.hash);
  expect(snapshot.sourceNote).toContain("成交量倍率 100");
  expect(snapshot.sourceNote).toContain("1 次请求");
});

it("reports no new period when the verified overlap has nothing newer", () => {
  const days = weekdaysEndingAt("2026-09-11", 3);
  const source = localSnapshot(
    "sh600002",
    days.map((day, index) => bar(day, 10 + index)),
  );
  const { snapshot, added } = mergeOnlineDailyTail(
    source,
    source.bars.slice(-2).map(providerBar),
    note,
  );
  expect(added).toBe(0);
  expect(snapshot).toBe(source);
});

it("refuses a tail that diverges from the local series instead of mixing conventions", () => {
  const days = weekdaysEndingAt("2026-09-11", 4);
  const source = localSnapshot(
    "sh600003",
    days.map((day, index) => bar(day, 10 + index)),
  );
  const tail = source.bars.slice(-2).map(providerBar);
  expect(() =>
    mergeOnlineDailyTail(source, [{ ...tail[0]!, close: 99 }, tail[1]!], note),
  ).toThrow("价格不一致");
  // 两根重叠日的量级无法用同一个整数倍解释
  expect(() =>
    mergeOnlineDailyTail(
      source,
      [tail[0]!, { ...tail[1]!, volume: tail[1]!.volume * 100000 }],
      note,
    ),
  ).toThrow("成交量口径不一致");
  expect(() =>
    mergeOnlineDailyTail(
      source,
      [tail[0]!, { ...tail[1]!, amount: tail[1]!.amount * 1.01 }],
      note,
    ),
  ).toThrow("成交额不一致");
  expect(() =>
    mergeOnlineDailyTail(source, [tail[0]!, { ...tail[1]!, volume: 30 }], note),
  ).toThrow("口径不一致");
});

it("requires a real overlap and ordered unique bars", () => {
  const days = weekdaysEndingAt("2026-09-11", 3);
  const source = localSnapshot(
    "sh600004",
    days.map((day, index) => bar(day, 10 + index)),
  );
  expect(() =>
    mergeOnlineDailyTail(
      source,
      [bar("2026-09-14", 9), bar("2026-09-15", 9)],
      note,
    ),
  ).toThrow("无法确认两侧连续");
  const repeated = providerBar(source.bars[2]!);
  expect(() =>
    mergeOnlineDailyTail(source, [repeated, { ...repeated }], note),
  ).toThrow("倒序或重复");
});

const session = Date.parse("2026-09-14T14:00:00+08:00");
const today = "2026-09-14";
const localDays = weekdaysEndingAt("2026-09-11", 130);
const localBars = localDays.map((day, index) => bar(day, 10 + (index % 5)));
/** 最近两根与本地一致（按手）；给出日期时再附上当日的当日线。 */
function tail(newest?: string, close = 9.5, shares = 1200) {
  return [
    providerBar(localBars.at(-2)!),
    providerBar(localBars.at(-1)!),
    ...(newest ? [providerDay(newest, close, shares)] : []),
  ];
}
function putLocal(symbol: string) {
  const source = localSnapshot(symbol, localBars);
  put("snapshot", source.id, source);
  return source;
}
function sessionClock() {
  vi.spyOn(mcp, "mcpConfigured").mockResolvedValue(true);
  return vi.spyOn(Date, "now").mockReturnValue(session);
}

it("uses one small online request for the daily chart instead of reloading history", async () => {
  const source = putLocal("sh600005");
  const latest = vi
    .spyOn(chartHistory, "mcpLatestBars")
    .mockResolvedValue(tail(today));
  const history = vi.spyOn(chartHistory, "mcpChartHistory");
  const now = sessionClock();
  try {
    const chart = await chartBars({
      snapshotId: source.id,
      period: "day",
      limit: 100,
    });
    expect(latest).toHaveBeenCalledTimes(1);
    expect(latest.mock.calls[0]?.[2]).toBe(20);
    expect(history).not.toHaveBeenCalled();
    expect(chart.bars.at(-1)).toEqual(bar(today, 9.5, 1200));
    expect(chart.formingDates).toEqual([today]);
    expect(chart.source).toBe("tdx-local");
    expect(chart.sourceNote).toContain("当日增量");
    expect(chart.bars.map((item) => item.date)).toEqual([
      ...new Set(chart.bars.map((item) => item.date)),
    ]);
  } finally {
    now.mockRestore();
  }
});

it("keeps the local series when the online tail has no newer period", async () => {
  const source = putLocal("sh600006");
  const latest = vi
    .spyOn(chartHistory, "mcpLatestBars")
    .mockResolvedValue(tail());
  const history = vi.spyOn(chartHistory, "mcpChartHistory");
  const now = sessionClock();
  try {
    const chart = await chartBars({
      snapshotId: source.id,
      period: "day",
      limit: 100,
    });
    expect(latest).toHaveBeenCalledTimes(1);
    expect(history).not.toHaveBeenCalled();
    // 返回按 limit 截断，末根仍是本地最后一根。
    expect(chart.bars).toEqual(localBars.slice(-100));
    expect(chart.sourceNote).toBeUndefined();
  } finally {
    now.mockRestore();
  }
});

it("builds the weekly chart from local days plus the same one-off delta", async () => {
  const source = putLocal("sh600007");
  saveSettings({ ...settings(), calendar: [...localDays, today] });
  const latest = vi
    .spyOn(chartHistory, "mcpLatestBars")
    .mockResolvedValue(tail(today));
  const history = vi.spyOn(chartHistory, "mcpChartHistory");
  const now = sessionClock();
  try {
    const chart = await chartBars({
      snapshotId: source.id,
      period: "week",
      limit: 100,
    });
    expect(latest).toHaveBeenCalledTimes(1);
    expect(history).not.toHaveBeenCalled();
    expect(chart.excluded).toEqual([]);
    expect(chart.bars.at(-1)!.date).toBe(today);
    expect(chart.formingDates).toEqual([today]);
  } finally {
    now.mockRestore();
  }
});

it("still reloads online history when the local series is too short", async () => {
  const short = localBars.slice(-10);
  const source = localSnapshot("sh600008", short);
  put("snapshot", source.id, source);
  const latest = vi.spyOn(chartHistory, "mcpLatestBars");
  const history = vi.spyOn(chartHistory, "mcpChartHistory").mockResolvedValue({
    bars: short,
    historyExhausted: true,
    source: "tdx-mcp",
    volumeUnit: "源单位",
  });
  const now = sessionClock();
  try {
    const chart = await chartBars({
      snapshotId: source.id,
      period: "day",
      limit: 100,
    });
    expect(history).toHaveBeenCalledTimes(1);
    expect(latest).not.toHaveBeenCalled();
    expect(chart.bars).toEqual(short);
  } finally {
    now.mockRestore();
  }
});
