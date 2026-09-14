import type { ResearchAdjustment } from "~/lib/research-adjustment";
import { recordResearchUsage } from "./research-usage";
import { parentPort } from "node:worker_threads";
import { scan, readSnapshot } from "./tdx";
import { readLocalDailySnapshot } from "./local-daily-snapshot";
import { backtest } from "./quant";
import { screenLocal } from "./screening";
import { screenFormula, type FormulaWork } from "./formula-screening";
import type { PackedScreen } from "./screen-wire";
import { fullBacktestSource } from "./backtest-source";
import { readBacktestActions } from "./backtest-actions";
import { cashDividendWindow } from "./cash-dividend-window";
import { reconciledCashPlan } from "./cash-dividend-plan";
import type { reconcileDividends } from "./dividend-reconciliation";
import type { CashDividendPlan } from "~/lib/cash-dividends";
import { walkForward } from "./walk-forward";
import type { WalkForwardOptions } from "~/lib/walk-forward";
import type { BacktestCosts } from "~/lib/backtest-costs";
import type { Strategy, Candidate, Snapshot, Period } from "~/lib/domain";
export type Work =
  | FormulaWork
  | {
      type: "walk-forward";
      snapshot: Snapshot;
      strategy: Strategy;
      initial: number;
      costs: BacktestCosts;
      options: WalkForwardOptions;
      fullRoot?: string;
    }
  | { type: "scan"; root: string }
  | { type: "snapshot"; root: string; symbol: string; period: Period }
  | {
      type: "screen";
      root: string;
      symbols: string[];
      names?: Record<string, string>;
      period: Period;
      strategy: Strategy;
      asOf?: string;
    }
  | {
      type: "backtest";
      adjustment?: ResearchAdjustment;
      snapshot: Snapshot;
      strategy: Strategy;
      initial: number;
      fullRoot?: string;
      costs?: BacktestCosts;
      cashDividends?: {
        plan: CashDividendPlan;
        start: string;
        end: string;
        review: ReturnType<typeof reconcileDividends>;
      };
    };
async function main(work: Work & { attemptId?: string }) {
  if (work.type === "formula-screen")
    return screenFormula(work, (progress, phase, workProgress) =>
      parentPort?.postMessage({ progress, phase, workProgress }),
    );
  if (work.type === "walk-forward") {
    const source = work.fullRoot
      ? await fullBacktestSource(work.snapshot, work.fullRoot)
      : work.snapshot;
    const corporateActions =
      work.options.adjustment === "backward"
        ? await readBacktestActions(source, work.fullRoot ?? source.dataRoot)
        : undefined;
    return {
      source,
      result: {
        ...walkForward(
          source,
          work.strategy,
          work.initial,
          work.costs,
          work.options,
          (done, total) =>
            parentPort?.postMessage({
              progress: Math.round((done / total) * 100),
              phase: `滚动检验 ${done}/${total}`,
            }),
          corporateActions,
        ),
        corporateActions:
          corporateActions ??
          (await readBacktestActions(source, work.fullRoot ?? source.dataRoot)),
      },
    };
  }
  if (work.type === "scan") return scan(work.root);
  if (work.type === "snapshot")
    return work.period === "day"
      ? readLocalDailySnapshot(work.root, work.symbol)
      : readSnapshot(work.root, work.symbol, work.period);
  if (work.type === "backtest") {
    let source = work.fullRoot
      ? await fullBacktestSource(work.snapshot, work.fullRoot)
      : work.snapshot;
    let evaluationStart = work.strategy.slow;
    let dividendPlan = work.cashDividends?.plan;
    if (work.cashDividends) {
      const window = cashDividendWindow(
        source,
        work.cashDividends.start,
        work.cashDividends.end,
        work.strategy.slow,
      );
      source = window.source;
      evaluationStart = window.evaluationStart;
      dividendPlan = reconciledCashPlan(
        work.cashDividends.review,
        work.cashDividends.plan.taxBps,
        work.cashDividends.start,
        work.cashDividends.end,
        source.bars[Math.max(0, evaluationStart - work.strategy.slow - 2)]!
          .date,
      );
    }
    if (
      work.adjustment === "backward" &&
      (source.period !== "day" || source.adjustment !== "none")
    )
      throw new Error("送转研究需要不复权日线快照");
    const corporateActions =
      work.adjustment === "backward"
        ? await readBacktestActions(source, work.fullRoot ?? source.dataRoot)
        : undefined;
    const result = backtest(
      source.bars,
      work.strategy,
      source.id,
      work.initial,
      work.costs,
      evaluationStart,
      dividendPlan,
      { adjustment: work.adjustment, corporateActions },
    );
    recordResearchUsage(
      () => ({
        kind: "backtest",
        symbols: [source.symbol],
        universeSize: 1,
        range: {
          start: source.bars[0]!.date.slice(0, 10),
          end: source.bars.at(-1)!.date.slice(0, 10),
        },
        candidateCount: 1,
        config: {
          kind: "backtest",
          symbol: source.symbol,
          period: source.period,
          strategy: work.strategy,
          initial: work.initial,
          costs: work.costs,
          ...(work.adjustment ? { adjustment: work.adjustment } : {}),
          cashDividends: dividendPlan
            ? { taxBps: dividendPlan.taxBps, mode: "cash-dividend" }
            : null,
        },
      }),
      work.attemptId,
    );
    return {
      source,
      result: {
        ...result,
        corporateActions:
          corporateActions ??
          (await readBacktestActions(source, work.fullRoot ?? source.dataRoot)),
        dataRange: {
          scope: work.cashDividends
            ? "window"
            : work.fullRoot
              ? "full"
              : "window",
          ...(work.cashDividends ? { warmupBars: evaluationStart } : {}),
          start: source.bars[work.cashDividends ? evaluationStart : 0]!.date,
          end: source.bars.at(-1)!.date,
          bars: source.bars.length - (work.cashDividends ? evaluationStart : 0),
          selectedSnapshotId: work.snapshot.id,
        },
      },
    };
  }
  return screenLocal(
    work,
    (progress, phase, workProgress) =>
      parentPort?.postMessage({ progress, phase, workProgress }),
    true,
  );
}
parentPort?.on("message", (work: Work) => {
  void main(work)
    .then((result) => {
      if (work.type === "screen") {
        const screenResult = result as PackedScreen;
        parentPort?.postMessage({ screenResult }, [
          ...new Set([
            screenResult.values.buffer,
            screenResult.dateIndexes.buffer,
          ]),
        ]);
      } else parentPort?.postMessage({ result });
    })
    .catch((error) =>
      parentPort?.postMessage({
        error: error instanceof Error ? error.message : "计算失败",
      }),
    );
});
