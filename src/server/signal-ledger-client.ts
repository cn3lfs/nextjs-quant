import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { projectCzsc } from "./czsc";
import type { LedgerRun } from "./signal-ledger-store";

export class SignalLedgerWorker {
  private worker?: Worker;
  private active?: Promise<LedgerRun | undefined>;
  run(now: number, progress: (run: LedgerRun) => void = () => {}) {
    if (this.active) return this.active;
    const worker = (this.worker ??= new Worker(
      resolve("runtime/signal-ledger-worker.cjs"),
    ));
    this.active = new Promise<LedgerRun | undefined>((done, reject) => {
      const cleanup = () => {
        worker.off("message", message);
        worker.off("error", failed);
        worker.off("exit", exited);
        this.active = undefined;
      };
      const failed = (error: Error) => {
        cleanup();
        this.worker = undefined;
        reject(error);
      };
      const exited = (code: number) =>
        failed(new Error(`台账 worker 退出 (${code})`));
      const message = (value: {
        type: string;
        run?: LedgerRun;
        id?: number;
        args?: Parameters<typeof projectCzsc>;
      }) => {
        if (value.type === "project" && value.args) {
          // The ledger has only one outstanding request. UI/monitor requests
          // can join the same existing serial queue between symbols.
          void projectCzsc(...value.args).then(
            (result) =>
              worker.postMessage({ type: "projection", id: value.id, result }),
            () =>
              worker.postMessage({
                type: "projection",
                id: value.id,
                error: "CZSC执行失败",
              }),
          );
          return;
        }
        if (value.type === "progress" && value.run) progress(value.run);
        if (value.type === "done") {
          cleanup();
          done(value.run);
        }
      };
      worker.on("message", message).once("error", failed).once("exit", exited);
      worker.postMessage({ type: "run", now });
    });
    return this.active;
  }
  async close() {
    await this.active;
    const worker = this.worker;
    if (!worker) return;
    await new Promise<void>((done) => {
      worker.once("exit", () => done());
      worker.postMessage({ type: "close" });
    });
    this.worker = undefined;
  }
}
const scope = globalThis as typeof globalThis & {
  ledgerWorker?: SignalLedgerWorker;
};
/** Scheduling only posts work; computation and SQLite bookkeeping stay off the monitor loop. */
export function scheduleSignalLedger(now: number) {
  scope.ledgerWorker ??= new SignalLedgerWorker();
  void scope.ledgerWorker.run(now).catch(() => {});
}
