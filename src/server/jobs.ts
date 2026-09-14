import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { get, put, list, sqlite } from "./db";
import type { Job } from "~/lib/domain";
import type { Work } from "./worker";
import { workProgressSchema, type WorkProgress } from "~/lib/work-progress";
import { processAlive } from "./lease";
import { PrioritySlots } from "./priority-slots";
import { unpackScreen, type PackedScreen } from "./screen-wire";
import { ResearchAttempts, bestEffortAudit } from "./research-governance";
import { researchRangeSchema } from "~/lib/research-usage";
const scope = globalThis as typeof globalThis & {
  quantJobs?: {
    workers: Map<string, Worker>;
    idle: Worker[];
    controllers: Map<string, AbortController>;
    slots: PrioritySlots;
    computeControllers: Map<string, AbortController>;
    cancellationTimer?: ReturnType<typeof setInterval>;
  };
};
const state: NonNullable<typeof scope.quantJobs> = (scope.quantJobs ??= {
  workers: new Map(),
  idle: [],
  controllers: new Map(),
  slots: new PrioritySlots(2),
  computeControllers: new Map(),
});
const { workers, controllers } = state;
function watchCancellation() {
  if (state.cancellationTimer) return;
  state.cancellationTimer = setInterval(() => {
    for (const [id, controller] of [
      ...controllers,
      ...state.computeControllers,
    ]) {
      try {
        if (readJob(id)?.status === "cancelled") {
          updateJob(id, {});
          controller.abort();
          void workers.get(id)?.terminate();
        }
      } catch {
        /* A transient database lock is retried on the next tick. */
      }
    }
  }, 250);
  state.cancellationTimer.unref();
}
function stopCancellationWatchIfIdle() {
  if (
    !controllers.size &&
    !state.computeControllers.size &&
    state.cancellationTimer
  ) {
    clearInterval(state.cancellationTimer);
    state.cancellationTimer = undefined;
  }
}
export function readJob(id: string): Job | undefined {
  const row = sqlite()
    .prepare("SELECT payload FROM records WHERE id=? AND kind='job'")
    .get(id) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as Job) : undefined;
}
export function newJob(type: Job["type"], input: unknown): Job {
  const id = `job-${randomUUID()}`,
    now = Date.now();
  const value = input as {
    type?: string;
    start?: string;
    end?: string;
    snapshotId?: string;
  };
  const kind =
    type === "backtest" || type === "walk-forward"
      ? type
      : type === "screen" && value?.type === "formula-screen"
        ? "formula-screen"
        : null;
  const snapshot = value?.snapshotId
    ? get<{ bars: { date: string }[]; symbol: string }>(value.snapshotId)
    : null;
  const range = researchRangeSchema.safeParse({
    start: value?.start ?? snapshot?.bars[0]?.date.slice(0, 10),
    end: value?.end ?? snapshot?.bars.at(-1)?.date.slice(0, 10),
  });
  const attempt = kind
    ? bestEffortAudit(() =>
        new ResearchAttempts(sqlite()).begin({
          taskId: id,
          kind,
          config: input,
          requestedRange: range.success ? range.data : null,
          symbols: snapshot ? [snapshot.symbol] : [],
        }),
      )
    : null;
  return put("job", id, {
    ownerPid: process.pid,
    id,
    type,
    status: "queued",
    progress: 0,
    phase: "等待执行",
    createdAt: now,
    updatedAt: now,
    input,
    ...(kind ? { attemptId: attempt?.id, auditIncomplete: !attempt } : {}),
  });
}
export function updateJob(id: string, patch: Partial<Job>) {
  return sqlite()
    .transaction(() => {
      const job = readJob(id);
      if (!job) return;
      if (["cancelled", "completed", "failed"].includes(job.status)) {
        if (job.attemptId)
          bestEffortAudit(() =>
            new ResearchAttempts(sqlite()).update(job.attemptId!, {
              state:
                job.status === "completed"
                  ? "succeeded"
                  : (job.status as "cancelled" | "failed"),
              error: job.error ?? null,
            }),
          );
        return job;
      }
      const next = { ...job, ...patch, updatedAt: Date.now() };
      if (job.attemptId && patch.status) {
        const audited = bestEffortAudit(() =>
          new ResearchAttempts(sqlite()).update(job.attemptId!, {
            state: patch.status === "completed" ? "succeeded" : patch.status,
            error: patch.error ?? null,
            resultId: patch.status === "completed" ? id : null,
          }),
        );
        if (!audited) next.auditIncomplete = true;
        if (audited?.auditIncomplete) next.auditIncomplete = true;
      }
      return put("job", id, next);
    })
    .immediate();
}
export function cancelJob(id: string) {
  const job = updateJob(id, { status: "cancelled", phase: "已取消" });
  if (job?.status === "cancelled") {
    void workers.get(id)?.terminate();
    controllers.get(id)?.abort();
    state.computeControllers.get(id)?.abort();
  }
}
export function recoverJobs() {
  bestEffortAudit(() => new ResearchAttempts(sqlite()).recover(processAlive));
  for (const job of list<Job>("job", 10000))
    if (
      ["running", "queued"].includes(job.status) &&
      (!job.ownerPid || !processAlive(job.ownerPid))
    )
      updateJob(job.id, {
        status: "failed",
        error: "应用重启中断了任务，可重新运行",
      });
}
export async function runWorker<T>(work: Work, jobId?: string): Promise<T> {
  const requestStarted = performance.now();
  const controller = new AbortController();
  if (jobId) {
    if (state.computeControllers.has(jobId))
      throw new Error("任务已有计算请求");
    state.computeControllers.set(jobId, controller);
    watchCancellation();
    updateJob(jobId, { phase: "等待计算资源" });
    if (readJob(jobId)?.status === "cancelled") controller.abort();
  }
  let release: (() => void) | undefined;
  let worker: Worker | undefined;
  let healthy = true;
  try {
    // Single-security reads take precedence over queued scans/backtests, with
    // aging in PrioritySlots ensuring older bulk work eventually receives a slot.
    release = await state.slots.acquire(
      work.type === "snapshot" ? 1 : 0,
      controller.signal,
    );
    if (jobId && readJob(jobId)?.status === "cancelled")
      throw new Error("任务已取消");
    worker = state.idle.pop();
    if (!worker) {
      // Runtime is explicitly included by next.config.js. Do not trace a dynamic
      // worker directory: it also matches workers inside older release trees.
      worker = Reflect.construct(Worker, [
        join(
          /* turbopackIgnore: true */
          process.env.QUANT_WORKER_DIR ?? join(process.cwd(), "runtime"),
          "worker.cjs",
        ),
      ]) as Worker;
      const created = worker;
      created.on("error", () => {}); // Active requests have their own error handler.
      created.on("exit", () => {
        const index = state.idle.indexOf(created);
        if (index >= 0) state.idle.splice(index, 1);
      });
    }
    const current = worker;
    current.ref();
    if (jobId) {
      workers.set(jobId, current);
      if (
        updateJob(jobId, { status: "running", phase: "计算中" })?.status ===
        "cancelled"
      ) {
        workers.delete(jobId);
        throw new Error("任务已取消");
      }
    }
    return await new Promise<T>((resolve, reject) => {
      let postedAt = 0;
      const cleanup = () => {
        current.off("message", onMessage);
        current.off("error", onError);
        current.off("exit", onExit);
        if (jobId) workers.delete(jobId);
      };
      const onError = (error: Error) => {
        healthy = false;
        cleanup();
        void current.terminate();
        reject(error);
      };
      const onExit = () => onError(new Error("计算任务已中止"));
      const onMessage = (message: {
        progress?: number;
        phase?: string;
        workProgress?: WorkProgress;
        result?: T;
        screenResult?: PackedScreen;
        error?: string;
      }) => {
        const counts = message.workProgress
          ? workProgressSchema.safeParse(message.workProgress)
          : undefined;
        if (counts && !counts.success) {
          onError(new Error("计算线程返回的阶段计数非法"));
          return;
        }
        if (message.progress !== undefined && jobId)
          updateJob(jobId, {
            progress: message.progress,
            phase: message.phase,
            ...(counts?.success ? { workProgress: counts.data } : {}),
          });
        if (message.error) {
          cleanup();
          reject(new Error(message.error));
        } else if (message.screenResult) {
          try {
            const receivedAt = performance.now();
            const result = unpackScreen(message.screenResult, true);
            result.workerTiming = {
              queueMs: postedAt - requestStarted,
              responseWaitMs: receivedAt - postedAt,
              unpackMs: performance.now() - receivedAt,
            };
            cleanup();
            resolve(result as T);
          } catch (error) {
            onError(error as Error);
          }
        } else if ("result" in message) {
          cleanup();
          resolve(message.result as T);
        }
      };
      current.on("message", onMessage);
      current.once("error", onError);
      current.once("exit", onExit);
      try {
        postedAt = performance.now();
        current.postMessage({
          ...work,
          ...(jobId ? { attemptId: readJob(jobId)?.attemptId } : {}),
        });
      } catch (error) {
        onError(error as Error);
      }
    });
  } finally {
    if (worker && healthy && worker.threadId !== -1) {
      worker.unref();
      state.idle.push(worker);
    }
    if (jobId) state.computeControllers.delete(jobId);
    stopCancellationWatchIfIdle();
    release?.();
  }
}

export function background(
  type: Job["type"],
  input: unknown,
  fn: (job: Job, signal: AbortSignal) => Promise<unknown>,
  dedupe?: unknown,
): Job {
  const claim =
    dedupe === undefined
      ? { job: newJob(type, input), created: true }
      : sqlite()
          .transaction(() => {
            const key = `job-key-${createHash("sha256")
              .update(JSON.stringify([type, canonical(dedupe)]))
              .digest("hex")}`;
            const previous = get<{ jobId: string }>(key);
            const existing = previous && readJob(previous.jobId);
            if (
              existing &&
              ["queued", "running"].includes(existing.status) &&
              existing.ownerPid &&
              processAlive(existing.ownerPid)
            )
              return { job: existing, created: false };
            const job = newJob(type, input);
            put("job-key", key, { jobId: job.id });
            return { job, created: true };
          })
          .immediate();
  if (!claim.created) return claim.job;
  const job = claim.job,
    controller = new AbortController();
  controllers.set(job.id, controller);
  watchCancellation();
  void Promise.resolve()
    .then(async () => {
      if (controller.signal.aborted) return;
      if (
        updateJob(job.id, { status: "running", phase: "准备任务" })?.status ===
        "cancelled"
      )
        return;
      const result = await fn(job, controller.signal);
      if (!controller.signal.aborted && readJob(job.id)?.status !== "cancelled")
        updateJob(job.id, {
          status: "completed",
          progress: 100,
          phase: "完成",
          result,
        });
    })
    .catch((error) => {
      if (readJob(job.id)?.status !== "cancelled")
        updateJob(job.id, {
          status: "failed",
          error: error instanceof Error ? error.message : "任务失败",
        });
    })
    .finally(() => {
      controllers.delete(job.id);
      stopCancellationWatchIfIdle();
    });
  return job;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
