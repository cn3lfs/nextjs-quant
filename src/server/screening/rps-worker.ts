import { parentPort, workerData } from "node:worker_threads";
import { sqlite } from "../db";
import { settings } from "../infra/settings";
import { rpsRequestSchema, type RpsProgress } from "~/lib/rps";
import { RpsStore } from "./rps-store";
import { localRpsDependencies, runRpsJob } from "./rps-job";

const input = workerData as {
  request: unknown;
  progress: RpsProgress;
  now: number;
  cancel: SharedArrayBuffer;
};
async function run() {
  try {
    const request = rpsRequestSchema.parse(input.request);
    const config = settings();
    const result = await runRpsJob(
      new RpsStore(sqlite(), request.target),
      localRpsDependencies(
        config.tdxRoot,
        config.calendar,
        config.industryBlocksRoot,
        request.target === "concept" ? "concept" : "industry",
        config.industryMembershipSource,
      ),
      request,
      input.progress,
      input.now,
      (progress) => parentPort!.postMessage(progress),
      () => Atomics.load(new Int32Array(input.cancel), 0) === 1,
    );
    parentPort!.postMessage(result);
  } finally {
    sqlite().close();
    parentPort!.close();
  }
}
void run();
