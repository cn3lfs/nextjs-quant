import falseBreakout from "../../fixtures/breakout-false.json";
import { chanMovementFixture } from "../../helpers/chan-movements";
import { describe, expect, it } from "vitest";
import type { PatternBreakoutMatch } from "trading-strategies";
import {
  analyzeBreakout,
  type BreakoutSide,
  type DoubleBreakoutFilter,
  type Level,
  type Swing,
} from "trading-strategies/research/breakout/breakout";
import {
  CZSC_CTX,
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
    signals: [],
  };
  const result = (...families: CzscFamily[]): CzscResult => ({
    status: "structure",
    hash: "chart-fixture",
    sourceCommit: czscSourceCommit,
    families,
  });

  it.each([
    { config: 0, prefix: "笔" },
    { config: 1100, prefix: "段" },
  ] as const)(
    "renders only visible, unrevoked standard $prefix signals",
    ({ config, prefix }) => {
      const signal = (index: number, kind: number, revokedAt?: number) => ({
        index,
        date: bars[index]!.date,
        kind,
        quality: 1,
        revokedAt,
      });
      const native = chanMovementFixture().signal;
      const structure = (contextFlags: number) => ({
        ...native.structure!,
        contextFlags,
      });
      const divergence = (semantic: number) => ({
        ...native.divergence!,
        semantic,
      });
      const fact = result({
        ...family,
        config,
        signals: [
          signal(0, 1),
          signal(1, 1),
          signal(1, -1),
          signal(2, 2, -1),
          signal(2, -2, -1),
          signal(3, 3, -2),
          signal(3, -3, -2),
          signal(4, 1, 0),
          signal(4, -2, 5),
          signal(5, 0),
          signal(5, 4),
          signal(5, -4),
          ...[1, -1].flatMap((sign) => [
            { ...signal(4, sign), divergence: divergence(2) },
            { ...signal(4, 2 * sign), structure: structure(CZSC_CTX.overlap) },
            { ...signal(4, 3 * sign), structure: structure(CZSC_CTX.overlap) },
            {
              ...signal(5, 3 * sign),
              structure: structure(CZSC_CTX.smallTurn),
            },
            { ...signal(5, 3 * sign), divergence: divergence(3) },
          ]),
        ],
      });
      for (const input of [undefined, [], bars]) {
        const markers = czscChartMarkers(fact, "day", 1, input);
        expect(markers.map(({ time, text }) => [time, text])).toEqual([
          [bars[1]!.date, `${prefix}1买`],
          [bars[1]!.date, `${prefix}1卖`],
          [bars[2]!.date, `${prefix}2买`],
          [bars[2]!.date, `${prefix}2卖`],
          [bars[3]!.date, `${prefix}3买`],
          [bars[3]!.date, `${prefix}3卖`],
        ]);
      }
    },
  );

  it("renders standard CZSC endpoints without diagnostic or breakout markers", () => {
    const fact = result(
      {
        ...family,
        signals: [
          {
            index: 2,
            date: minute[2]!.date,
            kind: 3,
            quality: 1,
            confirmedAt: 5,
          },
        ],
        breakouts: [
          {
            centerId: 1,
            direction: 1,
            leavePointId: 1,
            retestPointId: 2,
            third: true,
          },
        ],
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
    ]);
  });

  function doubleBreakout(chartBars = bars) {
    const analyzed = analyzeBreakout(chartBars);
    const latest = analyzed.latest!;
    const directional = (direction: "long" | "short"): BreakoutSide => {
      const kind = direction === "long" ? "high" : "low";
      const swing = (index: number): Swing => ({
        index,
        date: chartBars[index]!.date,
        confirmedAt: chartBars[index]!.date,
        price: 30,
        kind,
      });
      return {
        ...latest[direction],
        status: "是",
        score: direction === "long" ? 4 : 3,
        quality: direction === "long" ? "4/5" : "3/5",
        line: {
          direction,
          anchors: [swing(0), swing(2)],
          slope: 0,
          value: 30,
          touches: direction === "long" ? 3 : 2,
          confirmedAt: chartBars[2]!.date,
        },
      };
    };
    const point = {
      ...latest,
      levels: [],
      long: directional("long"),
      short: directional("short"),
    };
    return { ...analyzed, latest: point, points: [point] };
  }

  it("gives double-breakout trendlines and quality markers the same directional colors", () => {
    const result = doubleBreakout();
    const overlay = breakoutChartData(result, bars, 1);
    expect(overlay.lines.map(({ color }) => color)).toEqual([
      "#7c3aed",
      "#28977f",
    ]);
    expect(overlay.markers.map(({ color, text }) => [color, text])).toEqual([
      ["#7c3aed", "双突破↑ 4/5"],
      ["#28977f", "双突破↓ 3/5"],
    ]);
  });

  it("hides short trendlines and markers when the overlay direction is long", () => {
    const overlay = breakoutChartData(doubleBreakout(), bars, 1, 5, "day", {
      direction: "long",
    });
    expect(overlay.lines.map(({ title }) => title)).toEqual([
      "下降趋势线 · 3触",
    ]);
    expect(overlay.markers.map(({ text }) => text)).toEqual(["双突破↑ 4/5"]);
  });

  it("requires four affirmative votes even when the three core checks pass", () => {
    const history = [...falseBreakout.bars];
    const last = history.at(-1)!;
    history[history.length - 1] = {
      ...last,
      close: 1563,
      volume: last.volume * 2,
    };
    const result = analyzeBreakout(history);
    expect(result.latest?.long).toMatchObject({
      status: "是",
      quality: "4/5",
      indicatorVotes: { MACD: "否", KDJ: "否", RSI: "否", BOLL: "否" },
    });
    const index = history.length - 1;
    const filter = { direction: "long", minScore: 3 } as const;
    expect(
      breakoutChartData(result, history, index, index, "day", filter).markers,
    ).toHaveLength(1);
    expect(
      breakoutChartData(result, history, index, index, "day", {
        ...filter,
        minIndicatorVotes: 4,
      }).markers,
    ).toEqual([]);
    const strict = analyzeBreakout(history, index, true, {
      minIndicatorVotes: 4,
    });
    expect(strict.latest?.long).toMatchObject({ status: "否", quality: "4/5" });
    expect(
      breakoutChartData(strict, history, index, index, "day", filter).markers,
    ).toEqual([]);
  });

  it.each(["ma20", "trendline-or-ma20"] as const)(
    "plots the actual rolling MA20 once for %s through the as-of bar",
    (trendMode) => {
      const history = fixture(82).map((bar, i) => ({
        ...bar,
        open: 100 + i,
        close: 100 + i,
        high: 101 + i,
        low: 99 + i,
      }));
      const result = analyzeBreakout(history, 0, true, { trendMode });
      const asOf = 78;
      expect(result.points[asOf]!.long).toMatchObject({
        line: null,
        trendSource: "ma20",
      });
      for (const start of [0, 75]) {
        const begin = Math.max(start, asOf - 20);
        const baselines = breakoutChartData(
          result,
          history,
          start,
          asOf,
        ).lines.filter((line) => line.title === "MA20趋势基准");
        expect(baselines.map((line) => line.data)).toEqual([
          history.slice(begin, asOf + 1).map((bar, i) => ({
            time: bar.date,
            value: 100 + begin + i - 9.5,
          })),
        ]);
      }
    },
  );

  it("plots the judged platform level and omits a side with no chosen level", () => {
    const result = doubleBreakout();
    const level = (source: Level["source"], index: number, price: number) => ({
      source,
      index,
      confirmedAt: bars[index]!.date,
      price,
    });
    result.latest.long.keyLevel = level("platform-high", 1, 35);
    result.latest.short.keyLevel = null;
    const levels = [
      level("platform-low", 3, 24),
      level("swing-high", 4, 38),
      level("swing-low", 2, 25),
    ];
    const point = { ...result.latest, levels };
    const lines = (direction: "long" | "short") =>
      breakoutChartData({ ...result, points: [point] }, bars, 0, 5, "day", {
        direction,
      }).lines.map(({ title, data }) => [title, data[0]]);
    expect(lines("long")).toEqual([
      ["下降趋势线 · 3触", { time: bars[0]!.date, value: 30 }],
      ["平台高点 35.00", { time: bars[1]!.date, value: 35 }],
    ]);
    expect(lines("short")).toEqual([
      ["上升趋势线 · 2触", { time: bars[0]!.date, value: 30 }],
    ]);
    point.short.keyLevel = level("volume-bull-close", 2, 26);
    expect(lines("short")).toEqual([
      ["上升趋势线 · 2触", { time: bars[0]!.date, value: 30 }],
      ["放量阳线收盘 26.00", { time: bars[2]!.date, value: 26 }],
    ]);
  });

  it("applies score, touch and candle-body filters only when supplied", () => {
    const last = bars[5]!;
    const largeBody = { ...last, open: last.close - 2, low: last.close - 2.1 };
    const chartBars = [...bars.slice(0, 5), largeBody];
    const result = doubleBreakout(chartBars);
    result.points.unshift({ ...result.latest, index: 4, date: bars[4]!.date });
    const markers = (filter?: DoubleBreakoutFilter) =>
      breakoutChartData(result, chartBars, 1, 5, "day", filter).markers.map(
        ({ time, text }) => [time, text],
      );
    const smallLong = [bars[4]!.date, "双突破↑ 4/5"];
    const smallShort = [bars[4]!.date, "双突破↓ 3/5"];
    const largeLong = [last.date, "双突破↑ 4/5"];
    const largeShort = [last.date, "双突破↓ 3/5"];

    expect(markers()).toEqual([smallLong, smallShort, largeLong, largeShort]);
    expect(markers({ minScore: 4 })).toEqual([smallLong, largeLong]);
    expect(markers({ minTouches: 3 })).toEqual([smallLong, largeLong]);
    expect(markers({ requireLargeBody: true })).toEqual([
      largeLong,
      largeShort,
    ]);
    expect(
      markers({ minScore: 4, minTouches: 3, requireLargeBody: true }),
    ).toEqual([largeLong]);
  });

  it("locates both swing levels by their first confirmation date and clips them to the visible range", () => {
    const analyzed = analyzeBreakout(bars);
    const high: Level = {
      source: "swing-high",
      price: 40,
      index: 0,
      confirmedAt: bars[2]!.date,
    };
    const low: Level = {
      source: "swing-low",
      price: 25,
      index: 0,
      confirmedAt: bars[0]!.date,
    };
    const point = {
      ...analyzed.latest!,
      long: { ...analyzed.latest!.long, keyLevel: high },
      short: { ...analyzed.latest!.short, keyLevel: low },
      levels: [high, low],
    };
    const overlay = { ...analyzed, points: [point] };
    const duplicate = [...bars.slice(0, -1), { ...bars[2]! }];
    expect(
      breakoutChartData(overlay, duplicate, 1).lines.map((line) => line.data),
    ).toEqual([
      [
        { time: bars[2]!.date, value: 40 },
        { time: point.date, value: 40 },
      ],
      [
        { time: bars[1]!.date, value: 25 },
        { time: point.date, value: 25 },
      ],
    ]);

    high.confirmedAt = point.date;
    low.confirmedAt = "2020-01-01";
    expect(
      breakoutChartData(overlay, bars, 1).lines.map((line) => line.data),
    ).toEqual([
      [
        { time: bars[1]!.date, value: 25 },
        { time: point.date, value: 25 },
      ],
    ]);
  });

  it("renders the latest visible pattern geometry by default and all visible geometry on request", () => {
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
      { title: "上轨", color: "#64748b", lineStyle: 2, data: upperData },
      { title: "下轨", color: "#0891b2", lineStyle: 0, data: lowerData },
    ]);
    expect(
      patternChartData(matches, minute, 2, 4, "5m", { showAllGeometry: false }),
    ).toEqual(data);
    expect(
      patternChartData(matches, minute, 2, 4, "5m", { showAllGeometry: true }),
    ).toEqual({
      lines: [
        { title: "上轨", color: "#d97706", lineStyle: 2, data: upperData },
        { title: "下轨", color: "#64748b", lineStyle: 0, data: lowerData },
        ...data.lines,
      ],
      markers: data.markers,
    });
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
    const clipped = patternChartData([bearish], minute, 3, 4, "5m");
    expect(clipped.lines.map(({ data }) => data)).toEqual([
      [
        { time: chartTime(minute[3]!.date, "5m"), value: 10.5 },
        { time: t4, value: 10 },
      ],
      [
        { time: chartTime(minute[3]!.date, "5m"), value: 8 },
        { time: t4, value: 8 },
      ],
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
