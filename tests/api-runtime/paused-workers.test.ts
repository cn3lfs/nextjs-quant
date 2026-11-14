import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { beforeAll, expect, it } from "vitest";
import { migrate } from "~/server/db/migrations";
import { capabilities } from "~/lib/common/capabilities";
import { intradayConfigSchema } from "~/lib/strategy-facts/intraday-schedule";

const root = process.env.QUANT_DATA_DIR!;
const workers = [
  ["intraday", "intraday-worker"],
  ["signalLedger", "signal-ledger-worker"],
] as const;
const now = Date.parse("2025-03-07T15:10:00+08:00");

beforeAll(async () => {
  await build({
    entryPoints: workers.map(([, name]) => `src/server/monitoring/${name}.ts`),
    outdir: root,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["better-sqlite3", "koffi"],
    target: "node22",
    banner: { js: `Date.now = () => ${now};` },
  });
});

it.each(workers)(
  "%s worker refuses direct messages before opening a fresh database",
  async (capability, name) => {
    const directory = join(root, `${name}-fresh`);
    const worker = new Worker(join(root, `${name}.cjs`), {
      env: { ...process.env, QUANT_DATA_DIR: directory },
    });
    try {
      expect(await run(worker)).toEqual({
        type: "done",
        error: capabilities[capability].reason,
      });
      expect(await run(worker)).toEqual({
        type: "done",
        error: capabilities[capability].reason,
      });
      if (capability === "signalLedger") {
        const exited = new Promise<number>((resolve) =>
          worker.once("exit", resolve),
        );
        worker.postMessage({ type: "close" });
        expect(await exited).toBe(0);
      }
      expect(existsSync(join(directory, "quant.sqlite"))).toBe(false);
    } finally {
      await worker.terminate();
    }
  },
);

it.each(workers)(
  "%s worker leaves enabled saved inputs and existing history untouched",
  async (capability, name) => {
    const directory = join(root, `${name}-saved`);
    mkdirSync(directory, { recursive: true });
    const db = new Database(join(directory, "quant.sqlite"));
    migrate(db);
    const insert = db.prepare("INSERT INTO records VALUES (?, ?, ?, 1)");
    insert.run(
      "settings",
      "settings",
      JSON.stringify({
        tdxRoot: join(directory, "empty-tdx"),
        calendar: ["2025-03-07"],
      }),
    );
    insert.run(
      "intraday-config",
      "intraday-config",
      JSON.stringify(intradayConfigSchema.parse({ enabled: true })),
    );
    insert.run(
      "saved-history",
      "signal-ledger-run",
      JSON.stringify({ date: "2025-03-06", status: "completed" }),
    );
    const before = db.prepare("SELECT * FROM records ORDER BY id").all();
    const worker = new Worker(join(root, `${name}.cjs`), {
      env: { ...process.env, QUANT_DATA_DIR: directory },
    });
    try {
      expect(await run(worker)).toEqual({
        type: "done",
        error: capabilities[capability].reason,
      });
      expect(db.prepare("SELECT * FROM records ORDER BY id").all()).toEqual(
        before,
      );
    } finally {
      await worker.terminate();
      db.close();
    }
  },
);

function run(worker: Worker) {
  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("worker response timeout")),
      15000,
    );
    const message = (value: unknown) => finish(undefined, value);
    const errorListener = (value: Error) => finish(value);
    const exit = (code: number) =>
      finish(new Error(`worker exited before response: ${code}`));
    function finish(error?: Error, value?: unknown) {
      clearTimeout(timeout);
      worker
        .off("message", message)
        .off("error", errorListener)
        .off("exit", exit);
      if (error) reject(error);
      else resolve(value);
    }
    worker
      .once("message", message)
      .once("error", errorListener)
      .once("exit", exit);
    worker.postMessage({ type: "run", now });
  });
}
