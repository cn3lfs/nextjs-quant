import { expect, it, vi } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import { obv } from "../../../../src/lib/indicators";
import {
  researchVolumeContextSeries,
  type VolumeContextId,
} from "../../../../src/lib/research/methods/volume/research-volume-context";
import { researchSpecSchema } from "../../../../src/lib/research/strategy-research";
import { researchSignals } from "../../../../src/server/strategies/shared/research-signals";
import { researchPortfolio } from "../../../../src/server/backtest/research-portfolio";
import { researchMethodSnapshot } from "../../../../src/server/research/research-method";
import { runStrategyResearch } from "../../../../src/server/backtest/research-run";
import {
  researchHash,
  type ResearchDataset,
} from "../../../../src/server/backtest/research-dataset";
import { researchMarketEvidenceSchema } from "../../../../src/lib/research/factors/research-market-evidence";

function fixture(
  tail: { close: number; volume: number }[],
  bottom = false,
): Bar[] {
  return [
    ...Array.from({ length: 90 }, (_, i) => ({
      close: bottom
        ? Math.max(80, 130 - (i * 50) / 59)
        : i >= 86
          ? 117.4
          : 100 + i * 0.2,
      volume: 100,
    })),
    ...tail,
  ].map((b, i) => ({
    ...b,
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: b.close,
    high: b.close + 0.5,
    low: b.close - 0.5,
    amount: b.close * b.volume,
  }));
}
const entries: [VolumeContextId, Bar[], number][] = [
  [
    "vp-obv-high",
    fixture([
      { close: 119, volume: 100 },
      { close: 120, volume: 100 },
      { close: 121, volume: 100 },
    ]),
    90,
  ],
  [
    "vp-stack-3",
    fixture([
      { close: 118, volume: 135 },
      { close: 118.1, volume: 155 },
      { close: 118.2, volume: 180 },
      { close: 119, volume: 100 },
      { close: 120, volume: 100 },
    ]),
    92,
  ],
  [
    "vp-contract-3",
    fixture([
      { close: 117.8, volume: 90 },
      { close: 117.8, volume: 70 },
      { close: 117.8, volume: 50 },
      { close: 119, volume: 300 },
      { close: 120, volume: 100 },
      { close: 121, volume: 100 },
    ]),
    93,
  ],
  [
    "vp-obv-flat",
    fixture([
      ...Array.from({ length: 5 }, (_, i) => ({
        close: 117.45 + i * 0.05,
        volume: 100,
      })),
      { close: 118, volume: 100 },
      { close: 119, volume: 100 },
    ]),
    93,
  ],
  [
    "vp-obv-bottom",
    fixture(
      [
        { close: 78, volume: 20 },
        { close: 79, volume: 130 },
        { close: 80, volume: 100 },
        { close: 81, volume: 100 },
      ],
      true,
    ).map((b, i) =>
      i === 80
        ? { ...b, close: 79, open: 79, high: 79.5, low: 78.5, volume: 1000 }
        : i === 81
          ? { ...b, volume: 300 }
          : b,
    ),
    91,
  ],
];
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
const native = vi.fn(async () => {
  throw new Error("unexpected native");
});
it.each(entries)(
  "%s distinguishes confirmation from candidates and buys only next open",
  async (id, input, index) => {
    const points = researchVolumeContextSeries(id, input);
    expect(points.flatMap((p, i) => (p.entry && i >= 90 ? [i] : []))).toEqual([
      index,
    ]);
    const spec = researchSpecSchema.parse({
      strategy: id,
      start: input[90]!.date,
      end: input.at(-1)!.date,
      validationStart: input.at(-1)!.date,
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
    const events = await researchSignals("sh600000", input, spec, native);
    expect(events).toHaveLength(1);
    const result = researchPortfolio(
      spec,
      events,
      input.map((b) => b.date),
      new Map([["sh600000", input]]),
      () => rules,
    );
    expect(result.trades[0]!.entryDate).toBe(input[index + 1]!.date);
    expect(result.trades[0]!.exitDate).toBe(input[index + 2]!.date);
    expect(result.trades[0]!.profit).toBeGreaterThan(0);
    expect(researchMethodSnapshot(id).sources).toHaveLength(4);
    for (let length = 89; length <= input.length; length++)
      expect(researchVolumeContextSeries(id, input.slice(0, length))).toEqual(
        points.slice(0, length),
      );
    expect(
      researchVolumeContextSeries(id, [
        ...input,
        {
          ...input.at(-1)!,
          date: "2025-12-01",
          close: 1,
          open: 1,
          low: 0.5,
          high: 2,
          volume: 999999,
        },
      ]).slice(0, input.length),
    ).toEqual(points);
  },
);

const huge = fixture([
  { close: 119, volume: 200 },
  { close: 120, volume: 100 },
  { close: 180, volume: 1000 },
  { close: 179, volume: 50 },
  { close: 182, volume: 50 },
  { close: 181, volume: 50 },
]);
const exits: [VolumeContextId, Bar[], number, string][] = [
  [
    "vp-obv-top-exit",
    fixture([
      { close: 119, volume: 200 },
      { close: 120, volume: 100 },
      { close: 119, volume: 1000 },
      { close: 121, volume: 100 },
      { close: 122, volume: 100 },
    ]),
    93,
    "顶背离退出",
  ],
  ["vp-huge-next-exit", huge, 93, "天量后次根缩量且未创新高"],
  ["vp-huge-second-exit", huge, 94, "天量后缩量新高，二顶退出"],
];
it.each(exits)(
  "%s combines the existing entry with its independent exit",
  async (id, input, index, reason) => {
    const points = researchVolumeContextSeries(id, input);
    expect(points[90]!.entry).toBe(true);
    expect(points[index]!.exit).toBe(true);
    expect(points[index]!.decision).toContain(reason);
    expect(points[index - 1]!.exit).toBe(false);
    const spec = researchSpecSchema.parse({
      strategy: id,
      start: input[90]!.date,
      end: input.at(-1)!.date,
      validationStart: input.at(-1)!.date,
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
    const result = researchPortfolio(
      spec,
      events,
      input.map((b) => b.date),
      new Map([["sh600000", input]]),
      () => rules,
    );
    expect(result.trades[0]!.entryDate).toBe(input[91]!.date);
    expect(result.trades[0]!.exitDate).toBe(input[index + 1]!.date);
    expect(result.trades[0]!.signalExit).toEqual(points[index]);
    expect(researchMethodSnapshot(id).sources).toHaveLength(5);
    for (let length = 89; length <= input.length; length++)
      expect(researchVolumeContextSeries(id, input.slice(0, length))).toEqual(
        points.slice(0, length),
      );
  },
);

it("computes OBV signs, leaves ties unchanged, breaks invalid segments and is origin independent", () => {
  const prices = [10, 11, 10, 10, 12, 13, 14],
    volumes = [100, 20, 30, 40, 0, 50, 60];
  const input = fixture([])
    .slice(0, prices.length)
    .map((b, i) => ({ ...b, close: prices[i]!, volume: volumes[i]! }));
  expect(obv(input)).toEqual([0, 20, -10, -10, null, 0, 60]);
  const invalid = input.map((b, i) => (i === 4 ? { ...b, volume: NaN } : b));
  expect(obv(invalid)).toEqual([0, 20, -10, -10, null, 0, 60]);
  const high = entries[0]![1],
    prefixChanged = high.map((b, i) =>
      i < 20 ? { ...b, volume: b.volume * 100 } : b,
    );
  const a = researchVolumeContextSeries("vp-obv-high", high),
    b = researchVolumeContextSeries("vp-obv-high", prefixChanged);
  expect(b[90]!.context.obv).not.toBe(a[90]!.context.obv);
  expect(b.slice(89).map((p) => [p.entry, p.exit])).toEqual(
    a.slice(89).map((p) => [p.entry, p.exit]),
  );
});

it("cancels false confirmations and never bridges a one-price or suspension gap", () => {
  const accelerated = huge.map((b, i) =>
    i === 93 || i === 94
      ? {
          ...b,
          open: 182 + (i - 93) * 2,
          close: 182 + (i - 93) * 2,
          high: 182.5 + (i - 93) * 2,
          low: 181.5 + (i - 93) * 2,
          volume: 1000,
        }
      : i === 95
        ? { ...b, open: 185, close: 185, high: 185.5, low: 184.5 }
        : b,
  );
  const rows = researchVolumeContextSeries("vp-huge-second-exit", accelerated);
  expect(rows[93]!.contextCandidate!.advances).toBe(1);
  expect(rows[94]!.decision).toContain("证伪");
  expect(rows[95]!.exit).toBe(false);
  const contract = entries[2]![1].map((b, i) =>
    i === 92 ? { ...b, low: 110 } : b,
  );
  expect(
    researchVolumeContextSeries("vp-contract-3", contract)
      .slice(90)
      .some((p) => p.entry),
  ).toBe(false);
  for (const volume of [0, NaN]) {
    const input = entries[0]![1].map((b, i) =>
      i === 89 ? { ...b, volume } : b,
    );
    expect(
      researchVolumeContextSeries("vp-obv-high", input)[90]!.reason,
    ).not.toBeNull();
  }
  const one = entries[0]![1].map((b, i) =>
    i === 89 ? { ...b, open: b.close, high: b.close, low: b.close } : b,
  );
  expect(researchVolumeContextSeries("vp-obv-high", one)[90]!.entry).toBe(
    false,
  );
  expect(native).not.toHaveBeenCalled();
});

it("treats equal OBV highs as unconfirmed price highs and requires a genuinely new price high", () => {
  expect(researchVolumeContextSeries("vp-obv-top-exit", huge)[94]!.exit).toBe(
    true,
  );
  const obvNew = huge.map((b, i) => (i === 94 ? { ...b, volume: 51 } : b));
  expect(researchVolumeContextSeries("vp-obv-top-exit", obvNew)[94]!.exit).toBe(
    false,
  );
  const priceTie = huge.map((b, i) =>
    i === 94 ? { ...b, open: 180, close: 180, high: 180.5, low: 179.5 } : b,
  );
  expect(
    researchVolumeContextSeries("vp-obv-top-exit", priceTie)[94]!.context
      .topDivergence,
  ).toBe(false);
});

it("exits sideways OBV distribution and expires a next-day top without confirmation", () => {
  const input = entries[3]![1];
  const declined = [
    ...input,
    ...Array.from({ length: 4 }, (_, i) => ({
      ...input.at(-1)!,
      date: new Date(Date.UTC(2024, 0, input.length + i + 1))
        .toISOString()
        .slice(0, 10),
      close: 118.95 - i * 0.05,
      open: 118.95 - i * 0.05,
      high: 119.45 - i * 0.05,
      low: 118.45 - i * 0.05,
    })),
  ];
  expect(
    researchVolumeContextSeries("vp-obv-flat", declined).at(-1)!.decision,
  ).toContain("连续5根下行");
  expect(
    researchVolumeContextSeries("vp-obv-flat", declined).at(-1)!.exit,
  ).toBe(true);
  const expanded = huge.map((b, i) => (i === 93 ? { ...b, volume: 1000 } : b));
  expect(
    researchVolumeContextSeries("vp-huge-next-exit", expanded)[93]!.decision,
  ).toContain("等待期结束");
});

it("uses extended action coverage for context strategies in the full runner", async () => {
  const input = exits[0]![1],
    spec = researchSpecSchema.parse({
      strategy: "vp-obv-top-exit",
      symbols: ["sh600000"],
      start: input[90]!.date,
      end: input[94]!.date,
      validationStart: input[94]!.date,
      holdingDays: 1,
      initialCapital: 100000,
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
    hash: "fixed-context",
  };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "fixture",
    exportedAt: 0,
    adjustment: "none",
    corporateActionFree: [
      {
        symbol: "sh600000",
        start: input[9]!.date,
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
  expect(result.warnings[0]).toContain("81根价格");
  const short = await runStrategyResearch(
    spec,
    dataset,
    {
      ...evidence,
      corporateActionFree: evidence.corporateActionFree.map((row) => ({
        ...row,
        start: input[19]!.date,
      })),
    },
    native,
  );
  // corporateActionFree is legacy evidence metadata the engine no longer
  // consumes: admission now runs on prepareResearchAdjustedCoverage's price
  // and volume coverage, which this actions-free dataset satisfies
  // regardless of the asserted window.
  expect(short.events).toEqual(result.events);
  expect(short.partitions[0]!.simulation!.trades).toEqual(
    result.partitions[0]!.simulation!.trades,
  );
  const split = await runStrategyResearch(
    spec,
    {
      ...dataset,
      stocks: dataset.stocks.map((stock) => ({
        ...stock,
        actions: [
          {
            date: input[10]!.date,
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
  // A category-1 bonus event carries no floatSharesBefore/After, so it is a
  // real share-count change we cannot quantify from GBBQ — volume
  // comparability genuinely stays missing (this is the safety property the
  // old "any action in window" gate approximated); the reason must now name
  // that specifically instead of blanket "any corporate action present".
  expect(split.events).toEqual([]);
  expect(split.exclusions[0]!.reason).toContain("量能可比性无法判定");
});
