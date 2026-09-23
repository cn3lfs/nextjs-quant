import { describe, expect, it } from "vitest";
import {
  activeBuyRatio,
  orderBook,
  orderImbalance,
  quotePriceStats,
  quoteRefreshInterval,
  quoteSession,
  type QuoteSnapshot,
} from "../../../src/lib/market/tdx-quote-view";

const empty = { price: 0, volume: 0 };
const quote: QuoteSnapshot = {
  symbol: "sh600519",
  quoteTime: "10:31:02.500",
  price: 12.34,
  preClose: 12,
  open: 12.1,
  high: 12.5,
  low: 11.9,
  volume: 1234567,
  amount: 15000000,
  innerVolume: 400000,
  outerVolume: 600000,
  riseSpeed: 0.15,
  bids: [
    { price: 12.33, volume: 100 },
    { price: 12.32, volume: 200 },
    { price: 12.31, volume: 300 },
    { price: 12.3, volume: 400 },
    empty,
  ],
  asks: [
    { price: 12.35, volume: 500 },
    { price: 12.36, volume: 600 },
    empty,
    empty,
    empty,
  ],
};

describe("价格统计", () => {
  it("涨跌、涨跌幅与振幅按昨收计算", () => {
    const stats = quotePriceStats(quote);
    // 12.34 - 12 = 0.34；0.34 / 12 = 0.0283333…；(12.5 - 11.9) / 12 = 0.05
    expect(stats.change.value).toBeCloseTo(0.34, 10);
    expect(stats.changePercent.value).toBeCloseTo(0.34 / 12, 12);
    expect(stats.amplitude.value).toBeCloseTo(0.05, 12);
  });
  it("昨收非正时留空并给出原因，不用最新价代替", () => {
    const stats = quotePriceStats({ ...quote, preClose: 0 });
    expect(stats.change).toEqual({
      value: null,
      reason: "昨收价或最新价不可得",
    });
    expect(stats.changePercent.value).toBeNull();
    expect(stats.amplitude).toEqual({
      value: null,
      reason: "昨收价或最高最低价不可得",
    });
  });
  it("最高低于最低时振幅留空", () => {
    expect(
      quotePriceStats({ ...quote, high: 11, low: 12 }).amplitude.value,
    ).toBeNull();
  });
});

describe("五档排列", () => {
  it("按卖五到卖一、买一到买五输出，空档价量留空且深度为 0", () => {
    const rows = orderBook(quote);
    expect(rows).toHaveLength(10);
    expect(rows.map((row) => `${row.side}${row.level}`)).toEqual([
      "ask5",
      "ask4",
      "ask3",
      "ask2",
      "ask1",
      "bid1",
      "bid2",
      "bid3",
      "bid4",
      "bid5",
    ]);
    expect(rows[0]).toEqual({
      side: "ask",
      level: 5,
      price: null,
      volume: null,
      depth: 0,
    });
    // 五档最大挂单量 600（卖二），深度按它归一：卖一 500/600、买一 100/600
    expect(rows[3]).toEqual({
      side: "ask",
      level: 2,
      price: 12.36,
      volume: 600,
      depth: 1,
    });
    expect(rows[4]!.depth).toBeCloseTo(500 / 600, 12);
    expect(rows[5]).toMatchObject({ price: 12.33, volume: 100 });
    expect(rows[5]!.depth).toBeCloseTo(100 / 600, 12);
    expect(rows[9]).toMatchObject({ price: null, volume: null, depth: 0 });
  });
  it("指数返回空档时不产生任何行", () => {
    expect(orderBook({ ...quote, bids: [], asks: [] })).toEqual([]);
  });
});

describe("委比与内外盘", () => {
  it("只汇总有效挂单档位", () => {
    const imbalance = orderImbalance(quote);
    // 买 100+200+300+400 = 1000，卖 500+600 = 1100
    expect(imbalance.bidVolume).toBe(1000);
    expect(imbalance.askVolume).toBe(1100);
    expect(imbalance.difference.value).toBe(-100);
    expect(imbalance.ratio.value).toBeCloseTo(-100 / 2100, 12);
  });
  it("五档全空时委比与委差留空，不记 0", () => {
    const imbalance = orderImbalance({ ...quote, bids: [], asks: [] });
    expect(imbalance.ratio).toEqual({ value: null, reason: "五档无挂单" });
    expect(imbalance.difference.value).toBeNull();
  });
  it("外盘占比为外盘除内外盘合计", () => {
    // 600000 / (400000 + 600000) = 0.6
    expect(activeBuyRatio(quote).value).toBeCloseTo(0.6, 12);
    expect(
      activeBuyRatio({ ...quote, innerVolume: 0, outerVolume: 0 }),
    ).toEqual({ value: null, reason: "内外盘量不可得" });
  });
});

describe("交易时段", () => {
  // 2026-09-15 是星期二，2026-09-19 是星期六。
  const beijing = (hour: number, minute: number, day = 15) =>
    Date.UTC(2026, 8, day, hour - 8, minute);
  it("按北京时间钟点划分", () => {
    expect(quoteSession(beijing(9, 14))).toBe("pre");
    expect(quoteSession(beijing(9, 15))).toBe("auction");
    expect(quoteSession(beijing(9, 30))).toBe("continuous");
    expect(quoteSession(beijing(11, 29))).toBe("continuous");
    expect(quoteSession(beijing(11, 30))).toBe("break");
    expect(quoteSession(beijing(13, 0))).toBe("continuous");
    expect(quoteSession(beijing(14, 57))).toBe("auction");
    expect(quoteSession(beijing(15, 0))).toBe("post");
    expect(quoteSession(beijing(10, 0, 19))).toBe("weekend");
  });
  it("时间无效直接报错，不静默当成收盘", () => {
    expect(() => quoteSession(Number.NaN)).toThrow("快照时间无效");
  });
  it("刷新节奏只在竞价与连续竞价加密，收盘与周末不轮询", () => {
    expect(quoteRefreshInterval("continuous")).toBe(3000);
    expect(quoteRefreshInterval("auction")).toBe(3000);
    expect(quoteRefreshInterval("break")).toBe(30000);
    expect(quoteRefreshInterval("pre")).toBe(30000);
    expect(quoteRefreshInterval("post")).toBeNull();
    expect(quoteRefreshInterval("weekend")).toBeNull();
  });
});
