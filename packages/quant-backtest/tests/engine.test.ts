import { maBaselineSignals } from "trading-strategies";
import { describe, expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  baselineBarOpenTime,
  maBaselineInputSchema,
  runMaBaseline,
} from "../src/index.js";
import { defaultExecutionCosts as defaultBacktestCosts } from "../src/costs.js";

const zeroCosts = {
  ...defaultBacktestCosts,
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  slippageBps: 0,
};
const input = {
  symbol: "sh600519",
  start: "2026-10-12",
  end: "2026-10-13",
  initial: 100000,
  costs: zeroCosts,
};
function fixture() {
  const bars: Bar[] = Array.from({ length: 24 }, (_, i) => {
    const minute = i === 23 ? 575 : 575 + (i < 20 ? i : i - 20) * 5;
    const close = i === 20 ? 11 : i === 21 || i === 22 ? 1 : 10;
    const open = i === 21 ? 12 : close;
    return {
      date: `${i < 20 ? "2026-10-09" : i === 23 ? "2026-10-13" : "2026-10-12"}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00+08:00`,
      open,
      close,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) * 0.5,
      volume: 1000,
      amount: 10000,
    };
  });
  return bars;
}

describe("TS 双均线基线账户", () => {
  it("only crosses; no trend-persistence, return or volume filters", () => {
    const bars = fixture();
    expect([...maBaselineSignals(bars)].slice(19, 23)).toEqual([0, 1, -1, 0]);
    expect(maBaselineSignals(bars.map((b) => ({ ...b, volume: 0 })))).toEqual(
      maBaselineSignals(bars),
    );
  });
  it("uses next open, 100-share lots, and retains T+1 exit until next date", () => {
    const bars = fixture(),
      before = structuredClone(bars);
    const partial = runMaBaseline(input, bars.slice(0, 23));
    expect(partial.fills.map((f) => [f.side, f.price, f.shares])).toEqual([
      ["buy", 12, 8300],
    ]);
    expect(partial.orders[1]).toMatchObject({
      status: "pending",
      reason: "T+1：当日买入不可卖出",
      attempts: 1,
    });
    const result = runMaBaseline(input, bars);
    expect(result.fills.map((f) => [f.side, f.price, f.shares])).toEqual([
      ["buy", 12, 8300],
      ["sell", 10, 8300],
    ]);
    // 100000 - 8300*12 + 8300*10 = 83400; no fabricated close at end.
    expect(result.cash).toBe(83400);
    expect(result.shares).toBe(0);
    expect(result.totalReturn).toBeCloseTo(-16.6);
    expect(result.fills[0]!.signalAt).toBe(bars[20]!.date);
    expect(result.fills[0]!.executedAt).toBe(
      baselineBarOpenTime(bars[21]!.date),
    );
    expect(bars).toEqual(before);
  });
  it("minimum commission is max(rate,min), sell tax adds separately", () => {
    const bars = fixture();
    bars[21]!.open = 9;
    const result = runMaBaseline(
      {
        ...input,
        initial: 1000,
        costs: {
          ...zeroCosts,
          commissionBps: 3,
          minimumCommission: 5,
          sellTaxBps: 5,
        },
      },
      bars,
    );
    expect(result.fills.map((f) => [f.shares, f.fee, f.cashAfter])).toEqual([
      [100, 5, 95],
      [100, 5.5, 1089.5],
    ]);
  });
  it("rejects unaffordable buys instead of borrowing, and does not force end liquidation", () => {
    const bars = fixture();
    bars[21]!.open = 200;
    bars[21]!.high = 201;
    const rejected = runMaBaseline({ ...input, initial: 1000 }, bars);
    expect(rejected.fills).toEqual([]);
    expect(rejected.orders[0]!.status).toBe("rejected");
    const held = runMaBaseline(input, fixture().slice(0, 22));
    expect(held.fills).toHaveLength(1);
    expect(held.shares).toBe(8300);
  });
  it("rejects blocked buy, retains blocked sell, never assigns previous signal close as fill", () => {
    const bars = fixture();
    bars[21]!.volume = 0;
    const result = runMaBaseline(input, bars);
    expect(result.fills).toEqual([]);
    expect(result.orders[0]!.reason).toContain("停牌");
    const blocked = fixture();
    blocked[23]!.high =
      blocked[23]!.low =
      blocked[23]!.open =
      blocked[23]!.close =
        10;
    expect(runMaBaseline(input, blocked).orders[1]).toMatchObject({
      status: "pending",
      reason: "一字行情，保守不成交",
    });
  });
  it("future prices do not rewrite earlier signals or fills", () => {
    const bars = fixture(),
      altered = structuredClone(bars);
    altered[23]!.close = 900;
    altered[23]!.high = 901;
    expect([...maBaselineSignals(altered)].slice(0, 23)).toEqual(
      [...maBaselineSignals(bars)].slice(0, 23),
    );
    expect(runMaBaseline(input, altered).fills[0]).toEqual(
      runMaBaseline(input, bars).fills[0],
    );
  });
  it("right-end timestamps cross lunch/overnight without inventing a session", () => {
    expect(baselineBarOpenTime("2026-10-12T13:05:00+08:00")).toBe(
      "2026-10-12T13:00:00+08:00",
    );
    expect(baselineBarOpenTime("2026-10-13T09:35:00+08:00")).toBe(
      "2026-10-13T09:30:00+08:00",
    );
  });
  it("rejects invalid or unsorted input and unsupported stock rules", () => {
    expect(
      maBaselineInputSchema.safeParse({ ...input, symbol: "sh688001" }).success,
    ).toBe(false);
    expect(
      maBaselineInputSchema.safeParse({ ...input, end: "2026-10-01" }).success,
    ).toBe(false);
    for (const bad of [NaN, Infinity, -1]) {
      const bars = fixture();
      bars[21]!.open = bad;
      expect(() => runMaBaseline(input, bars)).toThrow();
    }
    const duplicate = fixture();
    duplicate[22]!.date = duplicate[21]!.date;
    expect(() => runMaBaseline(input, duplicate)).toThrow("顺序");
    expect(() => runMaBaseline(input, fixture().slice(20))).toThrow("预热");
  });
});
