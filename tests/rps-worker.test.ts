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
import { readIndustryBlocks } from "../src/server/industry-blocks";

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

it("industry uses the real shared worker, cancellation and independent six-period storage", async () => {
  const blocksRoot = join(directory, "blocks");
  await mkdir(join(blocksRoot, "申万行业"), { recursive: true });
  await writeFile(
    join(blocksRoot, "申万行业/甲.txt"),
    "SZ000000\r\nSZ000001\r\n",
  );
  await writeFile(
    join(blocksRoot, "申万行业/乙.txt"),
    "SZ000008\r\nSZ000009\r\n",
  );
  await writeFile(join(blocksRoot, "申万行业/空.txt"), "");
  put("settings", "settings", {
    tdxRoot: root,
    calendar,
    industryBlocksRoot: blocksRoot,
  });
  const clock = Date.parse(`${calendar.at(-1)}T15:05:00+08:00`);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const cancelled = await client.start(
      { target: "industry", mode: "backfill", days: 2 },
      clock,
      () => client.cancel(),
    ).done;
    expect(cancelled.status).toBe("cancelled");
    const result = await client.start(
      { target: "industry", mode: "backfill", days: 2 },
      clock,
    ).done;
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("complete");
    expect(result.target).toBe("industry");
    expect(ticks).toBeGreaterThan(0);
    const store = new RpsStore(sqlite(), "industry");
    expect(store.latest()!.counts).toEqual([2, 2, 2, 2, 2, 2]);
    expect(store.latest()!.industry!.snapshot.files).toHaveLength(3);
    expect(store.curve("空")[0]!.values).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(new RpsStore(sqlite()).curve("sz000009")).toHaveLength(2);
  } finally {
    clearInterval(timer);
  }
});

// Opt-in real data evidence; only the test-owned database is written, then removed
// by afterAll. Existing globalSetup recovers crash leftovers after 24 hours.
if (
  process.env.INDUSTRY_RPS_MEASURE_ROOT &&
  process.env.INDUSTRY_RPS_BLOCKS_ROOT
)
  it("S2 local 250-day backfill measures all industries, component exclusions and six distributions", async () => {
    // Remove only the synthetic industry rows in this test-owned database.
    sqlite().exec(
      "DELETE FROM industry_rps_values; DELETE FROM industry_rps_days",
    );
    put("settings", "settings", {
      tdxRoot: process.env.INDUSTRY_RPS_MEASURE_ROOT,
      industryBlocksRoot: process.env.INDUSTRY_RPS_BLOCKS_ROOT,
      calendar: [],
    });
    const before = await readIndustryBlocks(
      process.env.INDUSTRY_RPS_BLOCKS_ROOT!,
    );
    const started = performance.now();
    const result = await client.start({
      target: "industry",
      mode: "backfill",
      days: 250,
    }).done;
    const elapsedMs = performance.now() - started;
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("complete");
    expect(result.completedDays).toBe(250);
    expect(elapsedMs).toBeLessThan(600000);
    const store = new RpsStore(sqlite(), "industry"),
      latest = store.latest()!;
    expect(latest.industry!.snapshot).toEqual(before);
    expect(
      await readIndustryBlocks(process.env.INDUSTRY_RPS_BLOCKS_ROOT!),
    ).toEqual(before);
    const distributions = rpsPeriods.map((period, i) => {
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
        over90: values.filter((v) => v > 90).length,
        validMemberships: latest.industry!.members.reduce(
          (n, m) => n + m.included[i]!,
          0,
        ),
        missingEndpoints: latest.industry!.members.reduce(
          (n, m) => n + m.missing[i]!,
          0,
        ),
        unranked: latest
          .industry!.members.filter((m) => m.empty[i])
          .map((m) => ({ name: m.name, reason: m.empty[i] })),
      };
    });
    const sizes = before.files
      .map((f) => f.members.length)
      .sort((a, b) => a - b);
    console.log(
      "RPS_S2_MEASUREMENT",
      JSON.stringify({
        date: latest.date,
        elapsedMs,
        days: result.completedDays,
        industries: before.files.length,
        componentSizes: {
          min: sizes[0],
          median: sizes[Math.floor((sizes.length - 1) / 2)],
          max: sizes.at(-1),
          total: sizes.reduce((a, b) => a + b, 0),
          unique: new Set(before.files.flatMap((f) => f.members)).size,
        },
        members: before.files.map((f) => ({
          name: f.name,
          count: f.members.length,
        })),
        excluded: latest.industry!.excluded,
        distributions,
        sourceUnchanged: true,
      }),
    );
  }, 600000);

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
