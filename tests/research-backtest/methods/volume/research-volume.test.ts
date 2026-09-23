import { volumeCompletionIds } from "../../../../src/lib/research/methods/volume/research-volume-completion";
import { expect, it, vi } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import { volumeMa } from "../../../../src/lib/indicators";
import { volumeGridIds } from "../../../../src/lib/research/methods/volume/research-volume-grid";
import {
  classifyVolumePrice,
  researchVolumeSeries,
  volumeStrategyIds,
  volumeWarmupStart,
  type VolumeStrategyId,
} from "../../../../src/lib/research/methods/volume/research-volume";
import { researchSignals } from "../../../../src/server/strategies/shared/research-signals";
import { researchPortfolio } from "../../../../src/server/backtest/research-portfolio";
import { researchSpecSchema } from "../../../../src/lib/research/strategy-research";
import type { ResearchExecutionRules } from "../../../../src/lib/research/technical/research-execution";
import { researchMethodSnapshot } from "../../../../src/server/research/research-method";
import { runStrategyResearch } from "../../../../src/server/backtest/research-run";
import { researchMarketEvidenceSchema } from "../../../../src/lib/research/factors/research-market-evidence";
import {
  researchHash,
  type ResearchDataset,
} from "../../../../src/server/backtest/research-dataset";

function bars(
  tail: { close: number; volume: number; open?: number }[],
  slope = 0.2,
): Bar[] {
  const points = [
    ...Array.from({ length: 61 }, (_, i) => ({
      close: 100 + i * slope,
      volume: 100,
      open: 100 + i * slope,
    })),
    ...tail,
  ];
  return points.map((v, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: v.open ?? v.close,
    close: v.close,
    volume: v.volume,
    amount: v.volume * v.close,
    high: Math.max(v.open ?? v.close, v.close) + 0.5,
    low: Math.min(v.open ?? v.close, v.close) - 0.5,
  }));
}
const examples: [VolumeStrategyId, Bar[], number][] = [
  [
    "vp-up-expanded-confirm",
    bars([
      { close: 115.36, volume: 300 },
      { close: 116, volume: 200 },
    ]),
    62,
  ],
  [
    "vp-flat-expanded-break",
    bars(
      [
        { close: 100, volume: 300 },
        { close: 101, volume: 300 },
      ],
      0,
    ),
    62,
  ],
  [
    "vp-up-contracted-confirm",
    bars([
      { close: 115.36, volume: 30 },
      { close: 116, volume: 150 },
    ]),
    62,
  ],
  [
    "vp-down-contracted-confirm",
    bars(
      [
        { close: 120.9, volume: 30 },
        { close: 122, volume: 250, open: 121 },
      ],
      0.4,
    ),
    62,
  ],
  [
    "vp-up-normal-confirm",
    bars([
      { close: 115.36, volume: 120 },
      { close: 119, volume: 300 },
    ]),
    62,
  ],
  [
    "vp-flat-contracted-break",
    bars(
      [
        { close: 100, volume: 20 },
        { close: 101, volume: 250 },
      ],
      0,
    ),
    62,
  ],
  ["vp-breakout-1-5", bars([{ close: 115.36, volume: 150 }]), 61],
  ["vp-breakout-2", bars([{ close: 115.36, volume: 200 }]), 61],
  ["vp-volume-ma-cross", bars([{ close: 112.2, volume: 150 }]), 61],
];
it.each(examples)(
  "%s waits for the specified confirmation using only the observed prefix",
  (id, input, index) => {
    const points = researchVolumeSeries(id, input);
    expect(points.flatMap((point, i) => (point.entry ? [i] : []))).toEqual([
      index,
    ]);
    if (index === 62) {
      expect(points[61]!.entry).toBe(false);
      expect(points[62]!.candidate!.date).toBe(input[61]!.date);
    }
    expect(researchVolumeSeries(id, input.slice(0, index))).toEqual(
      points.slice(0, index),
    );
    const future = [
      ...input,
      {
        ...input.at(-1)!,
        date: "2025-01-01",
        close: 1,
        open: 1,
        low: 0.5,
        high: 2,
        volume: 1000000,
      },
    ];
    expect(researchVolumeSeries(id, future).slice(0, input.length)).toEqual(
      points,
    );
    expect(researchMethodSnapshot(id).sources.length).toBeGreaterThanOrEqual(4);
  },
);

it("keeps grey price zones, source-specific bands and denominator conventions distinct", () => {
  expect(classifyVolumePrice(102 / 100 - 1, 0.01, 1.5)).toMatchObject({
    price: "grey",
    volume: "expanded",
  });
  expect(classifyVolumePrice(0.02001, 0.01, 1.5)!.price).toBe("up");
  expect(classifyVolumePrice(0.01, 0.01, 0.8)).toMatchObject({
    price: "flat",
    volume: "normal",
  });
  expect(classifyVolumePrice(-0.02001, 0.01, 0.799)!.volume).toBe("contracted");
  expect(classifyVolumePrice(0, 0.02, 1)!.price).toBe("grey");
  expect(classifyVolumePrice(0, 0, 2.2)).toMatchObject({
    mainBand: "huge",
    detailBand: "expanded",
  });
  expect(classifyVolumePrice(0, 0, 1.3)).toMatchObject({
    mainBand: "normal",
    detailBand: "mild",
  });
  const point = researchVolumeSeries("vp-breakout-1-5", examples[6]![1]).at(
    -1,
  )!;
  expect(point.values.ratio5).toBeCloseTo(150 / 110);
  expect(point.values.ratio20Prior).toBe(1.5);
  expect(
    researchVolumeSeries("vp-breakout-2", examples[6]![1]).at(-1)!.entry,
  ).toBe(false);
});

it("omits suspension rows from volume averages without omitting invalid observations", () => {
  const input = bars([], 0)
    .slice(0, 7)
    .map((bar, i) => ({ ...bar, volume: [10, 20, 0, 30, 40, 50, 60][i]! }));
  expect(volumeMa(input, 3)).toEqual([null, null, null, 20, 30, 40, 50]);
  expect(volumeMa(input, 3, true)).toEqual([
    null,
    null,
    null,
    null,
    20,
    30,
    40,
  ]);
  const invalid = input.map((bar, i) =>
    i === 3 ? { ...bar, volume: NaN } : bar,
  );
  expect(volumeMa(invalid, 3)[5]).toBeNull();
  expect(volumeMa(invalid, 3)[6]).toBe(50);
});

it("expires an unconfirmed plateau, rejects high-location entries, and blocks one-price/resumption interpretations", () => {
  const plateau = bars(
    [
      { close: 100, volume: 300 },
      ...Array.from({ length: 12 }, () => ({ close: 100, volume: 100 })),
    ],
    0,
  );
  const points = researchVolumeSeries("vp-flat-expanded-break", plateau);
  expect(points.some((point) => point.entry)).toBe(false);
  expect(points[71]!.decision).toContain("等待期结束");
  const high = bars(
    [
      { close: 180, volume: 300 },
      { close: 181, volume: 200 },
    ],
    1,
  );
  expect(
    researchVolumeSeries("vp-up-expanded-confirm", high).at(-1)!.values
      .location,
  ).toBe("high");
  expect(
    researchVolumeSeries("vp-up-expanded-confirm", high).some(
      (point) => point.entry,
    ),
  ).toBe(false);
  const resumed = bars(
    Array.from({ length: 7 }, (_, i) => ({
      close: 112 + i * 0.1,
      volume: i === 0 ? 0 : 100,
    })),
  );
  const rows = researchVolumeSeries("vp-volume-ma-cross", resumed);
  expect(rows.slice(61, 67).every((row) => row.reason !== null)).toBe(true);
  expect(rows[67]!.reason).toBeNull();
  const onePrice = examples[0]![1].map((bar, i) =>
    i === 61
      ? { ...bar, open: bar.close, high: bar.close, low: bar.close }
      : bar,
  );
  expect(
    researchVolumeSeries("vp-up-expanded-confirm", onePrice)[61]!.reason,
  ).toContain("一字");
  expect(
    researchVolumeSeries("vp-up-expanded-confirm", onePrice)[62]!.entry,
  ).toBe(false);
});

const native = vi.fn(async () => {
  throw new Error("no native");
});
const rules: ResearchExecutionRules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 10000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 10000,
  sellOddLotAll: true,
  limitUp: null,
  limitDown: null,
  tradable: true,
};
it("freezes the candidate stop, rejects a failed opening gap and exits a false confirmation on the next open", async () => {
  const input = bars([
    { close: 115.36, volume: 300 },
    { close: 116, volume: 200 },
    { close: 117, volume: 100 },
    { close: 114, volume: 100 },
    { close: 113, volume: 100 },
  ]);
  const spec = researchSpecSchema.parse({
    strategy: "vp-up-expanded-confirm",
    start: input[61]!.date,
    end: input[65]!.date,
    validationStart: input[64]!.date,
    holdingDays: 60,
    initialCapital: 100000,
    maxPositions: 1,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const events = await researchSignals("sh600000", input, spec, native);
  expect(events[0]!.observedDate).toBe(input[62]!.date);
  expect(events[0]!.ruleStop!.price).toBeCloseTo(114.86);
  const result = researchPortfolio(
    spec,
    events,
    input.map((bar) => bar.date),
    new Map([["sh600000", input]]),
    () => rules,
  );
  expect(result.trades[0]!.entryDate).toBe(input[63]!.date);
  expect(result.trades[0]!.ruleStopTriggeredAt).toBe(input[64]!.date);
  expect(result.trades[0]!.exitDate).toBe(input[65]!.date);
  expect(result.trades[0]!.profit).toBe(-3200);
  const gap = input.map((bar, i) =>
    i === 63 ? { ...bar, open: 110, low: 109 } : bar,
  );
  const rejected = researchPortfolio(
    spec,
    events,
    input.map((bar) => bar.date),
    new Map([["sh600000", gap]]),
    () => rules,
  );
  expect(rejected.trades).toEqual([]);
  expect(rejected.excluded[0]!.reason).toContain("确认位");
  expect(native).not.toHaveBeenCalled();
});

it("extends the volume history coverage boundary past a long suspension", () => {
  const input = bars(
    Array.from({ length: 100 }, (_, i) => ({
      close: 100,
      volume: i < 80 ? 0 : 100,
    })),
    0,
  );
  // Candidate waiting history starts during suspension; all 20 prior volume
  // observations therefore precede suspension (indices 41 through 60).
  expect(volumeWarmupStart(input, input[145]!.date)).toBe(input[41]!.date);
  expect(volumeStrategyIds).toHaveLength(
    9 + volumeGridIds.length + volumeCompletionIds.length,
  );
});

it("attributes a volume average exit without claiming a candidate stop", () => {
  const input = bars([
    { close: 112.2, volume: 150 },
    ...Array.from({ length: 6 }, (_, i) => ({
      close: 112.4 + i * 0.2,
      volume: 80,
    })),
  ]);
  const points = researchVolumeSeries("vp-volume-ma-cross", input);
  expect(points[61]!.entry).toBe(true);
  expect(points[61]!.ruleStop).toBeUndefined();
  const exit = points.find((point) => point.exit);
  expect(exit?.decision).toBe("有效成交记录VMA5下穿VMA10");
});

it("requires action evidence for candidate warmup and rejects a known pre-period split", async () => {
  const input = bars([
    { close: 115.36, volume: 300 },
    { close: 116, volume: 200 },
    { close: 117, volume: 100 },
    { close: 118, volume: 100 },
    { close: 119, volume: 100 },
    { close: 120, volume: 100 },
  ]);
  const spec = researchSpecSchema.parse({
    strategy: "vp-up-expanded-confirm",
    symbols: ["sh600000"],
    start: input[61]!.date,
    end: input[66]!.date,
    validationStart: input[65]!.date,
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
    hash: "fixed-volume",
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
  expect(result.events).toHaveLength(1);
  expect(result.partitions[0]!.simulation!.trades[0]!.exitDate).toBe(
    input[64]!.date,
  );
  const shortCoverage = {
    ...evidence,
    corporateActionFree: evidence.corporateActionFree.map((row) => ({
      ...row,
      start: spec.start,
    })),
  };
  const missing = await runStrategyResearch(
    spec,
    dataset,
    shortCoverage,
    native,
  );
  // corporateActionFree is legacy evidence metadata the engine no longer
  // consumes; admission runs on prepareResearchAdjustedCoverage instead,
  // which this actions-free dataset satisfies regardless of the window.
  expect(missing.events).toEqual(result.events);
  expect(missing.partitions[0]!.simulation!.trades).toEqual(
    result.partitions[0]!.simulation!.trades,
  );
  const split = {
    ...dataset,
    stocks: dataset.stocks.map((stock) => ({
      ...stock,
      actions: [
        { date: input[50]!.date, category: 1, name: "合成送转", bonusRatio: 1 },
      ],
    })),
  };
  const rejected = await runStrategyResearch(spec, split, evidence, native);
  // A category-1 bonus event without floatSharesBefore/After is a real
  // share-count change GBBQ cannot quantify, so volume comparability stays
  // missing — the reason now names that specifically.
  expect(rejected.events).toEqual([]);
  expect(rejected.exclusions[0]!.reason).toContain("量能可比性无法判定");
  expect(
    rejected.partitions.every((p) => p.simulation!.trades.length === 0),
  ).toBe(true);
});
