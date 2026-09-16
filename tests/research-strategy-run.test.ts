import { expect, it, vi } from "vitest";
import { researchManagementSchema } from "../src/lib/research-management";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { maParamsSchema } from "../src/lib/domain";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";
import { runStrategyResearch } from "../src/server/research-run";
import { researchMethodSnapshot } from "../src/server/research-method";
import {
  researchHash,
  type ResearchDataset,
} from "../src/server/research-dataset";

it("runs MA signals through both research partitions with evidence-backed fills and deterministic saved results", async () => {
  const bars = Array.from({ length: 72 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 10 + i,
    high: 12 + i,
    low: 8 + i,
    close: 10 + i,
    volume: 100,
    amount: (10 + i) * 100,
  }));
  const spec = researchSpecSchema.parse({
    strategy: "ma-cross",
    maParams: maParamsSchema.parse({}),
    symbols: ["sh600000"],
    start: bars[61]!.date,
    end: bars[70]!.date,
    validationStart: bars[66]!.date,
    holdingDays: 1,
    initialCapital: 10000,
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
      warning: "固定合成池，并非真实历史证券池",
    },
    benchmark: { symbol: "sh000001", bars },
    calendar: bars.map((b) => b.date),
    stocks: [
      {
        symbol: "sh600000",
        name: "合成输入",
        bars,
        hash: researchHash(bars),
        actions: [],
      },
    ],
    excluded: [],
    actionCoverage: "partial",
    actionSource: { path: "fixture", modified: 0 },
    capturedAt: 0,
    hash: "fixed-input",
  };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "合成交易规则",
    exportedAt: 0,
    adjustment: "none",
    corporateActionFree: [
      {
        symbol: "sh600000",
        start: spec.start,
        end: spec.end,
        evidenceId: "fixture",
      },
    ],
    rows: bars.map((bar) => ({
      symbol: "sh600000",
      date: bar.date,
      tradable: true,
      limitUp: null,
      limitDown: null,
      minimumBuy: 100,
      buyStep: 100,
      maximumOrder: 100000,
      evidenceId: "fixture",
    })),
  });
  const native = vi.fn(async () => {
    throw new Error("unexpected native call");
  });
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  expect(result.events).toHaveLength(10);
  expect(result.exclusions).toEqual([]);
  expect(result.partitions.map((p) => p.simulation?.statistics.count)).toEqual([
    3, 3,
  ]);
  for (const part of result.partitions) {
    expect(
      part.simulation!.trades.every(
        (trade) => trade.entryDate > trade.event.observedDate,
      ),
    ).toBe(true);
    expect(part.simulation!.nav.every((point) => point.cash >= 0)).toBe(true);
  }
  const withoutEvidence = await runStrategyResearch(
    spec,
    dataset,
    null,
    native,
  );
  expect(withoutEvidence.events).toEqual(result.events);
  expect(withoutEvidence.partitions.map((p) => p.simulation)).toEqual([
    null,
    null,
  ]);
  expect(await runStrategyResearch(spec, dataset, evidence, native)).toEqual(
    result,
  );
  expect(native).not.toHaveBeenCalled();
  const volatilitySpec = {
    ...spec,
    initialCapital: 1000000,
    risk: { fraction: 0.01, maxWeight: 0.2 },
    management: researchManagementSchema.parse({
      trail: { kind: "volatility", profile: "rk-ema20" },
    }),
  };
  const shortProof = await runStrategyResearch(
    volatilitySpec,
    dataset,
    evidence,
    native,
  );
  expect(
    shortProof.partitions.flatMap((p) => p.simulation?.trades ?? []),
  ).toHaveLength(0);
  const fullProof = structuredClone(evidence);
  fullProof.corporateActionFree[0]!.start = bars[0]!.date;
  const fullHistory = await runStrategyResearch(
    volatilitySpec,
    dataset,
    fullProof,
    native,
  );
  expect(
    fullHistory.partitions.flatMap((p) => p.simulation?.trades ?? []).length,
  ).toBeGreaterThan(0);
  expect(result).not.toHaveProperty("method");
  const method = researchMethodSnapshot(spec.strategy);
  const frozen = await runStrategyResearch(
    spec,
    { ...dataset, method },
    evidence,
    native,
  );
  expect(frozen.method).toEqual(method);
  expect(frozen.hash).not.toBe(result.hash);
  const managed = researchSpecSchema.parse({
    ...spec,
    risk: { fraction: 0.05, maxWeight: 1 },
    management: {},
  });
  const managedResult = await runStrategyResearch(
    managed,
    { ...dataset, method: researchMethodSnapshot(spec.strategy, true) },
    evidence,
    native,
  );
  expect(managedResult.events).toEqual(result.events);
  expect(
    managedResult.partitions.every(
      (part) =>
        part.simulation!.trades.length > 0 &&
        part.simulation!.trades.every(
          (trade) => trade.initialStop != null && trade.stopHistory!.length > 0,
        ),
    ),
  ).toBe(true);
  expect(managedResult.method!.management!.version).toBe(
    "research-management-1",
  );
  const scaled = researchSpecSchema.parse({
    ...managed,
    initialCapital: 50000,
    holdingDays: 60,
    management: {
      ...managed.management,
      scaleOut: [{ atR: 0.1, fraction: 0.5, raiseStopR: 0 }],
    },
  });
  const sellEvidence = researchMarketEvidenceSchema.parse({
    ...evidence,
    rows: evidence.rows.map((row) => ({
      ...row,
      minimumSell: 100,
      sellStep: 100,
      maximumSell: 100000,
      sellOddLotAll: true,
    })),
  });
  const scaledResult = await runStrategyResearch(
    scaled,
    { ...dataset, method: researchMethodSnapshot(spec.strategy, true, true) },
    sellEvidence,
    native,
  );
  expect(
    scaledResult.partitions.every((part) =>
      part.simulation!.trades.some(
        (trade) => trade.sales!.length > 0 && trade.remainingQuantity! > 0,
      ),
    ),
  ).toBe(true);
  expect(scaledResult.method!.scaleOut!.version).toBe("research-scale-out-1");
  const protectedSpec = researchSpecSchema.parse({
    ...scaled,
    management: {
      ...scaled.management,
      trail: { kind: "close-atr", period: 2, multiple: 0.5 },
      trailAfterScaleOut: true,
      breakeven: { atR: 1 },
    },
  });
  const protectedResult = await runStrategyResearch(
    protectedSpec,
    { ...dataset, method: researchMethodSnapshot(protectedSpec) },
    sellEvidence,
    native,
  );
  expect(protectedResult.method!.protection!.version).toBe(
    "research-protection-1",
  );
  expect(
    protectedResult.partitions.every((part) =>
      part.simulation!.trades.some((trade) => trade.stopHistory!.length >= 3),
    ),
  ).toBe(true);
  const pyramidSpec = researchSpecSchema.parse({
    ...managed,
    initialCapital: 200000,
    holdingDays: 60,
    management: {
      ...managed.management,
      pyramid: { kind: "r-50-30-20", maxTotalWeight: 0.6 },
      stop: { kind: "percent", fraction: 0.01 },
    },
  });
  const pyramidResult = await runStrategyResearch(
    pyramidSpec,
    { ...dataset, method: researchMethodSnapshot(pyramidSpec) },
    sellEvidence,
    native,
  );
  expect(pyramidResult.method!.pyramid!.version).toBe("research-pyramid-1");
  expect(
    pyramidResult.partitions.every((part) =>
      part.simulation!.trades.some(
        (trade) =>
          trade.entries!.length > 1 &&
          trade.book!.totalQuantity > trade.quantity,
      ),
    ),
  ).toBe(true);
  await expect(
    runStrategyResearch(
      spec,
      { ...dataset, method: { ...method, ruleVersion: "changed" } },
      evidence,
      native,
    ),
  ).rejects.toThrow("方法版本");
});
