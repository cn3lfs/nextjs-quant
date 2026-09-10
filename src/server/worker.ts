import { parentPort } from "node:worker_threads";
import { scan, readSnapshot } from "./tdx";
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
async function main(work: Work) {
  if (work.type === "formula-screen")
    return screenFormula(work, (progress, phase, workProgress) =>
      parentPort?.postMessage({ progress, phase, workProgress }),
    );
  if (work.type === "walk-forward") {
    const source = work.fullRoot
      ? await fullBacktestSource(work.snapshot, work.fullRoot)
      : work.snapshot;
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
        ),
        corporateActions: await readBacktestActions(
          source,
          work.fullRoot ?? source.dataRoot,
        ),
      },
    };
  }
  if (work.type === "scan") return scan(work.root);
  if (work.type === "snapshot")
    return readSnapshot(work.root, work.symbol, work.period);
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
    const result = backtest(
      source.bars,
      work.strategy,
      source.id,
      work.initial,
      work.costs,
      evaluationStart,
      dividendPlan,
    );
    return {
      source,
      result: {
        ...result,
        corporateActions: await readBacktestActions(
          source,
          work.fullRoot ?? source.dataRoot,
        ),
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
