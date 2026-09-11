import { parentPort, workerData } from "node:worker_threads";
import { sqlite } from "./db";
import { ResearchStore } from "./research-store";
import { captureResearchDataset } from "./research-dataset";
import { runStrategyResearch } from "./research-run";
import { analyzeCzsc, type projectCzsc, type CzscProjections } from "./czsc";

const data = workerData as { id: string; cancellation: SharedArrayBuffer };
const cancelled = () =>
  Atomics.load(new Int32Array(data.cancellation), 0) !== 0;
let nextId = 0;
const project: typeof projectCzsc = (...args) =>
  new Promise((done, reject) => {
    const id = ++nextId;
    const listener = (message: {
      type: string;
      id: number;
      result: CzscProjections;
      error?: string;
    }) => {
      if (message.type !== "projection" || message.id !== id) return;
      parentPort!.off("message", listener);
      if (message.error) reject(new Error(message.error));
      else done(message.result);
    };
    parentPort!.on("message", listener);
    parentPort!.postMessage({ type: "project", id, args });
  });
async function run() {
  const store = new ResearchStore(sqlite());
  const task = store.task(data.id);
  if (!task) throw new Error("研究任务不存在");
  let lastProgress = 0;
  const progress = (phase: string, completed: number, total: number) => {
    if (Date.now() - lastProgress < 500 && completed !== total) return;
    lastProgress = Date.now();
    store.update(task.id, { phase, completed, total });
  };
  try {
    const dataset =
      store.dataset(task.id) ??
      (await captureResearchDataset(
        task.spec,
        cancelled,
        (symbol, count, total) => progress(`采集 ${symbol}`, count, total),
      ));
    if (cancelled()) throw new Error("研究已取消");
    store.saveDataset(task.id, dataset);
    const result = await runStrategyResearch(
      task.spec,
      dataset,
      store.evidence(task.id),
      (bars) => analyzeCzsc(bars, true, project),
      cancelled,
      (symbol, date, completed, total) =>
        progress(`回放 ${symbol} ${date}`, completed, total),
    );
    if (cancelled()) throw new Error("研究已取消");
    store.finish(task.id, result);
  } catch (error) {
    store.update(task.id, {
      status: cancelled() ? "cancelled" : "failed",
      error: error instanceof Error ? error.message : "研究失败",
    });
  }
  parentPort!.postMessage({ type: "done" });
}
void run().catch((error: unknown) =>
  parentPort!.postMessage({
    type: "done",
    error: error instanceof Error ? error.message : "研究worker失败",
  }),
);
