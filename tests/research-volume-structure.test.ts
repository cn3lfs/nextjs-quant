import { expect, it, vi } from "vitest";
import type { Bar } from "../src/lib/domain";
import { confirmedExtrema } from "../src/lib/indicators";
import { researchRuleSeries, isResearchRule } from "../src/lib/research-rules";
import {
  researchVolumeStructureSeries as series,
  volumeStructureIds,
} from "../src/lib/research-volume-structure";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";
import { researchSignals } from "../src/server/research-signals";
import { researchPortfolio } from "../src/server/research-portfolio";
import { runStrategyResearch } from "../src/server/research-run";
import {
  researchHash,
  type ResearchDataset,
} from "../src/server/research-dataset";

const native = vi.fn(async () => {
  throw new Error("must not call CZSC");
});
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
  tradable: true,
  limitUp: null,
  limitDown: null,
};
function specFor(id: (typeof volumeStructureIds)[number], bars: Bar[]) {
  return researchSpecSchema.parse({
    strategy: id,
    symbols: ["sh600000"],
    start: bars[90]!.date,
    end: bars.at(-1)!.date,
    validationStart: bars.at(-1)!.date,
    holdingDays: 1,
    initialCapital: 100000,
    maxPositions: 1,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
}
function delayedRetest(index: number): Bar[] {
  const bars = fixture();
  for (let i = 91; i < bars.length; i++) {
    const close = i === index ? 151.5 : 153;
    Object.assign(bars[i]!, {
      open: close,
      close,
      high: close + 0.5,
      low: i === index ? 150.7 : 152.5,
      volume: 200,
    });
  }
  return bars;
}

function fixture(range = false): Bar[] {
  const anchors = range
    ? [
        [0, 100],
        [50, 100],
        [60, 105],
        [65, 95],
        [70, 105],
        [75, 95],
        [80, 105],
        [85, 95],
        [89, 100],
        [90, 107],
        [95, 110],
      ]
    : [
        [0, 60],
        [30, 90],
        [50, 115],
        [60, 130],
        [65, 122],
        [70, 140],
        [75, 134],
        [80, 150],
        [85, 143],
        [89, 149],
        [90, 152],
        [95, 157],
      ];
  return Array.from({ length: 96 }, (_, i) => {
    const right = anchors.findIndex((a) => a[0]! >= i),
      b = anchors[right]!,
      a = anchors[Math.max(0, right - 1)]!;
    const close =
      a[0] === b[0]
        ? a[1]!
        : a[1]! + ((b[1]! - a[1]!) * (i - a[0]!)) / (b[0]! - a[0]!);
    return {
      date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
      open: close,
      close,
      high: close + 0.5,
      low: close - 0.5,
      volume: i === 90 ? 300 : 100,
      amount: close * 100,
    };
  });
}
it("confirmed extrema require all three right bars and reject ties", () => {
  const bars = fixture();
  expect(
    confirmedExtrema(bars.slice(0, 83)).extrema.some((p) => p.index === 80),
  ).toBe(false);
  expect(
    confirmedExtrema(bars.slice(0, 84)).extrema.find((p) => p.index === 80)
      ?.confirmedAt,
  ).toBe(bars[83]!.date);
  bars[81]!.high = bars[80]!.high;
  expect(confirmedExtrema(bars).extrema.some((p) => p.index === 80)).toBe(
    false,
  );
});
it("registers structural breakouts and rejects insufficient volume", () => {
  for (const [id, bars] of [
    ["vp-structure-up", fixture()],
    ["vp-structure-range", fixture(true)],
  ] as const) {
    expect(isResearchRule(id)).toBe(true);
    expect(researchRuleSeries(id, bars)[90]!.entry).toBe(true);
    bars[90]!.volume = 100;
    expect(series(id, bars)[90]!.entry).toBe(false);
  }
});
it("waits for an actual retest and cancels a broken frozen level", () => {
  const bars = fixture();
  Object.assign(bars[91]!, {
    open: 151,
    close: 151,
    high: 151.5,
    low: 150.5,
    volume: 200,
  });
  for (const id of ["vp-retest-1", "vp-retest-5"] as const) {
    const points = series(id, bars);
    expect(points[90]!.entry).toBe(false);
    expect(points[90]!.retest?.level).toBe(150.5);
    expect(points[91]!.entry).toBe(true);
    expect(points[91]!.ruleStop?.price).toBe(150.5);
  }
  bars[91]!.low = 150.4;
  expect(series("vp-retest-5", bars)[91]!.entry).toBe(false);
});
it("does not assemble pivots across suspension and preserves every historical prefix", () => {
  const bars = fixture();
  for (const id of volumeStructureIds) {
    const full = series(id, bars);
    for (let n = 80; n <= bars.length; n++)
      expect(series(id, bars.slice(0, n))).toEqual(full.slice(0, n));
  }
  bars[83]!.volume = 0;
  const point = series("vp-structure-up", bars)[90]!;
  expect(point.structure.barrier).toBe(bars[83]!.date);
  expect(point.structure.extrema).toEqual([]);
  expect(point.entry).toBe(false);
});

it("accepts the last allowed retest bar, expires one-bar waiting and does not revive an expired candidate", () => {
  const fifth = delayedRetest(95);
  expect(series("vp-retest-5", fifth)[95]!.entry).toBe(true);
  expect(
    series("vp-retest-1", fifth)
      .slice(90)
      .some((p) => p.entry),
  ).toBe(false);
  const expired = delayedRetest(96);
  expired.push({
    ...expired.at(-1)!,
    date: "2024-04-06",
    open: 151.5,
    close: 151.5,
    high: 152,
    low: 150.7,
  });
  expect(series("vp-retest-5", expired).at(-1)!.entry).toBe(false);
  const outside = delayedRetest(93);
  outside[93]!.low = 150.5 * 1.005 + 0.001;
  expect(series("vp-retest-5", outside)[93]!.entry).toBe(false);
  outside[93]!.low = 150.5 * 1.005;
  expect(series("vp-retest-5", outside)[93]!.entry).toBe(true);
});

it.each(volumeStructureIds)(
  "%s confirms before next-open execution and preserves frozen evidence",
  async (id) => {
    const input =
      id === "vp-structure-range"
        ? fixture(true)
        : id === "vp-retest-5"
          ? delayedRetest(93)
          : fixture();
    if (id === "vp-retest-1")
      Object.assign(input[91]!, {
        open: 151,
        close: 151,
        high: 151.5,
        low: 150.5,
        volume: 200,
      });
    const at = id === "vp-retest-5" ? 93 : id === "vp-retest-1" ? 91 : 90;
    const points = series(id, input);
    for (let n = 89; n <= input.length; n++)
      expect(series(id, input.slice(0, n))).toEqual(points.slice(0, n));
    const spec = specFor(id, input),
      events = await researchSignals("sh600000", input, spec, native);
    expect(events).toHaveLength(1);
    expect(events[0]!.observedDate).toBe(input[at]!.date);
    const result = researchPortfolio(
      spec,
      events,
      input.map((b) => b.date),
      new Map([["sh600000", input]]),
      () => rules,
    );
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.entryDate).toBe(input[at + 1]!.date);
    expect(result.trades[0]!.exitDate).toBe(input[at + 2]!.date);
    expect(native).not.toHaveBeenCalled();
  },
);

it("isolates ambiguous extrema and invalidates pending retests on unavailable input", () => {
  const ambiguous = fixture();
  Object.assign(ambiguous[80]!, { high: 200, low: 1 });
  const row = series("vp-structure-up", ambiguous)[90]!;
  expect(row.structure.barrier).toBe(ambiguous[80]!.date);
  expect(row.structure.extrema.map((p) => p.index)).toEqual([85]);
  expect(row.entry).toBe(false);
  for (const volume of [0, NaN]) {
    const bars = delayedRetest(93);
    bars[91]!.volume = volume;
    const points = series("vp-retest-5", bars);
    expect(points[91]!.reason).not.toBeNull();
    expect(points.slice(91).some((p) => p.entry)).toBe(false);
  }
});

it("requires the new 90-bar corporate-action coverage and excludes known splits in that window", async () => {
  const input = fixture(),
    spec = specFor("vp-structure-up", input);
  const dataset: ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "synthetic-fixture",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: spec.symbols!,
      source: null,
      warning: "合成池",
    },
    benchmark: { symbol: "sh000001", bars: input },
    calendar: input.map((b) => b.date),
    stocks: [
      {
        symbol: "sh600000",
        name: "合成",
        bars: input,
        hash: researchHash(input),
        actions: [],
      },
    ],
    excluded: [],
    actionCoverage: "partial",
    actionSource: { path: "fixture", modified: 0 },
    capturedAt: 0,
    hash: "fixed-structure",
  };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "fixture",
    exportedAt: 0,
    adjustment: "none",
    corporateActionFree: [
      {
        symbol: "sh600000",
        start: input[0]!.date,
        end: spec.end,
        evidenceId: "fixture",
      },
    ],
    rows: input.map((b) => ({
      ...rules,
      evidence: undefined,
      symbol: "sh600000",
      date: b.date,
      evidenceId: "fixture",
    })),
  });
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  expect(result.partitions[0]!.simulation!.statistics.count).toBe(1);
  expect(result.warnings[0]).toContain("90根价格");
  const short = await runStrategyResearch(
    spec,
    dataset,
    {
      ...evidence,
      corporateActionFree: evidence.corporateActionFree.map((r) => ({
        ...r,
        start: input[9]!.date,
      })),
    },
    native,
  );
  expect(short.events).toEqual(result.events);
  expect(short.partitions[0]!.simulation!.trades).toEqual([]);
  const split = await runStrategyResearch(
    spec,
    {
      ...dataset,
      stocks: dataset.stocks.map((s) => ({
        ...s,
        actions: [
          {
            date: input[5]!.date,
            category: 1,
            name: "合成除权",
            bonusRatio: 1,
          },
        ],
      })),
    },
    evidence,
    native,
  );
  expect(split.events).toEqual([]);
  expect(split.exclusions[0]!.reason).toContain("量价窗口含除权");
});
