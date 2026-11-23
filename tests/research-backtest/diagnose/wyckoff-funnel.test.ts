import { expect, it } from "vitest";
import { createExtendedStudyRule } from "trading-strategies";
import { researchWyckoffSeries } from "trading-strategies/research/wyckoff/research-wyckoff";
import type { Bar } from "trading-strategy-core/bars";
import {
  analyzeWyckoffFunnel,
  type WyckoffFunnelStrategyId,
} from "../../../scripts/lib/backtest-diagnose/wyckoff-funnel";

function makeBar(index: number, close: number, row: Partial<Bar> = {}): Bar {
  return {
    date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
    open: close - 0.1,
    close,
    high: close + 0.5,
    low: close - 0.5,
    volume: 100,
    amount: close * 100,
    ...row,
  };
}

function lpsBars() {
  const anchors = [
    [0, 80],
    [40, 95],
    [50, 100],
    [60, 104],
    [65, 96],
    [70, 104],
    [75, 96],
    [80, 104],
    [85, 96],
    [89, 102],
  ] as const;
  const bars = Array.from({ length: 90 }, (_, i) => {
    const right = anchors.findIndex(([index]) => index >= i);
    const [start, startClose] = anchors[Math.max(0, right - 1)]!;
    const [end, endClose] = anchors[right]!;
    return makeBar(
      i,
      startClose +
        ((endClose - startClose) * (i - start)) / Math.max(1, end - start),
    );
  });
  bars.push(
    makeBar(90, 105.5, { open: 102, low: 102, high: 106, volume: 150 }),
    makeBar(91, 105.6, { open: 105.2, low: 104.5, high: 105.8 }),
    makeBar(92, 105, { open: 105.5, low: 104.5, high: 105.6, volume: 40 }),
    makeBar(93, 105.8, { open: 105.1, low: 104.8, high: 106 }),
  );
  return bars;
}

function trendBars() {
  const bars = Array.from({ length: 90 }, (_, i) => makeBar(i, 100 + i * 0.2));
  const avg = bars.slice(-20).reduce((sum, row) => sum + row.close, 0) / 20;
  bars.push(
    makeBar(90, avg + 0.3, { open: 117, low: avg, high: 117.2, volume: 40 }),
    makeBar(91, 117.5, { open: 117, low: avg + 0.1, high: 118, volume: 150 }),
  );
  return bars;
}

const cases: [WyckoffFunnelStrategyId, () => Bar[], number][] = [
  ["wy-lps-daily", lpsBars, 1],
  ["wy-reaccumulation-daily", lpsBars, 1],
  ["wy-trend-pullback-daily", trendBars, 31],
];

function verifyFunnel(
  id: WyckoffFunnelStrategyId,
  bars: readonly Bar[],
  start: string,
  end: string,
) {
  const result = analyzeWyckoffFunnel(id, bars, start, end);
  const stages = [
    result.parentEvents,
    result.pullbackShrinkage,
    result.candidates,
    result.nextDayVolumeConfirm,
    result.entrySignals,
  ];
  expect(stages).toEqual([...stages].sort((a, b) => b - a));
  expect(result.entrySignals).toBe(
    researchWyckoffSeries(id, bars).filter(
      ({ date, entry }) => date >= start && date <= end && entry,
    ).length,
  );
  return result;
}

it.each(cases)(
  "matches %s entries and retains monotone counts across the confirmation boundary",
  (id, fixture, parents) => {
    const bars = fixture();
    const start = bars[0]!.date;
    const end = bars.at(-1)!.date;
    expect(verifyFunnel(id, bars, start, end)).toMatchObject({
      parentEvents: parents,
      pullbackShrinkage: 1,
      candidates: 1,
      nextDayVolumeConfirm: 1,
      entrySignals: 1,
      carryInCandidates: 0,
    });
    expect(verifyFunnel(id, bars, end, end)).toMatchObject({
      carryInCandidates: 1,
      candidates: 1,
      entrySignals: 1,
    });
    expect(verifyFunnel(id, bars, start, bars.at(-2)!.date)).toMatchObject({
      candidates: 1,
      nextDayVolumeConfirm: 0,
      entrySignals: 0,
    });
  },
);

it("locates shrinkage attrition separately from the trend next-day volume gate", () => {
  const lps = lpsBars();
  lps[92]!.volume = 60;
  expect(
    verifyFunnel("wy-lps-daily", lps, lps[0]!.date, lps[93]!.date),
  ).toMatchObject({
    parentEvents: 2,
    pullbackShrinkage: 0,
    candidates: 0,
    entrySignals: 0,
  });
  const trend = trendBars();
  trend[91]!.volume = 149.99;
  expect(
    verifyFunnel(
      "wy-trend-pullback-daily",
      trend,
      trend[0]!.date,
      trend[91]!.date,
    ),
  ).toMatchObject({
    pullbackShrinkage: 1,
    candidates: 1,
    nextDayVolumeConfirm: 0,
    entrySignals: 0,
  });
});

it("compares Wyckoff, theory-vcp-close and classic-ibs on the same frozen dates", () => {
  const bars = lpsBars();
  bars.push(makeBar(94, 105, { open: 106, high: 108, low: 105 }));
  const start = bars[90]!.date;
  const end = bars[94]!.date;
  const flatEntries = (id: "theory-vcp-close" | "classic-ibs") => {
    const rule = createExtendedStudyRule(id, bars)!;
    return bars
      .slice(90)
      .map((_, i) => i + 90)
      .filter((index) => rule(index, { entry: 0, entryIndex: index }).enter);
  };
  expect(verifyFunnel("wy-lps-daily", bars, start, end).entrySignals).toBe(1);
  expect(flatEntries("theory-vcp-close")).toEqual([]);
  expect(flatEntries("classic-ibs")).toContain(94);
});
