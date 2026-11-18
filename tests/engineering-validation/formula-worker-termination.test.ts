import { expect, it, vi } from "vitest";
import { Worker } from "node:worker_threads";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dataDirectory } from "~/server/db";
import { newJob, runWorker } from "~/server/jobs/jobs";
import {
  createFormulaSnapshotSpool,
  clearFormulaSnapshotSpool,
} from "~/server/screening/formula-snapshot-spool";

it("does not enter host spool cleanup until a real worker and nested writer have stopped", async () => {
  const runtime = join(dataDirectory(), "terminated-worker-fixture");
  await mkdir(runtime, { recursive: true });
  await writeFile(
    join(runtime, "worker.cjs"),
    `
const {parentPort,Worker}=require("node:worker_threads");
parentPort.once("message",work=>{
 const writer=new Worker(\`
  const {parentPort,workerData}=require("node:worker_threads");
  const fs=require("node:fs");
  const fd=fs.openSync(workerData.file,"wx");
  fs.writeSync(fd,"{}\\\\n");
  setInterval(()=>fs.writeSync(fd,"{}\\\\n"),1);
  parentPort.postMessage("writing");
 \`,{eval:true,workerData:{file:require("node:path").join(work.root,"00000000-0000-0000-0000-000000000000.ndjson")}});
 writer.once("message",()=>parentPort.postMessage({workProgress:{invalid:true}}));
});`,
  );
  const job = newJob("screen", { type: "formula-screen" });
  const directory = await createFormulaSnapshotSpool(job.id);
  const previous = process.env.QUANT_WORKER_DIR;
  process.env.QUANT_WORKER_DIR = runtime;
  let observed: Worker | undefined;
  let exited = false;
  const construct = Reflect.construct;
  const observe = vi
    .spyOn(Reflect, "construct")
    .mockImplementation((target, args, newTarget) => {
      const result = construct(target, args, newTarget ?? target);
      if (target === Worker) {
        observed = result as Worker;
        observed.once("exit", () => {
          exited = true;
        });
      }
      return result;
    });
  try {
    await expect(
      runWorker(
        {
          type: "formula-screen",
          root: directory,
          formula: { name: "fixture", source: "选股:C>0;", parameters: {} },
          now: Date.now(),
        },
        job.id,
      ),
    ).rejects.toThrow("阶段计数非法");
    expect(observed).toBeDefined();
    expect(exited).toBe(true);
    expect(observed!.threadId).toBe(-1);
    await clearFormulaSnapshotSpool(job.id);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(existsSync(directory)).toBe(false);
  } finally {
    observe.mockRestore();
    await observed?.terminate();
    await clearFormulaSnapshotSpool(job.id);
    if (previous === undefined) delete process.env.QUANT_WORKER_DIR;
    else process.env.QUANT_WORKER_DIR = previous;
  }
});
