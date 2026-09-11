import type { Bar } from "~/lib/domain";
import type { CzscResult } from "~/lib/czsc";
import {
  researchTradeStatistics,
  type ResearchEvent,
  type ResearchSpec,
} from "~/lib/strategy-research";
import {
  researchEvidenceLookup,
  type ResearchMarketEvidence,
} from "~/lib/research-market-evidence";
import { researchSignals } from "./research-signals";
import { researchOutcomes } from "./research-outcomes";
import { researchPortfolio } from "./research-portfolio";
import { researchHash, type ResearchDataset } from "./research-dataset";
import { adjustmentFactors, applyAdjustment } from "./tdx-gbbq";

export async function runStrategyResearch(
  spec: ResearchSpec,
  dataset: ResearchDataset,
  marketEvidence: ResearchMarketEvidence | null,
  czsc: (bars: readonly Bar[]) => Promise<CzscResult>,
  cancelled: () => boolean = () => false,
  progress: (
    symbol: string,
    date: string,
    done: number,
    total: number,
  ) => void = () => {},
) {
  const events: ResearchEvent[] = [];
  const exclusions = [...dataset.excluded];
  const series = new Map(
    dataset.stocks.map((stock) => [stock.symbol, stock.bars]),
  );
  const eventSeries = new Map<string, Bar[]>();
  for (const [index, stock] of dataset.stocks.entries()) {
    if (cancelled()) throw new Error("研究已取消");
    try {
      const observed = await researchSignals(
        stock.symbol,
        stock.bars,
        spec,
        czsc,
        cancelled,
        (date) => progress(stock.symbol, date, index, dataset.stocks.length),
      );
      events.push(...observed);
      // Backward factors are append-stable. This is an adjusted price study,
      // not the cash/share settlement path used for simulated transactions.
      if (dataset.actionCoverage !== "missing")
        eventSeries.set(
          stock.symbol,
          applyAdjustment(
            stock.bars,
            adjustmentFactors(stock.bars, stock.actions),
            "backward",
          ),
        );
      else eventSeries.set(stock.symbol, stock.bars);
    } catch (error) {
      if (cancelled()) throw error;
      exclusions.push({
        symbol: stock.symbol,
        reason: error instanceof Error ? error.message : "策略计算失败",
      });
    }
  }
  const outcomes = researchOutcomes(
    events,
    eventSeries,
    dataset.benchmark.bars,
    dataset.calendar,
    spec.holdingDays,
    dataset.calendar.at(-1) ?? spec.start,
  ).map((outcome) =>
    outcome.event.partition === "development" &&
    outcome.exitDate !== null &&
    outcome.exitDate >= spec.validationStart
      ? {
          ...outcome,
          status: "pending" as const,
          grossReturn: null,
          benchmarkReturn: null,
          excessReturn: null,
          reason: "观察窗口跨入保留验证期，不计入开发期统计",
        }
      : outcome,
  );
  const lookup = marketEvidence
    ? researchEvidenceLookup(marketEvidence)
    : () => null;
  const actionCovered = new Set(
    dataset.stocks
      .filter(
        (stock) =>
          !stock.actions.some(
            (action) =>
              action.date >= spec.start &&
              action.date <= spec.end &&
              action.category === 1,
          ) &&
          marketEvidence?.corporateActionFree.some(
            (coverage) =>
              coverage.symbol === stock.symbol &&
              coverage.start <= spec.start &&
              coverage.end >= spec.end,
          ),
      )
      .map((stock) => stock.symbol),
  );
  const partitions = (["development", "validation"] as const).map(
    (partition) => {
      const sample = outcomes.filter(
        (outcome) => outcome.event.partition === partition,
      );
      const partitionEvents = events.filter(
        (event) => event.partition === partition,
      );
      const start =
        partition === "validation" ? spec.validationStart : spec.start;
      const beforeValidation =
        dataset.calendar.filter((day) => day < spec.validationStart).at(-1) ??
        spec.start;
      const end = partition === "validation" ? spec.end : beforeValidation;
      const simulation = marketEvidence
        ? researchPortfolio(
            { ...spec, start, end },
            partitionEvents,
            dataset.calendar,
            series,
            (symbol, date) =>
              actionCovered.has(symbol) ? lookup(symbol, date) : null,
          )
        : null;
      return {
        partition,
        events: sample.length,
        pending: sample.filter((row) => row.status === "pending").length,
        unavailable: sample.filter((row) => row.status === "unavailable")
          .length,
        eventStatistics: researchTradeStatistics(
          sample.flatMap((row) =>
            row.grossReturn === null ? [] : [row.grossReturn],
          ),
        ),
        simulation,
      };
    },
  );
  const result = {
    version: "strategy-research-result-1" as const,
    spec,
    datasetHash: dataset.hash,
    marketEvidenceHash: marketEvidence ? researchHash(marketEvidence) : null,
    events,
    outcomes,
    partitions,
    exclusions,
    warnings: [
      dataset.membership.warning,
      dataset.actionCoverage === "missing"
        ? "缺少公司行动文件，事件收益为未复权价格观察"
        : "事件收益使用当前文件的后复权因子，公司行动历史覆盖仍不完整",
      "事件观察不等于可成交收益；公司行动无覆盖或存在除权事件的股票不进入交易模拟",
      "导入的历史交易条件是外部来源断言，并未由程序独立验证；费用是固定实验参数",
      "开发期与验证期的资金分别从初始资金开始，跨区间未平仓保留；开发期跨入验证期的事件收益不计入开发期统计",
    ],
  };
  return { ...result, hash: researchHash(result) };
}
