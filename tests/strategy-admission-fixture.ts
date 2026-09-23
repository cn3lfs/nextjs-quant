import valid from "./fixtures/breakout-valid.json";
import { researchSpecSchema } from "../src/lib/research/strategy-research";
import { researchMarketEvidenceSchema } from "../src/lib/research/factors/research-market-evidence";
import {
  researchHash,
  type ResearchDataset,
} from "../src/server/backtest/research-dataset";
import { runStrategyResearch } from "../src/server/backtest/research-run";

/** 复用 e3-browser-fixture / research-worker.test 的固定日线、续接和实验规格。
 * 只在内存运行双突破，不读行情目录、数据库、DLL 或真实账户。
 */
export async function admissionResearchFixture() {
  const bars = structuredClone(valid.bars);
  let time = Date.parse(bars.at(-1)!.date);
  for (let i = 0; i < 10; i++) {
    do {
      time += 86400000;
    } while ([0, 6].includes(new Date(time).getUTCDay()));
    const price = bars.at(-1)!.close;
    bars.push({
      ...bars.at(-1)!,
      date: new Date(time).toISOString().slice(0, 10),
      open: price,
      close: price + 0.1,
      high: price + 0.5,
      low: price - 0.5,
    });
  }
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: bars.at(-12)!.date,
    end: bars.at(-1)!.date,
    validationStart: bars.at(-4)!.date,
    holdingDays: 2,
    pool: null,
  });
  const stock = {
    symbol: "sh600000",
    name: "合成测试",
    bars,
    actions: [],
    hash: researchHash(bars),
  };
  const content = {
    version: "research-dataset-1" as const,
    source: "tdx-local" as const,
    root: "synthetic-in-memory",
    adjustment: "none" as const,
    membership: {
      mode: "current-snapshot" as const,
      symbols: [stock.symbol],
      source: null,
      warning: "合成测试，非市场业绩",
    },
    benchmark: { symbol: "sh000001", bars },
    calendar: bars.map((bar) => bar.date),
    stocks: [stock],
    excluded: [],
    // A GBBQ source is present but reports zero actions for this synthetic
    // stock — "missing" would mean no GBBQ source at all, which the
    // coverage gate in research-adjustment-coverage.ts now correctly
    // excludes every stock for (no price-adjustment coverage can be
    // verified without a source). This fixture is meant to admit its
    // one stock so downstream weight-backtest/admission tests exercise a
    // real trade, so it must assert a present-but-empty source.
    actionCoverage: "partial" as const,
    actionSource: { path: "fixture", modified: 0 },
  };
  const dataset: ResearchDataset = {
    ...content,
    capturedAt: 1,
    hash: researchHash(content),
  };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "synthetic fixture",
    exportedAt: 1,
    adjustment: "none",
    corporateActionFree: [
      {
        symbol: stock.symbol,
        start: spec.start,
        end: spec.end,
        evidenceId: "fixture-no-actions",
      },
    ],
    rows: bars
      .filter((bar) => bar.date >= spec.start)
      .map((bar) => ({
        symbol: stock.symbol,
        date: bar.date,
        tradable: true,
        limitUp: bar.high * 2,
        limitDown: bar.low / 2,
        minimumBuy: 100,
        buyStep: 100,
        maximumOrder: 1000000,
        evidenceId: "fixture",
      })),
  });
  const result = await runStrategyResearch(
    spec,
    dataset,
    evidence,
    async () => {
      throw new Error("双突破合成样本不应调用 DLL");
    },
  );
  return { dataset, result };
}
