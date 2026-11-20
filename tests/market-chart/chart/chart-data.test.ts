import { describe, expect, it } from "vitest";
import type { PatternBreakoutMatch } from "trading-strategies";
import {
  analyzeBreakout,
  type BreakoutSide,
  type Swing,
} from "trading-strategies/research/breakout/breakout";
import {
  czscSourceCommit,
  type CzscFamily,
  type CzscResult,
} from "trading-strategies/research/chan/czsc";
import type { Bar } from "../../../src/lib/domain";
import { boll, kdj, ma, macd, rsi } from "../../../src/lib/indicators";
import {
  chartViewSchema,
  defaultChartView,
} from "../../../src/lib/chart/chart-view";
import {
  breakoutChartData,
  chartIndicators,
  chartLegend,
  chartTime,
  czscChartMarkers,
  enabledIndicators,
  indicatorSegments,
  initialHistoryStart,
  patternChartData,
  revealHistory,
} from "../../../src/lib/chart/chart-data";

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

describe("strategy chart overlays", () => {
  const bars = fixture(6);
  const minute = bars.map((bar, index) => ({
    ...bar,
    date: `2026-11-20T09:${30 + index * 5}:00+08:00`,
  }));
  const family: CzscFamily = {
    config: 0,
    points: [],
    centers: [],
    movements: [],
    qualities: [],
    divergences: [],
    signals: [
      { index: 0, date: bars[0]!.date, kind: 1, quality: 1 },
      { index: 1, date: bars[1]!.date, kind: 2, quality: 1, revokedAt: 4 },
      { index: 2, date: bars[2]!.date, kind: 3, quality: 1, revokedAt: -1 },
    ],
  };
  const result = (...families: CzscFamily[]): CzscResult => ({
    status: "structure",
    hash: "chart-fixture",
    sourceCommit: czscSourceCommit,
    families,
  });

  it("excludes revoked CZSC points and retains legacy labels without structure or bars", () => {
    const legacy = result(family, {
      ...family,
      config: 1100,
      signals: [{ index: 3, date: bars[3]!.date, kind: -2, quality: 1 }],
    });
    for (const input of [undefined, [], bars])
      expect(
        czscChartMarkers(legacy, "day", 1, input).map((m) => m.text),
      ).toEqual(["笔3买", "段2卖"]);
  });

  it("uses an empty breakout array as structure evidence only when bars are available", () => {
    const fact = result({
      ...family,
      breakouts: [],
      signals: [{ ...family.signals[2]!, confirmedAt: -1 }],
    });
    expect(czscChartMarkers(fact, "day", 0, [])).toMatchObject([
      { text: "笔3买" },
    ]);
    expect(czscChartMarkers(fact, "day", 0, bars)).toEqual([]);
  });

  it("renders classified CZSC points at the endpoint with one level prefix except nested signals", () => {
    const fact = result(
      {
        ...family,
        signals: family.signals.map((signal) => ({
          ...signal,
          date: minute[signal.index]!.date,
          confirmedAt: 5,
        })),
        diagnostics: {
          version: czscSourceCommit,
          lifecycle: [],
          ma: [],
          nested: [
            {
              lowConfig: 0,
              sourceConfig: 1100,
              index: 4,
              level: 1,
              sourceCandidateId: 0,
              lowStartPointId: 0,
              lowEndPointId: 0,
              semantic: 0,
              confirmFlags: 3,
              direction: 1,
            },
          ],
        },
      },
      {
        ...family,
        config: 1100,
        signals: [{ index: 3, date: minute[3]!.date, kind: -3, quality: 1 }],
        diagnostics: {
          version: czscSourceCommit,
          lifecycle: [],
          nested: [],
          ma: [
            {
              index: 4,
              difference: -1,
              kiss: 2,
              volumeKiss: 0,
              instantWarning: 0,
            },
            {
              index: 5,
              difference: -2,
              kiss: 0,
              volumeKiss: 0,
              instantWarning: 0,
            },
          ],
        },
      },
    );
    const t = (index: number) => chartTime(minute[index]!.date, "5m");
    const markers = czscChartMarkers(fact, "5m", 1, minute);
    expect(
      markers.map(({ time, text, position, color, shape }) => [
        time,
        text,
        position,
        color,
        shape,
      ]),
    ).toEqual([
      [t(2), "笔3买", "belowBar", "#cf5562", "arrowUp"],
      [t(3), "段3卖", "aboveBar", "#28977f", "arrowDown"],
      [t(4), "区间套买", "belowBar", "#cf5562", "arrowUp"],
      [t(5), "段均线吻卖", "aboveBar", "#28977f", "arrowDown"],
    ]);
  });

  it("gives double-breakout trendlines and quality markers the same directional colors", () => {
    const analyzed = analyzeBreakout(bars);
    const latest = analyzed.latest!;
    const directional = (direction: "long" | "short"): BreakoutSide => {
      const kind = direction === "long" ? "high" : "low";
      const swing = (index: number): Swing => ({
        index,
        date: bars[index]!.date,
        confirmedAt: bars[index]!.date,
        price: 30,
        kind,
      });
      return {
        ...latest[direction],
        status: "是",
        quality: "高",
        line: {
          direction,
          anchors: [swing(0), swing(2)],
          slope: 0,
          value: 30,
          touches: 2,
          confirmedAt: bars[2]!.date,
        },
      };
    };
    const point = {
      ...latest,
      levels: [],
      long: directional("long"),
      short: directional("short"),
    };
    const overlay = breakoutChartData(
      { ...analyzed, latest: point, points: [point] },
      bars,
      1,
    );
    expect(overlay.lines.map(({ color }) => color)).toEqual([
      "#7c3aed",
      "#28977f",
    ]);
    expect(overlay.markers.map(({ color, text }) => [color, text])).toEqual([
      ["#7c3aed", "双突破↑ 高"],
      ["#28977f", "双突破↓ 高"],
    ]);
  });

  it("clips pattern matches and geometry to the window and appends one direction arrow", () => {
    const point = (index: number, price: number) => ({
      index,
      price,
      date: minute[index]?.date ?? "2026-11-20T10:30:00+08:00",
    });
    const upper = {
      kind: "upper" as const,
      label: "上轨",
      style: "dashed" as const,
      points: [point(0, 12), point(2, 11), point(4, 10), point(5, 9)],
    };
    const lower = {
      kind: "lower" as const,
      label: "下轨",
      style: "solid" as const,
      points: [point(2, 8), point(4, 8), point(6, 8)],
    };
    const bullish: PatternBreakoutMatch = {
      kind: "box",
      subKind: "水平箱体",
      direction: "long",
      label: "箱体突破↑",
      index: 2,
      date: minute[2]!.date,
      close: 12,
      pivotPrice: 11,
      stopPrice: 8,
      targetPrice: 14,
      rewardMultiple: 0.5,
      volumeRatio: 1.5,
      durationBars: 20,
      depthPercent: 10,
      score: 4,
      summary: "向上突破",
      geometry: { lines: [upper, lower] },
    };
    const bearish: PatternBreakoutMatch = {
      ...bullish,
      direction: "short",
      label: "箱体破位",
      index: 4,
      date: minute[4]!.date,
    };
    const matches = [
      { ...bullish, index: 1 },
      bullish,
      bearish,
      { ...bearish, index: 5 },
    ];
    const data = patternChartData(matches, minute, 2, 4, "5m");
    const t2 = chartTime(minute[2]!.date, "5m"),
      t4 = chartTime(minute[4]!.date, "5m");
    const upperData = [
      { time: t2, value: 11 },
      { time: t4, value: 10 },
    ];
    const lowerData = [
      { time: t2, value: 8 },
      { time: t4, value: 8 },
    ];
    expect(data.lines).toEqual([
      { title: "上轨", color: "#d97706", lineStyle: 2, data: upperData },
      { title: "下轨", color: "#64748b", lineStyle: 0, data: lowerData },
      { title: "上轨", color: "#64748b", lineStyle: 2, data: upperData },
      { title: "下轨", color: "#0891b2", lineStyle: 0, data: lowerData },
    ]);
    expect(data.markers).toEqual([
      {
        time: t2,
        text: "箱体突破↑ 4/5",
        position: "belowBar",
        color: "#d97706",
        shape: "arrowUp",
      },
      {
        time: t4,
        text: "箱体破位↓ 4/5",
        position: "aboveBar",
        color: "#0891b2",
        shape: "arrowDown",
      },
    ]);
    const wide = patternChartData([bearish], minute, 2, 6, "5m");
    expect(wide.lines[1]?.data).toEqual(lowerData);
  });
});

describe("M2 chart data contract", () => {
  it("defaults to main MA plus volume and MACD and migrates legacy choices", () => {
    const view = chartViewSchema.parse(defaultChartView);
    expect(view.mainIndicators).toEqual(["ma"]);
    expect(view.subchart).toEqual(["volume", "macd"]);
    expect(enabledIndicators(view.mainIndicators, view.subchart)).toEqual([
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
    expect(enabledIndicators(["ma"], ["macd", "kdj", "rsi"])).toEqual([
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
    const { mainIndicators: _, ...legacyView } = view;
    expect(
      chartViewSchema.parse({ ...legacyView, showBoll: true }).mainIndicators,
    ).toEqual(["ma", "boll"]);
    expect(enabledIndicators(["boll"], [])).toEqual([
      "BOLL中",
      "BOLL上",
      "BOLL下",
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
          enabledIndicators(["ma", "boll"], [sub]),
        )!;
        expect(legend.bar).toEqual(bars[index]);
        for (const { name, value } of legend.indicators)
          expect(value).toBe(expected[name as keyof typeof expected]);
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
