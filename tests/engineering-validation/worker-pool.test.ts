import { expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runWorker,
  newJob,
  cancelJob,
  background,
  updateJob,
} from "../../src/server/jobs/jobs";
import { get } from "../../src/server/db/index";
import type { Job } from "../../src/lib/domain";
const root = mkdtempSync(join(tmpdir(), "quant-worker-pool-"));
process.env.QUANT_DATA_DIR = root;
process.env.QUANT_WORKER_DIR = root;
writeFileSync(
  join(root, "worker.cjs"),
  `
const {parentPort,threadId}=require("node:worker_threads");
parentPort.on("message",work=>{
  if(work.root==="crash") return process.exit(1);
  if(work.root==="error") return parentPort.postMessage({error:"bad input"});
  setTimeout(()=>parentPort.postMessage({result:threadId}),work.root==="long"?10000:work.root==="slow"?100:1);
});`,
);

it("reuses resident workers and bounds concurrent requests to two threads", async () => {
  const first = await runWorker<number>({ type: "scan", root: "fast" });
  expect(await runWorker<number>({ type: "scan", root: "fast" })).toBe(first);
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () =>
      runWorker<number>({ type: "scan", root: "slow" }),
    ),
  );
  expect(new Set(concurrent).size).toBe(2);
});

it("a database cancellation terminates an owned worker before its result arrives", async () => {
  let stopped = false;
  const job = background("scan", {}, async (job) => {
    try {
      return await runWorker({ type: "scan", root: "long" }, job.id);
    } catch (error) {
      stopped = true;
      throw error;
    }
  });
  await vi.waitFor(() => expect(get<Job>(job.id)?.status).toBe("running"));
  // Simulate the persisted action without calling the owner's cancelJob callback.
  updateJob(job.id, { status: "cancelled" });
  await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 3000 });
  expect(get<Job>(job.id)?.status).toBe("cancelled");
  expect(get<Job>(job.id)?.result).toBeUndefined();
  expect(await runWorker({ type: "scan", root: "fast" })).toBeTypeOf("number");
});

it("cancellation stops an active worker and queued cancellation never starts work", async () => {
  const job = newJob("scan", {});
  const running = runWorker({ type: "scan", root: "slow" }, job.id);
  const rejected = expect(running).rejects.toThrow("中止");
  await vi.waitFor(() => expect(get<Job>(job.id)?.status).toBe("running"));
  cancelJob(job.id);
  await rejected;
  const occupied = [
    runWorker({ type: "scan", root: "slow" }),
    runWorker({ type: "scan", root: "slow" }),
  ];
  const queuedJob = newJob("scan", {});
  const queued = runWorker({ type: "scan", root: "crash" }, queuedJob.id);
  const cancelled = expect(queued).rejects.toThrow("取消");
  cancelJob(queuedJob.id);
  await Promise.all(occupied);
  await cancelled;
  expect(await runWorker({ type: "scan", root: "fast" })).toBeTypeOf("number");
});

it("task errors and process crashes do not poison subsequent requests", async () => {
  await expect(runWorker({ type: "scan", root: "error" })).rejects.toThrow(
    "bad input",
  );
  await expect(runWorker({ type: "scan", root: "crash" })).rejects.toThrow(
    "中止",
  );
  expect(await runWorker({ type: "scan", root: "fast" })).toBeTypeOf("number");
});

it("interactive snapshots run ahead of queued bulk work", async () => {
  const occupied = [
    runWorker({ type: "scan", root: "slow" }),
    runWorker({ type: "scan", root: "slow" }),
  ];
  const order: string[] = [];
  const bulk = Array.from({ length: 4 }, (_, i) =>
    runWorker({ type: "scan", root: "slow" }).then(() =>
      order.push(`bulk${i}`),
    ),
  );
  const interactive = runWorker({
    type: "snapshot",
    root: "fast",
    symbol: "sh600519",
    period: "day",
  }).then(() => order.push("interactive"));
  await Promise.all([...occupied, ...bulk, interactive]);
  expect(order[0]).toBe("interactive");
});

it("queued cancellation settles while both workers remain occupied", async () => {
  const owners = [newJob("scan", {}), newJob("scan", {})];
  const occupied = owners.map((job) =>
    runWorker({ type: "scan", root: "long" }, job.id).catch(() => undefined),
  );
  const queuedJob = newJob("scan", {});
  const queued = runWorker({ type: "scan", root: "crash" }, queuedJob.id);
  const rejected = expect(queued).rejects.toThrow("取消");
  let settled = false;
  void queued.catch(() => {
    settled = true;
  });
  updateJob(queuedJob.id, { status: "cancelled" });
  try {
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1500 });
    await rejected;
  } finally {
    owners.forEach((job) => cancelJob(job.id));
    await Promise.all(occupied);
    await rejected;
  }
});
