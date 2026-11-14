import {
  executeMaBaseline,
  type MaBaselineWork,
} from "../backtest/ma-baseline-work";
import { recordResearchUsage } from "../research/research-usage";
import { parentPort } from "node:worker_threads";
import {
  executeLocalFinancialWork,
  type LocalFinancialWork,
} from "../financial/local-financial-work";
import { scan } from "../data-sources/tdx/tdx";
import { readVipdocChart } from "../data-sources/tdx/vipdoc-adapter";
import type { FormulaWork } from "../screening/formula-screening";
import { executeFormulaScreen } from "../screening/formula-screen-work";
import { scanFormulaRange } from "../screening/formula-range";
import type { FormulaShardWork } from "../screening/formula-shards";
import {
  evaluateFactorWork,
  type FactorWork,
} from "../research/factor-evaluation-job";
import type { Period } from "~/lib/domain";
let progressId = 0;
/** Yield SQLite's writer slot until the host has committed this batch's progress. */
function reportSavedBatch() {
  const port = parentPort;
  if (!port) throw new Error("公式快照保存需要计算线程");
  const id = ++progressId;
  return new Promise<void>((resolve, reject) => {
    const acknowledged = (message: { progressAck?: number }) => {
      if (message.progressAck !== id) return;
      port.off("message", acknowledged);
      resolve();
    };
    port.on("message", acknowledged);
    try {
      port.postMessage({
        progress: 95,
        phase: "保存公式候选快照",
        progressId: id,
      });
    } catch (error) {
      port.off("message", acknowledged);
      reject(error);
    }
  });
}
export type Work =
  | LocalFinancialWork
  | MaBaselineWork
  | FormulaWork
  | FormulaShardWork
  | FactorWork
  | { type: "scan"; root: string }
  | { type: "snapshot"; root: string; symbol: string; period: Period };
async function main(work: Work & { attemptId?: string; jobId?: string }) {
  if (work.type === "local-financial")
    return executeLocalFinancialWork(work, (progress, phase) =>
      parentPort?.postMessage({ progress, phase }),
    );
  if (work.type === "ma-baseline") {
    const archive = await executeMaBaseline(work, (progress, phase) =>
      parentPort?.postMessage({ progress, phase }),
    );
    recordResearchUsage(
      () => ({
        kind: "backtest",
        symbols: [work.input.symbol],
        universeSize: 1,
        range: { start: work.input.start, end: work.input.end },
        candidateCount: 1,
        config: {
          engineVersion: archive.result.engineVersion,
          strategyId: archive.result.strategyId,
          input: work.input,
          dataHash: archive.manifest.dataHash,
        },
      }),
      work.attemptId,
    );
    return archive;
  }
  if (work.type === "formula-screen")
    return executeFormulaScreen(
      work,
      work.jobId,
      (progress, phase, workProgress) =>
        parentPort?.postMessage({ progress, phase, workProgress }),
      reportSavedBatch,
    );
  // A range of a parallel formula screen (a nested thread of its worker).
  if (work.type === "formula-shard")
    return scanFormulaRange(
      work,
      work.formula,
      work.securities,
      (processed, errors, excluded) =>
        parentPort?.postMessage({
          shardProgress: { processed, errors, excluded },
        }),
    );
  if (work.type === "factor-eval")
    return evaluateFactorWork(work, (progress, phase, workProgress) =>
      parentPort?.postMessage({ progress, phase, workProgress }),
    );
  if (work.type === "scan") return scan(work.root);
  if (work.type === "snapshot")
    return readVipdocChart(work.root, work.symbol, work.period);
  throw new Error("不支持的计算任务类型");
}
parentPort?.on("message", (work: Work | { progressAck: number }) => {
  if ("progressAck" in work) return;
  void main(work)
    .then((result) => parentPort?.postMessage({ result }))
    .catch((error) =>
      parentPort?.postMessage({
        error: error instanceof Error ? error.message : "计算失败",
      }),
    );
});
