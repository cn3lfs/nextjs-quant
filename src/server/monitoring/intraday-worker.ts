import { parentPort } from "node:worker_threads";
import {
  analyzeCzsc,
  type projectCzsc,
  type CzscProjections,
} from "../strategies/chan/czsc";
import { intradayDependencies, runIntradayTick } from "./intraday-service";

let nextId = 0;
const project: typeof projectCzsc = (...args) =>
  new Promise((done, reject) => {
    const id = ++nextId;
    const listener = (message: {
      type: string;
      id?: number;
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
let active = false;
parentPort!.on("message", async (message: { type: string }) => {
  if (message.type !== "run" || active) return;
  active = true;
  try {
    await runIntradayTick(
      intradayDependencies((bars) => analyzeCzsc(bars, true, project)),
    );
    parentPort!.postMessage({ type: "done" });
  } catch (error) {
    parentPort!.postMessage({
      type: "done",
      error: error instanceof Error ? error.message : "预选任务失败",
    });
  } finally {
    active = false;
  }
});
