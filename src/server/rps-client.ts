import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { rpsRequestSchema, type RpsRequest, type RpsProgress } from "~/lib/rps";
import { sqlite } from "./db";
import { RpsStore } from "./rps-store";

export class RpsWorkerClient {
  private worker?: Worker;
  private cancellation?: Int32Array;
  private active?: Promise<RpsProgress>;
  start(
    request: RpsRequest,
    now = Date.now(),
    report: (progress: RpsProgress) => void = () => {},
  ) {
    request = rpsRequestSchema.parse(request);
    if (this.worker) throw new Error("RPS任务已在运行");
    const store = new RpsStore(sqlite());
    let progress: RpsProgress = {
      id: randomUUID(),
      mode: request.mode,
      status: "running",
      phase: "启动worker",
      scanned: 0,
      total: 0,
      completedDays: 0,
      totalDays: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (!store.claim(progress)) throw new Error("另一个RPS任务正在运行");
    const cancel = new SharedArrayBuffer(4);
    this.cancellation = new Int32Array(cancel);
    try {
      this.worker = new Worker(resolve("runtime/rps-worker.cjs"), {
        workerData: { request, now, progress, cancel },
      });
    } catch (error) {
      store.finish({
        ...progress,
        status: "failed",
        error: "RPS worker启动失败，请检查运行时构建",
      });
      throw error;
    }
    const worker = this.worker;
    this.active = new Promise<RpsProgress>((done) => {
      const timer = setTimeout(() => {
        progress = {
          ...progress,
          status: "failed",
          error: "RPS任务超过15分钟上限",
        };
        void worker.terminate();
      }, 15 * 60000);
      worker.on("message", (value: RpsProgress) => {
        progress = value;
        report(value);
      });
      worker.once("error", (error) => {
        progress = { ...progress, status: "failed", error: error.message };
      });
      worker.once("exit", () => {
        clearTimeout(timer);
        if (progress.status === "running")
          progress = {
            ...progress,
            status: "failed",
            error: "RPS worker异常退出",
          };
        progress.updatedAt = Date.now();
        store.finish(progress);
        this.worker = undefined;
        this.cancellation = undefined;
        this.active = undefined;
        done(progress);
      });
    });
    return { id: progress.id, done: this.active };
  }
  cancel() {
    if (this.cancellation) Atomics.store(this.cancellation, 0, 1);
    new RpsStore(sqlite()).cancel();
  }
  async close() {
    this.cancel();
    await this.active;
  }
}
const scope = globalThis as typeof globalThis & {
  rpsClient?: RpsWorkerClient;
  rpsAttempt?: string;
};
export const rpsClient = () => (scope.rpsClient ??= new RpsWorkerClient());
/** One attempt per wall-clock day; failure/cancellation is retried explicitly from data management. */
export function scheduleRps(now: number) {
  const local = new Date(now + 8 * 3600000).toISOString(),
    today = local.slice(0, 10);
  if (local.slice(11, 16) < "15:05" || scope.rpsAttempt === today) return;
  const store = new RpsStore(sqlite());
  const progress = store.progress();
  if (progress?.status === "running") return;
  scope.rpsAttempt = today;
  if (
    store.day(today) ||
    (progress?.mode === "forward" &&
      new Date(progress.startedAt + 8 * 3600000).toISOString().slice(0, 10) ===
        today)
  )
    return;
  try {
    rpsClient().start({ mode: "forward", days: 1 }, now);
  } catch {
    /* Persisted job remains inspectable; no automatic retry loop. */
  }
}
