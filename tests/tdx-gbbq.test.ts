import { describe, expect, it } from "vitest";
import type { Bar } from "~/lib/domain";
import fixture from "./fixtures/tdx-gbbq.json";
import {
  adjustmentFactors,
  applyAdjustment,
  parseGbbq,
} from "../src/server/tdx-gbbq";

/**
 * 夹具是本机 gbbq 文件的前 24 条加密记录，期望值由一份独立实现的 Blowfish
 * 解密另行算出，用来锁定解密与字段布局。记录内容是公开的除权除息事实。
 */
const blob = Buffer.from(fixture.gbbqBase64, "base64");

describe("gbbq 解析", () => {
  it("解密结果与独立实现逐字段一致", () => {
    expect(Object.fromEntries(parseGbbq(blob))).toEqual(fixture.events);
  });
  it("分红按每股口径、股本按股给出", () => {
    const events = parseGbbq(blob).get("sz000001")!,
      dividend = events.find((event) => event.category === 1)!,
      shares = events.find((event) => event.totalSharesAfter !== undefined)!;
    expect(dividend.rightsPrice).toBeCloseTo(3.56, 6);
    expect(shares.totalSharesAfter).toBeGreaterThan(10_000_000);
  });
  it("事件按日期升序排列", () => {
    for (const events of parseGbbq(blob).values())
      expect(events.map((event) => event.date)).toEqual(
        [...events.map((event) => event.date)].sort(),
      );
  });
  it("记录数与文件长度不符时报错", () => {
    expect(() => parseGbbq(blob.subarray(0, blob.length - 10))).toThrow(
      "不完整",
    );
    expect(() => parseGbbq(Buffer.alloc(2))).toThrow("过短");
  });
  it("损坏的记录被跳过而不是中断整份文件", () => {
    const corrupted = Buffer.from(blob);
    corrupted.fill(0xff, 4, 4 + 29); // 首条记录解密后代码与类别都不合法
    const events = parseGbbq(corrupted);
    expect([...events.values()].flat()).toHaveLength(
      Object.values(fixture.events).flat().length - 1,
    );
  });
});

const bar = (date: string, close: number): Bar => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1000,
  amount: close * 1000,
});

describe("复权因子", () => {
  it("无除权事件时因子恒为 1", () => {
    const bars = [bar("2026-01-05", 10), bar("2026-01-06", 11)];
    expect(adjustmentFactors(bars, []).map((f) => f.factor)).toEqual([1, 1]);
    expect(
      applyAdjustment(bars, adjustmentFactors(bars, []), "forward"),
    ).toEqual(bars);
  });
  it("10 送 10 的除权跳空被因子完全抵消", () => {
    // 前收 20，10 送 10 后除权价 10；次日收 10 实际是平盘，而不是腰斩。
    const bars = [bar("2026-01-05", 20), bar("2026-01-06", 10)],
      events = [
        {
          date: "2026-01-06",
          category: 1,
          name: "除权除息",
          dividend: 0,
          rightsPrice: 0,
          bonusRatio: 1,
          rightsRatio: 0,
        },
      ],
      factors = adjustmentFactors(bars, events),
      adjusted = applyAdjustment(bars, factors, "backward");
    expect(factors.map((f) => f.factor)).toEqual([1, 2]);
    expect(adjusted[1]!.close / adjusted[0]!.close).toBeCloseTo(1, 10);
  });
  it("现金分红按除权价公式折算", () => {
    // 前收 10，每股派 0.5：除权价 9.5，因子 10/9.5。
    const bars = [bar("2026-01-05", 10), bar("2026-01-06", 9.5)],
      factors = adjustmentFactors(bars, [
        {
          date: "2026-01-06",
          category: 1,
          name: "除权除息",
          dividend: 0.5,
          rightsPrice: 0,
          bonusRatio: 0,
          rightsRatio: 0,
        },
      ]);
    expect(factors[1]!.factor).toBeCloseTo(10 / 9.5, 10);
    expect(factors[1]!.preClose).toBeCloseTo(9.5, 10);
  });
  it("因子只在除权日跳变，平常日子不动", () => {
    const bars = [
        bar("2026-01-05", 10),
        bar("2026-01-06", 12),
        bar("2026-01-07", 9),
      ],
      factors = adjustmentFactors(bars, []);
    expect(new Set(factors.map((f) => f.factor)).size).toBe(1);
  });
  it("除权日落在非交易日时，在其后第一个交易日补上", () => {
    // 除权日 01-06 不在行情里（停牌或非交易日），必须在 01-07 生效；
    // 只认日期相等会让游标卡死，之后所有除权都被漏掉。
    const bars = [bar("2026-01-05", 20), bar("2026-01-07", 10)],
      factors = adjustmentFactors(bars, [
        {
          date: "2026-01-06",
          category: 1,
          name: "除权除息",
          dividend: 0,
          rightsPrice: 0,
          bonusRatio: 1,
          rightsRatio: 0,
        },
      ]);
    expect(factors.map((f) => f.factor)).toEqual([1, 2]);
  });
  it("同一天或连续多次除权按顺序逐次折算", () => {
    const bars = [bar("2026-01-05", 20), bar("2026-01-06", 5)],
      event = {
        date: "2026-01-06",
        category: 1,
        name: "除权除息",
        dividend: 0,
        rightsPrice: 0,
        bonusRatio: 1,
        rightsRatio: 0,
      },
      factors = adjustmentFactors(bars, [event, { ...event }]);
    // 两次 10 送 10：20 → 10 → 5，因子应为 4 而不是 2。
    expect(factors[1]!.factor).toBeCloseTo(4, 10);
    expect(factors[1]!.preClose).toBeCloseTo(5, 10);
  });
  it("上市首日之前的除权事件被丢弃", () => {
    const bars = [bar("2026-01-05", 10), bar("2026-01-06", 11)],
      factors = adjustmentFactors(bars, [
        {
          date: "2020-01-01",
          category: 1,
          name: "除权除息",
          dividend: 5,
          rightsPrice: 0,
          bonusRatio: 0,
          rightsRatio: 0,
        },
      ]);
    expect(factors.map((f) => f.factor)).toEqual([1, 1]);
  });
  it("前复权保持最新价不变，后复权保持首日价不变", () => {
    const bars = [bar("2026-01-05", 20), bar("2026-01-06", 10)],
      factors = adjustmentFactors(bars, [
        {
          date: "2026-01-06",
          category: 1,
          name: "除权除息",
          dividend: 0,
          rightsPrice: 0,
          bonusRatio: 1,
          rightsRatio: 0,
        },
      ]);
    const forward = applyAdjustment(bars, factors, "forward"),
      backward = applyAdjustment(bars, factors, "backward");
    expect(forward.at(-1)!.close).toBeCloseTo(bars.at(-1)!.close, 10);
    expect(backward[0]!.close).toBeCloseTo(bars[0]!.close, 10);
    expect(forward[0]!.close).toBeCloseTo(10, 10);
    expect(backward.at(-1)!.close).toBeCloseTo(20, 10);
  });
  it("复权只改价格，不动成交量", () => {
    const bars = [bar("2026-01-05", 20), bar("2026-01-06", 10)],
      factors = adjustmentFactors(bars, []);
    expect(
      applyAdjustment(bars, factors, "backward").map((b) => b.volume),
    ).toEqual(bars.map((b) => b.volume));
  });
  it("因子与行情长度不一致时报错", () => {
    const bars = [bar("2026-01-05", 10)];
    expect(() => applyAdjustment(bars, [], "forward")).toThrow("长度不一致");
    expect(applyAdjustment(bars, [], "none")).toBe(bars);
  });
});
