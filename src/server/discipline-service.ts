import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { backtestCostsSchema } from "~/lib/backtest-costs";
import type {
  calculateDiscipline,
  DisciplineSource,
} from "./discipline-source";
import { recordResearchUsage, usageConfigHash } from "./research-usage";

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
};
const scope = globalThis as typeof globalThis & { disciplineJob?: Job };
// One volatile result, replaced on the next run or discarded after 15 minutes.
// No files, migrations, hidden archives or persistent cleanup obligations.
export function startDiscipline(account: string, source: DisciplineSource) {
  if (scope.disciplineJob?.status === "running")
    throw new Error("已有纪律反事实任务正在运行");
  const worker = new Worker(
    resolve(/* turbopackIgnore: true */ "runtime/discipline-worker.cjs"),
    { workerData: source },
  );
  if (scope.disciplineJob?.timer) clearTimeout(scope.disciplineJob.timer);
  const job: Job = {
    id: randomUUID(),
    account,
    status: "running",
    phase: "启动",
    error: null,
    worker,
    usageRecorded: null,
  };
  scope.disciplineJob = job;
  const finish = (status: Job["status"], error: string | null = null) => {
    job.status = status;
    job.error = error;
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
          recordResearchUsage(() => ({
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
          })) !== null;
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
