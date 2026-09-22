import { it, expect } from "vitest";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import Database from "better-sqlite3";
import { closeCzsc } from "../src/server/strategies/chan/czsc";
import { migrate } from "../src/server/db/migrations";
import { SignalLedgerStore } from "../src/server/monitoring/signal-ledger-store";
import { SignalLedgerWorker } from "../src/server/monitoring/signal-ledger-client";
import valid from "./fixtures/breakout-valid.json";

it("resident ledger worker reports progress while the caller ticks, cancels and accepts another job", async () => {
  await build({
    entryPoints: ["src/server/monitoring/signal-ledger-worker.ts"],
    outfile: "runtime/signal-ledger-worker.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["better-sqlite3", "koffi"],
    target: "node22",
  });
  await mkdir(".test-data", { recursive: true });
  const directory = await mkdtemp(resolve(".test-data/n1-worker-"));
  const prior = process.env.QUANT_DATA_DIR;
  process.env.QUANT_DATA_DIR = directory;
  const root = join(directory, "tdx");
  await mkdir(join(root, "vipdoc/bj/lday"), { recursive: true });
  const bytes = Buffer.alloc(valid.bars.length * 32);
  valid.bars.forEach((bar, i) => {
    const offset = i * 32;
    bytes.writeUInt32LE(Number(bar.date.replaceAll("-", "")), offset);
    [bar.open, bar.high, bar.low, bar.close].forEach((v, j) =>
      bytes.writeUInt32LE(Math.round(v * 100), offset + 4 + j * 4),
    );
    bytes.writeFloatLE(bar.amount, offset + 20);
    bytes.writeUInt32LE(bar.volume, offset + 24);
  });
  await writeFile(join(root, "vipdoc/bj/lday/bj920748.day"), bytes);
  const db = new Database(join(directory, "quant.sqlite"));
  db.pragma("journal_mode = WAL");
  migrate(db);
  db.prepare("INSERT INTO records VALUES ('settings','settings',?,1)").run(
    JSON.stringify({ tdxRoot: root, calendar: ["2025-03-07"] }),
  );
  const store = new SignalLedgerStore(db);
  const worker = new SignalLedgerWorker();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    let reports = 0;
    const result = await worker.run(
      Date.parse("2025-03-07T15:05:00+08:00"),
      (run) => {
        reports++;
        store.cancel(run.date);
      },
    );
    expect(result?.status).toBe("cancelled");
    expect(reports).toBeGreaterThan(0);
    expect(ticks).toBeGreaterThan(0);
    expect(store.run("2025-03-07")?.status).toBe("cancelled");
    // Same resident worker handles another request, with no automatic restart.
    expect(await worker.run(Date.parse("2025-03-07T15:06:00+08:00"))).toEqual(
      store.run("2025-03-07"),
    );
  } finally {
    clearInterval(timer);
    await worker.close();
    await closeCzsc();
    db.close();
    if (prior === undefined) delete process.env.QUANT_DATA_DIR;
    else process.env.QUANT_DATA_DIR = prior;
  }
});
