import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, it } from "vitest";
import { atomic, dataDirectory, sqlite } from "../src/server/db";

it("atomic read-then-write reserves the writer before a concurrent RPS connection can invalidate its WAL snapshot", async () => {
  const db = sqlite();
  db.exec(
    "CREATE TABLE rps_concurrency_probe(value INTEGER); INSERT INTO rps_concurrency_probe VALUES(0)",
  );
  const shared = new SharedArrayBuffer(16),
    signal = new Int32Array(shared);
  const require = createRequire(import.meta.url);
  const worker = new Worker(
    `
    const { workerData, parentPort } = require('node:worker_threads');
    const Database = require(workerData.driver);
    const db = new Database(workerData.path);
    db.pragma('busy_timeout=0');
    const signal = new Int32Array(workerData.shared);
    Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
    Atomics.wait(signal, 1, 0);
    try { db.prepare('UPDATE rps_concurrency_probe SET value=99').run(); Atomics.store(signal, 2, 2); }
    catch (error) { Atomics.store(signal, 2, error.code === 'SQLITE_BUSY' ? 1 : 3); }
    Atomics.notify(signal, 2);
    Atomics.wait(signal, 3, 0);
    db.prepare('UPDATE rps_concurrency_probe SET value=value+1').run();
    db.close(); parentPort.postMessage('done');
  `,
    {
      eval: true,
      workerData: {
        driver: require.resolve("better-sqlite3"),
        path: join(dataDirectory(), "quant.sqlite"),
        shared,
      },
    },
  );
  const finished = new Promise<void>((resolve, reject) => {
    worker.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)),
    );
    worker.once("error", reject);
  });
  try {
    if (Atomics.load(signal, 0) === 0) Atomics.wait(signal, 0, 0, 10000);
    expect(Atomics.load(signal, 0)).toBe(1);
    atomic(() => {
      expect(
        db.prepare("SELECT value FROM rps_concurrency_probe").get(),
      ).toEqual({ value: 0 });
      Atomics.store(signal, 1, 1);
      Atomics.notify(signal, 1);
      if (Atomics.load(signal, 2) === 0) Atomics.wait(signal, 2, 0, 10000);
      expect(Atomics.load(signal, 2)).toBe(1);
      db.prepare("UPDATE rps_concurrency_probe SET value=1").run();
    });
    Atomics.store(signal, 3, 1);
    Atomics.notify(signal, 3);
    await finished;
    expect(db.prepare("SELECT value FROM rps_concurrency_probe").get()).toEqual(
      { value: 2 },
    );
  } finally {
    await worker.terminate();
    await finished.catch(() => {});
    db.close();
  }
});
