import {
  executeMaBaseline,
  type MaBaselineWork,
} from "../backtest/ma-baseline-work";
import { recordResearchUsage } from "../research/research-usage";
import { parentPort } from "node:worker_threads";
import { executePaperTick, type PaperWork } from "../paper/service";
import {
  executePaperBuildReview,
  type PaperBuildReviewWork,
} from "../paper/build-review";
import { executeAlertTick, type AlertTickWork } from "../alerts/tick-work";
import {
  auditBinanceArchive,
  type BinanceArchiveAuditWork,
} from "./binance-archive-audit";
import { executeResearchCommand } from "../research/research-command";
import {
  executeLabBacktest,
  type LabBacktestWork,
} from "../research/lab-backtest";
import type { researchCommandSchema } from "~/lib/research/research-command";
import type { z } from "zod";
import {
  executeLocalFinancialWork,
  type LocalFinancialWork,
} from "../financial/local-financial-work";
import {
  executeFinancialReplayWork,
  type FinancialReplayWork,
} from "../financial/financial-replay-work";
import { scan } from "../data-sources/tdx/tdx";
import {
  executeBinanceBackfill,
  type BinancePublicDataWork,
} from "./binance-public-data-work";

import { readBars } from "~/server/market/bar-store/read-bars";
import type { FormulaWork } from "../screening/formula-screening";
import { executeFormulaScreen } from "../screening/formula-screen-work";
import { scanFormulaRange } from "../screening/formula-range";
import type { FormulaShardWork } from "../screening/formula-shards";
import {
  evaluateFactorWork,
  type FactorWork,
} from "../research/factor-evaluation-job";
import type { Period } from "~/lib/domain";
import {
  executeValidationWork,
  type ValidationWork,
} from "../research/validation-work";
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
  | LabBacktestWork
  | { type: "research-command"; input: z.input<typeof researchCommandSchema> }
  | BinanceArchiveAuditWork
  | PaperWork
  | PaperBuildReviewWork
  | AlertTickWork
  | BinancePublicDataWork
  | ValidationWork
  | LocalFinancialWork
  | FinancialReplayWork
  | MaBaselineWork
  | FormulaWork
  | FormulaShardWork
  | FactorWork
  | { type: "scan"; root: string }
  | { type: "snapshot"; root: string; symbol: string; period: Period };
async function main(work: Work & { attemptId?: string; jobId?: string }) {
  if (work.type === "lab-backtest")
    return executeLabBacktest(work, (progress, phase) =>
      parentPort?.postMessage({ progress, phase }),
    );
  if (work.type === "research-command")
    return executeResearchCommand(work.input);
  if (work.type === "binance-archive-audit")
    return auditBinanceArchive(work, (progress, phase) =>
      parentPort?.postMessage({ progress, phase }),
    );
  if (work.type === "paper-tick") return executePaperTick(work);
  if (work.type === "paper-build-review" || work.type === "paper-build-confirm")
    return executePaperBuildReview(work);
  if (work.type === "alert-tick") return executeAlertTick(work);
  if (work.type === "binance-public-data")
    return executeBinanceBackfill(work, (progress, phase) =>
      parentPort?.postMessage({ progress, phase }),
    );
  if (work.type === "strategy-validation")
    return executeValidationWork(work, (progress, phase) =>
      parentPort?.postMessage({ progress, phase }),
    );
  if (work.type === "local-financial")
    return executeLocalFinancialWork(work, (progress, phase) =>
      parentPort?.postMessage({ progress, phase }),
    );
  if (work.type === "financial-replay")
    return executeFinancialReplayWork(
      work,
      (progress, phase) => parentPort?.postMessage({ progress, phase }),
      { maxRssMiB: 4096 },
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
    return readBars({
      instrument: { market: "cn-equity", symbol: work.symbol },
      root: work.root,
      period: work.period,
      adjustment: "none",
      chartFunds: true,
    });
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
