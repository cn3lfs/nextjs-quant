import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import Database from "better-sqlite3";

it("starts the bundled worker with isolated storage and leaves disabled scans untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "intraday-worker-"));
  const worker = new Worker(resolve("runtime/intraday-worker.cjs"), {
    env: { ...process.env, QUANT_DATA_DIR: directory },
  });
  try {
    const response = await new Promise<unknown>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error("worker timeout")),
        15000,
      );
      worker.once("message", (message) => {
        clearTimeout(timer);
        done(message);
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.postMessage({ type: "run" });
    });
    expect(response).toEqual({ type: "done" });
    await worker.terminate();
    const db = new Database(join(directory, "quant.sqlite"), {
      readonly: true,
    });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM records").get()).toEqual(
        { count: 0 },
      );
    } finally {
      db.close();
    }
  } finally {
    await worker.terminate();
    await rm(directory, { recursive: true, force: true });
  }
});
