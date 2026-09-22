import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { backtestCostsSchema } from "~/lib/backtest-costs";
import type {
  calculateDiscipline,
  DisciplineSource,
} from "./discipline-source";
import {
  recordResearchUsage,
  usageConfigHash,
} from "../research/research-usage";
import {
  ResearchAttempts,
  bestEffortAudit,
} from "../research/research-governance";
import { sqlite } from "../db";
import { processAlive } from "../infra/lease";

export const disciplineRequestSchema = z.object({
  account: z.string().trim().min(1),
  openingCash: z.number().finite().nonnegative(),
  stopCosts: backtestCostsSchema.pick({
    commissionBps: true,
    minimumCommission: true,
    sellTaxBps: true,
  }),
});
type Payload = Awaited<ReturnType<typeof calculateDiscipline>>;
type Job = {
  id: string;
  account: string;
  status: "running" | "complete" | "failed" | "cancelled";
  phase: string;
  error: string | null;
  worker?: Worker;
  payload?: Payload;
  usageRecorded: boolean | null;
  timer?: ReturnType<typeof setTimeout>;
  attemptId?: string;
  auditIncomplete?: boolean;
};
const scope = globalThis as typeof globalThis & { disciplineJob?: Job };
// One volatile result, replaced on the next run or discarded after 15 minutes.
// No files, migrations, hidden archives or persistent cleanup obligations.
export function startDiscipline(account: string, source: DisciplineSource) {
  if (scope.disciplineJob?.status === "running")
    throw new Error("已有纪律反事实任务正在运行");
  const id = randomUUID();
  bestEffortAudit(() => new ResearchAttempts(sqlite()).recover(processAlive));
  const dates = [
    ...source.fills.map((fill) => fill.tradeDate),
    ...source.cashFlows.map((flow) => flow.flowDate),
  ].sort();
  const attempt = bestEffortAudit(() =>
    new ResearchAttempts(sqlite()).begin({
      taskId: id,
      kind: "discipline-counterfactual",
      config: source,
      requestedRange: dates.length
        ? { start: dates[0]!, end: dates.at(-1)! }
        : null,
      symbols: [
        ...new Set(source.fills.map((fill) => fill.symbol ?? fill.code)),
      ],
    }),
  );
  let worker: Worker;
  try {
    worker = new Worker(
      resolve(/* turbopackIgnore: true */ "runtime/discipline-worker.cjs"),
      { workerData: source },
    );
  } catch (error) {
    if (attempt)
      bestEffortAudit(() =>
        new ResearchAttempts(sqlite()).update(attempt.id, {
          state: "failed",
          error: "纪律反事实 worker 启动失败",
        }),
      );
    throw error;
  }
  if (scope.disciplineJob?.timer) clearTimeout(scope.disciplineJob.timer);
  const job: Job = {
    id,
    account,
    status: "running",
    phase: "启动",
    error: null,
    worker,
    usageRecorded: null,
    attemptId: attempt?.id,
    auditIncomplete: !attempt,
  };
  if (
    attempt &&
    !bestEffortAudit(() =>
      new ResearchAttempts(sqlite()).update(attempt.id, { state: "running" }),
    )
  )
    job.auditIncomplete = true;
  scope.disciplineJob = job;
  const finish = (status: Job["status"], error: string | null = null) => {
    if (job.status !== "running") return;
    job.status = status;
    job.error = error;
    if (
      job.attemptId &&
      !bestEffortAudit(() =>
        new ResearchAttempts(sqlite()).update(job.attemptId!, {
          state: status === "complete" ? "succeeded" : status,
          error,
          resultId: status === "complete" ? job.id : null,
          auditIncomplete: job.auditIncomplete || job.usageRecorded === false,
        }),
      )
    )
      job.auditIncomplete = true;
    if (job.timer) clearTimeout(job.timer);
    void worker.terminate();
    job.worker = undefined;
    job.timer = setTimeout(() => {
      if (scope.disciplineJob === job) scope.disciplineJob = undefined;
    }, 15 * 60000);
    job.timer.unref();
  };
  job.timer = setTimeout(
    () => finish("failed", "计算超过 10 分钟，已停止，可重试"),
    10 * 60000,
  );
  job.timer.unref();
  worker.on(
    "message",
    (message: {
      type: string;
      phase?: string;
      error?: string;
      value?: Payload;
    }) => {
      if (job.status !== "running") return;
      if (message.type === "progress") job.phase = message.phase ?? job.phase;
      else if (message.type === "complete" && message.value) {
        job.payload = message.value;
        const { result, evidence } = message.value;
        job.usageRecorded =
          recordResearchUsage(
            () => ({
              kind: "discipline-counterfactual",
              symbols: [
                ...new Set(
                  source.fills
                    .filter((f) => f.instrument !== "reverseRepo")
                    .map((f) => f.symbol ?? f.code),
                ),
              ],
              universeSize: null,
              range: {
                start: evidence.input.tradingDays[0]!,
                end: evidence.input.tradingDays.at(-1)!,
              },
              candidateCount: 20,
              config: {
                version: result.version,
                rules: result.points.map((p) => p.rules),
                inputHash: usageConfigHash(evidence.input),
              },
            }),
            job.attemptId,
          ) !== null;
        finish("complete");
      } else if (message.type === "failed")
        finish("failed", message.error ?? "计算失败");
    },
  );
  worker.on("error", (e) => {
    if (job.status === "running") finish("failed", e.message);
  });
  worker.on("exit", () => {
    if (job.status === "running") finish("failed", "计算进程意外退出");
  });
  return { id: job.id };
}
function find(id: string) {
  const job = scope.disciplineJob;
  if (!job || job.id !== id) throw new Error("结果不存在或已过期，请重新运行");
  return job;
}
export function disciplineStatus(id: string) {
  const job = find(id),
    result = job.payload?.result;
  return {
    id,
    account: job.account,
    status: job.status,
    phase: job.phase,
    error: job.error,
    usageRecorded: job.usageRecorded,
    ...(job.attemptId ? { attemptId: job.attemptId } : {}),
    ...(job.auditIncomplete || job.usageRecorded === false
      ? { auditIncomplete: true }
      : {}),
    warnings: job.payload?.evidence.warnings ?? [],
    result: result
      ? {
          ...result,
          points: result.points.map(
            ({
              comparison: _c,
              execution: _e,
              nav: _n,
              diagnostics: _d,
              ...p
            }) => p,
          ),
        }
      : null,
  };
}
export function cancelDiscipline(id: string) {
  const job = find(id);
  if (job.status === "running") {
    if (job.attemptId)
      bestEffortAudit(() =>
        new ResearchAttempts(sqlite()).update(job.attemptId!, {
          state: "cancelled",
        }),
      );
    job.status = "cancelled";
    if (job.timer) clearTimeout(job.timer);
    void job.worker?.terminate();
    job.worker = undefined;
    scope.disciplineJob = undefined;
  }
  return { cancelled: true };
}
export function exportDiscipline(id: string) {
  const job = find(id);
  if (job.status !== "complete") throw new Error("计算尚未完成");
  return JSON.stringify({
    account: job.account,
    usageRecorded: job.usageRecorded,
    ...job.payload,
  });
}
