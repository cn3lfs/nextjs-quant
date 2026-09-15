import { describe, expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import { boll, kdj, ma, macd, rsi } from "../src/lib/indicators";
import { chartViewSchema, defaultChartView } from "../src/lib/chart-view";
import {
  chartIndicators,
  chartLegend,
  chartTime,
  enabledIndicators,
  indicatorSegments,
  initialHistoryStart,
  revealHistory,
} from "../src/lib/chart-data";

export function fixture(length = 420): Bar[] {
  return Array.from({ length }, (_, i) => {
    const close = 30 + i / 10 + Math.sin(i) * 2;
    return {
      date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: i * 100,
      amount: i * 100 * close,
    };
  });
}

describe("M2 chart data contract", () => {
  it("defaults to volume plus MACD and migrates legacy single-pane choices", () => {
    const view = chartViewSchema.parse(defaultChartView);
    expect(view.subchart).toEqual(["volume", "macd"]);
    expect(enabledIndicators(false, view.subchart)).toEqual([
      "MA5",
      "MA10",
      "MA20",
      "MA60",
      "DIF",
      "DEA",
      "MACD",
    ]);
    expect(
      chartViewSchema.parse({ ...view, subchart: "volume" }).subchart,
    ).toEqual(["volume"]);
    expect(
      chartViewSchema.parse({ ...view, subchart: "volume-macd" }).subchart,
    ).toEqual(["volume", "macd"]);
    expect(
      chartViewSchema.parse({ ...view, subchart: "none" }).subchart,
    ).toEqual([]);
    expect(enabledIndicators(false, ["macd", "kdj", "rsi"])).toEqual([
      "MA5",
      "MA10",
      "MA20",
      "MA60",
      "DIF",
      "DEA",
      "MACD",
      "K",
      "D",
      "J",
      "RSI6",
      "RSI12",
      "RSI24",
    ]);
  });
  it("legend at three bars reads every enabled M1 value without another formula", () => {
    const bars = fixture();
    const values = chartIndicators(bars);
    for (const index of [0, 19, 419]) {
      const expected = {
        MA5: ma(bars, 5)[index],
        MA10: ma(bars, 10)[index],
        MA20: ma(bars, 20)[index],
        MA60: ma(bars, 60)[index],
        BOLL中: boll(bars)[index]!.mid,
        BOLL上: boll(bars)[index]!.upper,
        BOLL下: boll(bars)[index]!.lower,
        DIF: macd(bars)[index]!.dif,
        DEA: macd(bars)[index]!.dea,
        MACD: macd(bars)[index]!.macd,
        K: kdj(bars)[index]!.k,
        D: kdj(bars)[index]!.d,
        J: kdj(bars)[index]!.j,
        RSI6: rsi(bars)[index]!.rsi6,
        RSI12: rsi(bars)[index]!.rsi12,
        RSI24: rsi(bars)[index]!.rsi24,
      };
      for (const sub of ["volume", "macd", "kdj", "rsi"] as const) {
        const legend = chartLegend(
          bars,
          values,
          index,
          enabledIndicators(true, [sub]),
        )!;
        expect(legend.bar).toEqual(bars[index]);
        for (const { name, value } of legend.indicators)
          expect(value).toBe(expected[name]);
      }
    }
  });
  it("warmup and internal nulls are real disconnected segments, never zeros or bridges", () => {
    const bars = fixture(80),
      values = chartIndicators(bars);
    expect(indicatorSegments(bars, values.MA20, "day")[0]![0]!.time).toBe(
      bars[19]!.date,
    );
    expect(indicatorSegments(bars, values.K, "day")[0]![0]!.time).toBe(
      bars[8]!.date,
    );
    const segments = indicatorSegments(
      bars.slice(0, 6),
      [null, 5, null, 0, 8, null],
      "day",
    );
    expect(segments.map((s) => s.map((p) => p.value))).toEqual([[5], [0, 8]]);
    expect(segments.flat().map((p) => p.time)).toEqual([
      bars[1]!.date,
      bars[3]!.date,
      bars[4]!.date,
    ]);
    expect(
      indicatorSegments(bars.slice(0, 8), values.K.slice(0, 8), "day"),
    ).toEqual([]);
  });
  it("prepends all history exactly once, preserving both viewport date anchors and indicator values", () => {
    const bars = fixture(601),
      values = chartIndicators(bars);
    let start = initialHistoryStart(bars.length);
    const collected = bars.slice(start);
    while (start) {
      const range = { from: 3, to: 53 };
      const next = revealHistory(start, range);
      expect(bars[next.start + next.range.from]).toEqual(
        bars[start + range.from],
      );
      expect(bars[next.start + next.range.to]).toEqual(bars[start + range.to]);
      collected.unshift(...bars.slice(next.start, start));
      start = next.start;
    }
    expect(collected).toEqual(bars);
    expect(new Set(collected.map((b) => b.date)).size).toBe(bars.length);
    expect(revealHistory(0, { from: 0, to: 50 })).toEqual({
      start: 0,
      range: { from: 0, to: 50 },
    });
    expect(chartIndicators(bars)).toEqual(values);
  });
  it("day to 5m to day uses distinct inputs and warmup, with exchange-time labels", () => {
    const day = fixture(80);
    const minute = fixture(10).map((bar, i) => ({
      ...bar,
      date: `2026-09-08T10:${String(i * 5).padStart(2, "0")}:00+08:00`,
      close: bar.close + 100,
      high: bar.high + 100,
      low: bar.low + 100,
      open: bar.open + 100,
    }));
    const original = chartIndicators(day),
      intraday = chartIndicators(minute);
    expect(intraday.MA20).toEqual(Array(10).fill(null));
    expect(intraday.DIF).toEqual(macd(minute).map((v) => v.dif));
    expect(intraday.MA5).not.toEqual(original.MA5.slice(0, 10));
    expect(chartIndicators(day)).toEqual(original);
    expect(
      new Date(Number(chartTime(minute[0]!.date, "5m")) * 1000).toISOString(),
    ).toBe("2026-09-08T10:00:00.000Z");
    expect(initialHistoryStart(minute.length)).toBe(0);
    expect(chartLegend([], chartIndicators([]), 0, [])).toBeNull();
  });
});
