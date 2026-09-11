import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { sqlite } from "./db";
import { projectCzsc } from "./czsc";
import { ResearchStore } from "./research-store";

const scope = globalThis as typeof globalThis & {
  researchWorker?: {
    id: string;
    worker: Worker;
    cancellation: SharedArrayBuffer;
  };
};
export function recoverResearch() {
  new ResearchStore(sqlite()).recover((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  });
}
export function launchResearch(id: string) {
  try {
    return startResearch(id);
  } catch (error) {
    const store = new ResearchStore(sqlite());
    if (store.task(id)?.status === "queued")
      store.update(id, {
        status: "failed",
        phase: "尚未启动",
        error: error instanceof Error ? error.message : "启动失败",
      });
    throw error;
  }
}
export function startResearch(id: string) {
  if (scope.researchWorker) throw new Error("已有研究正在执行");
  recoverResearch();
  const store = new ResearchStore(sqlite());
  store.db
    .transaction(() => {
      const task = store.task(id);
      if (!task || task.status === "complete" || task.cancelled)
        throw new Error("研究任务不可启动");
      if (store.tasks().some((item) => item.status === "running"))
        throw new Error("已有研究正在执行或待恢复");
      store.update(id, {
        status: "running",
        phase: "准备研究",
        error: null,
        ownerPid: process.pid,
      });
    })
    .immediate();
  const cancellation = new SharedArrayBuffer(4);
  let worker: Worker;
  try {
    worker = new Worker(
      resolve(/* turbopackIgnore: true */ "runtime/research-worker.cjs"),
      { workerData: { id, cancellation } },
    );
  } catch (error) {
    store.update(id, {
      status: "failed",
      error: "研究worker启动失败，请重新构建runtime",
    });
    throw error;
  }
  scope.researchWorker = { id, worker, cancellation };
  let finished = false;
  const finish = (error?: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (error) store.update(id, { status: "failed", error });
    void worker.terminate().finally(() => {
      if (scope.researchWorker?.worker === worker)
        scope.researchWorker = undefined;
    });
  };
  const timer = setTimeout(
    () => finish("研究超时，已保留快照，可重试"),
    30 * 60000,
  );
  worker.on(
    "message",
    (message: {
      type: string;
      id: number;
      args?: Parameters<typeof projectCzsc>;
      error?: string;
    }) => {
      if (message.type === "done") finish(message.error);
      if (message.type === "project" && message.args)
        void projectCzsc(...message.args).then(
          (result) => {
            if (!finished)
              worker.postMessage({
                type: "projection",
                id: message.id,
                result,
              });
          },
          () => {
            if (!finished)
              worker.postMessage({
                type: "projection",
                id: message.id,
                error: "CZSC执行失败",
              });
          },
        );
    },
  );
  worker.once("error", (error) => finish(error.message));
  worker.once("exit", (code) => {
    if (!finished) finish(`研究worker退出 (${code})`);
  });
  return store.task(id)!;
}
export function cancelResearch(id: string) {
  const store = new ResearchStore(sqlite());
  store.cancel(id);
  if (scope.researchWorker?.id === id)
    Atomics.store(new Int32Array(scope.researchWorker.cancellation), 0, 1);
  else if (store.task(id)?.status === "queued")
    store.update(id, { status: "cancelled" });
}
