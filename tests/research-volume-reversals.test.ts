import { expect, it, vi } from "vitest";
import type { Bar } from "../src/lib/domain";
import { priorVolumeRange } from "../src/lib/indicators";
import {
  researchVolumeReversalSeries,
  volumeReversalIds,
  volumeReversalWarmupStart,
  type VolumeReversalId,
} from "../src/lib/research-volume-reversals";
import { researchSignals } from "../src/server/research-signals";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchMethodSnapshot } from "../src/server/research-method";
import { runStrategyResearch } from "../src/server/research-run";
import {
  researchHash,
  type ResearchDataset,
} from "../src/server/research-dataset";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";

function fixture(tail: Partial<Bar>[]): Bar[] {
  return [
    ...Array.from({ length: 90 }, (_, i) => ({
      close: Math.max(80, 130 - (i * 50) / 59),
      volume: 100,
    })),
    ...tail,
  ].map((row, i) => {
    const close = row.close!,
      open = "open" in row ? row.open! : close;
    return {
      date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
      open,
      close,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      amount: close * row.volume!,
      volume: row.volume!,
      ...row,
    };
  });
}
function panic(n: number) {
  return fixture([
    { open: 80, close: 77, high: 81, low: 70, volume: 800 },
    ...Array.from({ length: n }, (_, i) => ({
      close: 77.4 + i * 0.2,
      volume: 40,
    })),
    { close: 83, volume: 800 },
    { close: 84, volume: 100 },
    { close: 85, volume: 100 },
  ]);
}
function dry() {
  return fixture([
    { close: 80, volume: 20 },
    { close: 80.1, volume: 130 },
    { close: 81, volume: 300 },
    { close: 82, volume: 100 },
    { close: 83, volume: 100 },
  ]);
}
const examples: [VolumeReversalId, Bar[], number][] = [
  ["vp-panic-2", panic(2), 93],
  ["vp-panic-3", panic(3), 94],
  ["vp-dry-and", dry(), 92],
  ["vp-dry-or", dry(), 92],
];
it.each(examples)(
  "%s completes separate stages, preserves prefixes and fills next open",
  async (id, input, signalIndex) => {
    const points = researchVolumeReversalSeries(id, input);
    expect(points.flatMap((p, i) => (p.entry ? [i] : []))).toEqual([
      signalIndex,
    ]);
    expect(points[90]!.entry).toBe(false);
    expect(points[signalIndex]!.reversal!.date).toBe(input[90]!.date);
    for (let length = 89; length <= input.length; length++)
      expect(researchVolumeReversalSeries(id, input.slice(0, length))).toEqual(
        points.slice(0, length),
      );
    expect(
      researchVolumeReversalSeries(id, [
        ...input,
        {
          ...input.at(-1)!,
          date: "2025-12-01",
          close: 1,
          open: 1,
          high: 2,
          low: 0.5,
          volume: 999999,
        },
      ]).slice(0, input.length),
    ).toEqual(points);
    const native = vi.fn(async () => {
      throw new Error("unexpected native");
    });
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
    expect(events[0]!.ruleStop!.price).toBe(input[90]!.low);
    const result = researchPortfolio(
      spec,
      events,
      input.map((b) => b.date),
      new Map([["sh600000", input]]),
      () => ({
        evidence: "fixture",
        minimumBuy: 100,
        buyStep: 100,
        maximumOrder: 100000,
        minimumSell: 100,
        sellStep: 100,
        maximumSell: 100000,
        sellOddLotAll: true,
        limitUp: null,
        limitDown: null,
        tradable: true,
      }),
    );
    expect(result.trades[0]!.entryDate).toBe(input[signalIndex + 1]!.date);
    expect(result.trades[0]!.exitDate).toBe(input[signalIndex + 2]!.date);
    expect(result.trades[0]!.profit).toBeGreaterThan(0);
    expect(native).not.toHaveBeenCalled();
    expect(researchMethodSnapshot(id).sources).toHaveLength(4);
  },
);

it("preserves the AND/OR disagreement and does not skip the mild-volume stage", () => {
  const input = dry().map((b, i) => (i === 40 ? { ...b, volume: 10 } : b));
  expect(researchVolumeReversalSeries("vp-dry-or", input)[92]!.entry).toBe(
    true,
  );
  expect(
    researchVolumeReversalSeries("vp-dry-and", input).some((p) => p.entry),
  ).toBe(false);
  const skip = dry().map((b, i) => (i === 91 ? { ...b, volume: 300 } : b));
  expect(
    researchVolumeReversalSeries("vp-dry-or", skip).some((p) => p.entry),
  ).toBe(false);
  expect(
    researchVolumeReversalSeries("vp-dry-and", dry())[91]!.reversal!.mildDate,
  ).toBe(dry()[91]!.date);
});

it("cancels broken, interrupted, suspended and unconfirmed candidates", () => {
  for (const changes of [
    { low: 69 },
    { volume: 500 },
    { volume: 0 },
    { open: 77.4, high: 77.4, low: 77.4 },
  ]) {
    const input = panic(2).map((b, i) => (i === 91 ? { ...b, ...changes } : b));
    expect(
      researchVolumeReversalSeries("vp-panic-2", input).some((p) => p.entry),
    ).toBe(false);
  }
  expect(
    researchVolumeReversalSeries("vp-panic-3", panic(2)).some((p) => p.entry),
  ).toBe(false);
  const timeout = fixture([
    { close: 80, volume: 20 },
    ...Array.from({ length: 22 }, () => ({ close: 80, volume: 100 })),
  ]);
  const rows = researchVolumeReversalSeries("vp-dry-and", timeout);
  expect(rows.some((p) => p.entry)).toBe(false);
  expect(rows[110]!.decision).toContain("等待期结束");
});

it("uses prior effective volume ranges and extends coverage over candidate history", () => {
  const input = fixture([])
    .slice(0, 6)
    .map((b, i) => ({ ...b, volume: [10, 20, 0, 30, 40, 50][i]! }));
  expect(priorVolumeRange(input, 3)).toEqual([
    { low: null, high: null },
    { low: null, high: null },
    { low: null, high: null },
    { low: null, high: null },
    { low: 10, high: 30 },
    { low: 20, high: 40 },
  ]);
  expect(
    priorVolumeRange(
      input.map((b, i) => (i === 1 ? { ...b, volume: NaN } : b)),
      3,
    )[4]!.low,
  ).toBeNull();
  const long = fixture(
    Array.from({ length: 100 }, (_, i) => ({
      close: 80,
      volume: i < 80 ? 0 : 100,
    })),
  );
  expect(volumeReversalWarmupStart(long, long[175]!.date)).toBe(long[30]!.date);
  expect(volumeReversalIds).toHaveLength(4);
});

it("requires the longer reversal warmup in the full research runner", async () => {
  const input = [...dry(), { ...dry().at(-1)!, date: "2024-04-05" }];
  const spec = researchSpecSchema.parse({
    strategy: "vp-dry-and",
    symbols: ["sh600000"],
    start: input[90]!.date,
    end: input[95]!.date,
    validationStart: input[95]!.date,
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
    hash: "fixed-reversal",
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
      symbol: "sh600000",
      date: b.date,
      evidenceId: "fixture",
      minimumBuy: 100,
      buyStep: 100,
      maximumOrder: 100000,
      minimumSell: 100,
      sellStep: 100,
      maximumSell: 100000,
      sellOddLotAll: true,
      limitUp: null,
      limitDown: null,
      tradable: true,
    })),
  });
  const native = vi.fn(async () => {
    throw new Error("unexpected native");
  });
  const valid = await runStrategyResearch(spec, dataset, evidence, native);
  expect(valid.partitions[0]!.simulation!.statistics.count).toBe(1);
  expect(valid.warnings[0]).toContain("81根价格");
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
  // consumes; admission runs on prepareResearchAdjustedCoverage instead,
  // which this actions-free dataset satisfies regardless of the window.
  expect(short.events).toEqual(valid.events);
  expect(short.partitions[0]!.simulation!.trades).toEqual(
    valid.partitions[0]!.simulation!.trades,
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
  // A category-1 bonus event without floatSharesBefore/After is a real
  // share-count change GBBQ cannot quantify, so volume comparability stays
  // missing — the reason now names that specifically.
  expect(split.events).toEqual([]);
  expect(split.exclusions[0]!.reason).toContain("量能可比性无法判定");
  expect(native).not.toHaveBeenCalled();
});
