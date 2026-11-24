import {
  executeMaBaseline,
  type MaBaselineWork,
} from "../backtest/ma-baseline-work";
import { recordResearchUsage } from "../research/research-usage";
import {
  runAlphaEvaluation,
  runAlphaTopNBacktest,
  type AlphaWork,
} from "../research/alpha";
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
  replayLabBacktest,
  type FrozenLabBacktest,
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
import type { Period, Settings } from "~/lib/domain";
import type { LabDiagnoseRunInput } from "~/lib/research/diagnose-contract";
import {
  diagnoseWorkerResult,
  runGroupedDiagnoseScenarios,
} from "../research/diagnose/grouped-run";
import type {
  projectCzsc,
  getCurrentCzscIdentity,
} from "../strategies/chan/czsc";
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
export type LabDiagnoseWork = {
  type: "lab-diagnose";
  input: LabDiagnoseRunInput;
  config: Settings;
  stagingDir: string;
  archiveDir?: string;
  jobId: string;
};
export type CzscProjectRequest = {
  requestId: number;
  input: Parameters<typeof projectCzsc>[0];
  request?: Parameters<typeof projectCzsc>[1];
};
type CzscCall =
  { czscProject: CzscProjectRequest } | { czscIdentity: { requestId: number } };
type CzscReply<T> = { requestId: number } & (
  { ok: true; result: T } | { ok: false; error: string }
);
let czscRequestId = 0;

function createWorkerCzscProxy() {
  const port = parentPort;
  if (!port) throw new Error("原生缠论代理需要主线程通道");
  const call = <T>(makeRequest: (id: number) => CzscCall) => {
    const requestId = ++czscRequestId;
    return new Promise<T>((resolve, reject) => {
      const onReply = ({ czscReply }: { czscReply?: CzscReply<T> }) => {
        if (czscReply?.requestId !== requestId) return;
        port.off("message", onReply);
        if (czscReply.ok) resolve(czscReply.result);
        else reject(new Error(czscReply.error));
      };
      port.on("message", onReply);
      try {
        port.postMessage(makeRequest(requestId));
      } catch (error) {
        port.off("message", onReply);
        reject(error);
      }
    });
  };
  const project: typeof projectCzsc = (input, request) =>
    call((requestId) => ({ czscProject: { requestId, input, request } }));
  const resolveIdentity = (): ReturnType<typeof getCurrentCzscIdentity> =>
    call((requestId) => ({ czscIdentity: { requestId } }));
  return { project, resolveIdentity };
}

export type Work =
  | LabDiagnoseWork
  | LabBacktestWork
  | { type: "lab-backtest-replay"; frozen: FrozenLabBacktest }
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
  | AlphaWork
  | FactorWork
  | { type: "scan"; root: string }
  | { type: "snapshot"; root: string; symbol: string; period: Period };
async function main(work: Work & { attemptId?: string; jobId?: string }) {
  if (work.type === "lab-diagnose") {
    const detail = await runGroupedDiagnoseScenarios(work.input, {
      config: work.config,
      archiveDir: work.archiveDir,
      stagingDir: work.stagingDir,
      jobId: work.jobId,
      ...createWorkerCzscProxy(),
      onProgress: (progress, phase) =>
        parentPort?.postMessage({ progress, phase }),
    });
    return diagnoseWorkerResult(detail);
  }
  if (work.type === "lab-backtest-replay")
    return replayLabBacktest(work.frozen, (progress, phase) =>
      parentPort?.postMessage({ progress, phase }),
    );
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
  if (work.type === "factor-eval" && "mode" in work) {
    if (work.mode === "alpha-backtest") {
      const replay = await runAlphaTopNBacktest(work.payload);
      const { snapshot } = work.payload;
      const symbols = [
        ...new Set(
          snapshot.scheduledTargets.flatMap((r) => Object.keys(r.targets)),
        ),
      ];
      recordResearchUsage(
        () => ({
          kind: "backtest",
          symbols: symbols.length ? symbols : ["*"],
          universeSize: symbols.length,
          range: { start: snapshot.start, end: snapshot.end },
          candidateCount: 1,
          config: {
            kind: work.mode,
            snapshotHash: snapshot.snapshotHash,
            initial: work.payload.initial,
            costScenario: work.payload.costScenario,
            riskPolicy: work.payload.riskPolicy,
          },
        }),
        work.attemptId,
      );
      return replay;
    }
    const result = await runAlphaEvaluation(work.payload, (progress, phase) =>
      parentPort?.postMessage({ progress, phase }),
    );
    recordResearchUsage(
      () => ({
        kind: "factor-eval",
        symbols: ["*"],
        universeSize: result.metadata.universe,
        range: {
          start: result.targetSnapshot.start,
          end: result.targetSnapshot.end,
        },
        candidateCount: new Set(
          result.comparisons.map((v) => v.mode + "/" + v.method),
        ).size,
        config: {
          kind: work.mode,
          panelId: result.metadata.panelId,
          input: result.input,
          config: result.config,
        },
      }),
      work.attemptId,
    );
    return result;
  }
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
parentPort?.on(
  "message",
  (work: Work | { progressAck: number } | { czscReply: unknown }) => {
    if ("progressAck" in work || "czscReply" in work) return;
    void main(work)
      .then((result) => parentPort?.postMessage({ result }))
      .catch((error) =>
        parentPort?.postMessage({
          error: error instanceof Error ? error.message : "计算失败",
        }),
      );
  },
);
