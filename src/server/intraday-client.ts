import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { projectCzsc } from "./czsc";
import { intradayConfig } from "./intraday-service";

const scope = globalThis as typeof globalThis & {
  intradayActive?: Promise<void>;
  intradayLastTick?: number;
  intradayError?: string | null;
};
export function intradayWorkerStatus() {
  return {
    running: Boolean(scope.intradayActive),
    error: scope.intradayError ?? null,
    lastTick: scope.intradayLastTick ?? null,
  };
}
export function scheduleIntraday(now: number, force = false) {
  if (scope.intradayActive) return scope.intradayActive;
  if (
    !intradayConfig().enabled ||
    (!force && now - (scope.intradayLastTick ?? 0) < 30000)
  )
    return;
  scope.intradayLastTick = now;
  const task = new Promise<void>((done, reject) => {
    // Runtime files are explicitly copied through outputFileTracingIncludes.
    const worker = new Worker(
      resolve(/* turbopackIgnore: true */ "runtime/intraday-worker.cjs"),
    );
    let finished = false;
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      scope.intradayError = error ?? null;
      void worker
        .terminate()
        .then(() => (error ? reject(new Error(error)) : done()), reject);
    };
    const timer = setTimeout(
      () => finish("预选任务超时，未完成批次会保留"),
      15 * 60000,
    );
    worker.on(
      "message",
      (message: {
        type: string;
        id?: number;
        args?: Parameters<typeof projectCzsc>;
        error?: string;
      }) => {
        if (message.type === "done") finish(message.error);
        if (message.type === "project" && message.args) {
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
        }
      },
    );
    worker.once("error", (error) => finish(error.message));
    worker.once("exit", (code) => {
      if (!finished) finish(`预选worker退出 (${code})`);
    });
    worker.postMessage({ type: "run" });
  });
  scope.intradayActive = task.finally(() => {
    scope.intradayActive = undefined;
  });
  // Automatic ticks retain a visible error without an unhandled rejection.
  void scope.intradayActive.catch(() => {});
  return scope.intradayActive;
}
