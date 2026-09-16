import { expect, it, vi } from "vitest";
import type { Bar } from "../src/lib/domain";
import * as cupModule from "../src/server/canslim-cup";
import * as flatModule from "../src/server/canslim-flat-base";
import * as saucerModule from "../src/server/canslim-saucer";
import { researchCanslimPriorityPoint } from "../src/server/research-canslim-priority";
import { researchRuleSeries } from "../src/server/research-rule-series";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchSignals } from "../src/server/research-signals";

const fixture = (): Bar[] =>
  Array.from({ length: 77 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: i >= 70 ? 102 : 97,
    high: i >= 69 ? 103 : 100,
    low: i >= 70 ? 101 : 95,
    close: i >= 69 ? 102 : 97,
    volume: i < 49 ? 100 : i < 59 ? 45 : i < 69 ? 35 : 70,
    amount: 1000000,
  }));

it("selects real flat geometry, preserves full-prefix evidence and freezes three-day pivot", async () => {
  const bars = fixture();
  for (const [strategy, index] of [
    ["canslim-priority", 69],
    ["canslim-priority-hold3", 72],
  ] as const) {
    const points = researchRuleSeries(strategy, bars);
    expect(points.filter((p) => p.entry).map((p) => p.date)).toEqual([
      bars[index]!.date,
    ]);
    expect(points[index]).toMatchObject({
      candidate: { family: "flat", high: 100 },
      historyStart: bars[0]!.date,
    });
    expect(researchRuleSeries(strategy, bars.slice(0, index + 1))).toEqual(
      points.slice(0, index + 1),
    );
    const spec = researchSpecSchema.parse({
      strategy,
      symbols: ["sh600000"],
      start: bars[61]!.date,
      end: bars[76]!.date,
      validationStart: bars[75]!.date,
      holdingDays: 2,
    });
    const events = await researchSignals("sh600000", bars, spec, async () => {
      throw Error("unexpected native");
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      observedDate: bars[index]!.date,
      historyStart: bars[0]!.date,
      entryPriceRange: { min: 100, max: 105 },
    });
  }
  const missing = bars.filter((_, i) => i !== 71);
  expect(
    researchRuleSeries(
      "canslim-priority-hold3",
      missing,
      bars.map((b) => b.date),
    ).some((p) => p.entry),
  ).toBe(false);
});

it("does not hide invalid old history behind a valid recent flat window", () => {
  const bars = fixture().slice(0, 70);
  bars[0]!.volume = 0;
  expect(researchCanslimPriorityPoint(bars)).toMatchObject({
    entry: false,
    candidate: null,
    historyStart: null,
  });
});

it("selects geometry before entry and never falls through a waiting cup", () => {
  const bars = fixture().slice(0, 70);
  // Controlled diagnostic outputs isolate family policy from geometric fixtures.
  const cup = vi.spyOn(cupModule, "canslimCup").mockReturnValue({
    applicable: true,
    version: "fixture",
    warnings: [],
    candidates: [
      {
        qualified: true,
        points: 8,
        duration: 40,
        handleLength: 6,
        pivot: 104,
        left: bars[3]!.date,
        right: bars[43]!.date,
        bottomDate: bars[23]!.date,
        leftConfirmedAt: bars[6]!.date,
        rightConfirmedAt: bars[46]!.date,
        handleEnd: bars[68]!.date,
        depthPercent: 20,
        handlePullbackPercent: 5,
        upperHalf: true,
        rounded: true,
        shape: "U",
        doubleBottom: null,
        longestBottomRun: 10,
        volumeRatio: 0.5,
        contracting: true,
        testDate: bars[69]!.date,
        breakoutAboveOnePercent: false,
        threeDayHold: null,
      },
    ],
  });
  try {
    expect(researchCanslimPriorityPoint(bars)).toMatchObject({
      entry: false,
      candidate: { family: "cup", high: 104 },
    });
    cup.mockReturnValue({
      applicable: true,
      version: "fixture",
      warnings: [],
      candidates: [
        {
          qualified: false,
          points: 5,
          duration: 40,
          handleLength: 6,
          pivot: 104,
          left: bars[3]!.date,
          right: bars[43]!.date,
          bottomDate: bars[23]!.date,
          leftConfirmedAt: bars[6]!.date,
          rightConfirmedAt: bars[46]!.date,
          handleEnd: bars[68]!.date,
          depthPercent: 20,
          handlePullbackPercent: 5,
          upperHalf: true,
          rounded: true,
          shape: "U",
          doubleBottom: null,
          longestBottomRun: 10,
          volumeRatio: 0.5,
          contracting: true,
          testDate: bars[69]!.date,
          breakoutAboveOnePercent: false,
          threeDayHold: null,
        },
      ],
    });
    expect(researchCanslimPriorityPoint(bars)).toMatchObject({
      entry: true,
      candidate: { family: "flat", high: 100 },
    });
  } finally {
    cup.mockRestore();
  }
});

it("falls back to saucer only after both higher families fail qualification", () => {
  const bars = fixture().slice(0, 70);
  const flat = vi.spyOn(flatModule, "canslimFlatBase").mockReturnValue({
    applicable: true,
    version: "fixture",
    warnings: [],
    candidates: [],
  });
  const saucer = vi.spyOn(saucerModule, "canslimSaucer").mockReturnValue({
    applicable: true,
    version: "fixture",
    warnings: [],
    candidates: [
      {
        qualified: true,
        points: 8,
        length: 30,
        high: 100,
        start: bars[39]!.date,
        end: bars[68]!.date,
        bottomDate: bars[50]!.date,
        low: 90,
        depthPercent: 10,
        longestBottomRun: 10,
        rounded: true,
        shape: "U",
        doubleBottom: null,
        bottomVolumeRatio: 0.3,
        testDate: bars[69]!.date,
        breakoutAboveOnePercent: true,
        threeDayHold: null,
      },
    ],
  });
  try {
    expect(researchCanslimPriorityPoint(bars)).toMatchObject({
      entry: true,
      candidate: { family: "saucer" },
    });
    saucer.mockReturnValue({
      applicable: true,
      version: "fixture",
      warnings: [],
      candidates: [],
    });
    expect(researchCanslimPriorityPoint(bars)).toMatchObject({
      entry: false,
      candidate: null,
    });
  } finally {
    flat.mockRestore();
    saucer.mockRestore();
  }
});
