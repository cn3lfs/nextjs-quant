import { beforeAll, afterAll, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqlite, put } from "../src/server/db";
import { RpsWorkerClient } from "../src/server/rps-client";
import { RpsStore } from "../src/server/rps-store";
import { rpsPeriods } from "../src/lib/rps";
import fixture from "./fixtures/tdx-gbbq.json";

let directory: string;
let root: string;
const prior = process.env.QUANT_DATA_DIR;
const calendar = Array.from({ length: 700 }, (_, i) =>
  new Date(Date.UTC(2000, 0, i + 1)).toISOString().slice(0, 10),
).filter((d) => ![0, 6].includes(new Date(d).getUTCDay()));
const client = new RpsWorkerClient();
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rps-worker-"));
  process.env.QUANT_DATA_DIR = directory;
  root = join(directory, "tdx");
  await build({
    entryPoints: ["src/server/rps-worker.ts"],
    outfile: "runtime/rps-worker.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["better-sqlite3"],
    target: "node22",
  });
  await mkdir(join(root, "vipdoc/sz/lday"), { recursive: true });
  await mkdir(join(root, "T0002/hq_cache"), { recursive: true });
  await writeFile(
    join(root, "T0002/hq_cache/gbbq"),
    Buffer.from(fixture.gbbqBase64, "base64"),
  );
  const names = Buffer.alloc(50 + 360 * 10);
  for (let s = 0; s < 10; s++) {
    const code = `00000${s}`;
    names.write(code, 50 + s * 360, "ascii");
    names.write(`Equity${s}`, 50 + s * 360 + 31, "ascii");
    const bytes = Buffer.alloc(calendar.length * 32);
    calendar.forEach((date, i) => {
      const offset = i * 32,
        price = 1000 + s * i;
      bytes.writeUInt32LE(Number(date.replaceAll("-", "")), offset);
      for (const j of [4, 8, 12, 16]) bytes.writeUInt32LE(price, offset + j);
      bytes.writeFloatLE(price, offset + 20);
      bytes.writeUInt32LE(100, offset + 24);
    });
    await writeFile(join(root, `vipdoc/sz/lday/sz${code}.day`), bytes);
  }
  await writeFile(join(root, "T0002/hq_cache/szs.tnf"), names);
  put("settings", "settings", { tdxRoot: root, calendar });
});
afterAll(async () => {
  await client.close();
  sqlite().close();
  if (prior === undefined) delete process.env.QUANT_DATA_DIR;
  else process.env.QUANT_DATA_DIR = prior;
  // Only this exact mkdtemp-owned path is removed; global setup handles crash leftovers.
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});
it("real worker leaves the caller responsive, reports progress, cancels, then accepts another run", async () => {
  let ticks = 0,
    reports = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const clock = Date.parse(`${calendar.at(-1)}T15:05:00+08:00`);
    const first = client.start({ mode: "backfill", days: 2 }, clock, () => {
      reports++;
      client.cancel();
    });
    expect(() => client.start({ mode: "backfill", days: 2 }, clock)).toThrow(
      "已在运行",
    );
    expect((await first.done).status).toBe("cancelled");
    expect(reports).toBeGreaterThan(0);
    expect(ticks).toBeGreaterThan(0);
    const result = await client.start({ mode: "backfill", days: 2 }, clock)
      .done;
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("complete");
    expect(new RpsStore(sqlite()).latest()!.periods).toEqual([...rpsPeriods]);
    expect(new RpsStore(sqlite()).curve("sz000009")).toHaveLength(2);
  } finally {
    clearInterval(timer);
  }
});

// Explicit opt-in evidence case: no real local-data scan in the ordinary unit suite.
// Uses the same isolated, finally-cleaned database and actual production worker.
if (process.env.RPS_MEASURE_ROOT)
  it("full-market S1 acceptance with 250-day backfill and six distributions", async () => {
    put("settings", "settings", {
      tdxRoot: process.env.RPS_MEASURE_ROOT,
      calendar: [],
    });
    const started = performance.now();
    const result = await client.start(
      { mode: "backfill", days: 250 },
      Date.now(),
    ).done;
    const elapsedMs = performance.now() - started;
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("complete");
    expect(elapsedMs).toBeLessThan(600000);
    const store = new RpsStore(sqlite()),
      latest = store.latest()!;
    const distributions = rpsPeriods.map((period) => {
      const rows = store.ranking(latest.date, period),
        values = rows.map((r) => r.rps).sort((a, b) => a - b);
      const quantile = (p: number) =>
        values[Math.floor((values.length - 1) * p)] ?? null;
      return {
        period,
        count: rows.length,
        min: values[0],
        p25: quantile(0.25),
        median: quantile(0.5),
        p75: quantile(0.75),
        max: values.at(-1),
        over87: values.filter((v) => v > 87).length,
        over90: values.filter((v) => v > 90).length,
      };
    });
    const counts = sqlite()
      .prepare(
        "SELECT count(*) n,sum(length(values_blob)) vectorBytes FROM rps_values",
      )
      .get();
    const queryStart = performance.now();
    expect(store.curve("sh600519").length).toBeGreaterThan(0);
    const curveMs = performance.now() - queryStart;
    const dayStart = performance.now();
    store.ranking(latest.date, 250);
    const rankingMs = performance.now() - dayStart;
    console.log(
      "RPS_S1_MEASUREMENT",
      JSON.stringify({
        date: latest.date,
        elapsedMs,
        total: latest.total,
        pool: latest.pool,
        exclusions: Object.fromEntries(
          Object.entries(latest.excluded).map(([k, v]) => [k, v.length]),
        ),
        missing: latest.missing,
        distributions,
        counts,
        curveMs,
        rankingMs,
        source: latest.source,
      }),
    );
  }, 600000);
