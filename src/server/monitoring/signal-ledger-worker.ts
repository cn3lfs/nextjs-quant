import { parentPort } from "node:worker_threads";
import { sqlite } from "../db";
import { settings } from "../infra/settings";
import { SignalLedgerStore } from "./signal-ledger-store";
import { localLedgerDependencies, runSignalLedger } from "./signal-ledger-job";
import {
  analyzeCzsc,
  type projectCzsc,
  type CzscProjections,
} from "../strategies/chan/czsc";

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
// Resident task worker: all decoding/strategy/GBBQ/SQLite work runs here,
// while raw DLL projections use the application's one existing serial process.
parentPort!.on("message", async (message: { type: string; now: number }) => {
  if (message.type === "close") {
    sqlite().close();
    parentPort!.close();
    return;
  }
  if (message.type !== "run") return;
  const config = settings();
  const deps = localLedgerDependencies(config.tdxRoot, config.calendar);
  deps.czsc = (bars) => analyzeCzsc(bars, true, project);
  const run = await runSignalLedger(
    new SignalLedgerStore(sqlite()),
    deps,
    message.now,
    (run) => parentPort!.postMessage({ type: "progress", run }),
  );
  parentPort!.postMessage({ type: "done", run });
});
