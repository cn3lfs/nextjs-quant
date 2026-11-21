import {
  mkdir,
  writeFile,
  readFile,
  stat,
  utimes,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import samples from "../../fixtures/vipdoc-source-samples.json";
import {
  readSnapshot,
  readTailSnapshot,
  readHistoricalSnapshot,
  adjustmentFactors,
  applyAdjustmentByDate,
  parseGbbq,
} from "tstdx/local";
import actionsFixture from "../../fixtures/tdx-gbbq.json";
import { readBars } from "~/server/market/bar-store/read-bars";
import { BarResourceBudget } from "~/server/market/bar-store/resource-budget";
import {
  cachePath,
  readColumnCache,
  writeColumnCache,
} from "~/server/market/bar-store/column-cache";
import type { Bar } from "~/lib/domain";
import { createHash } from "node:crypto";
import { contentDigest } from "~/server/market/bar-store/content-digest";
import { crc32 } from "node:zlib";

const directory = process.env.QUANT_DATA_DIR!;
it("matches the old TDX codec bar-for-bar, cold/warm, stock/index/fund and day/5m", async () => {
  const root = join(directory, "parity-source");
  for (const sample of samples) {
    const period: "day" | "5m" = sample.period === "day" ? "day" : "5m";
    const parent = join(
      root,
      "vipdoc",
      sample.symbol.slice(0, 2),
      period === "day" ? "lday" : "fzline",
    );
    await mkdir(parent, { recursive: true });
    const file = join(
        parent,
        `${sample.symbol}.${period === "day" ? "day" : "lc5"}`,
      ),
      bytes = Buffer.from(sample.hex, "hex");
    await writeFile(file, bytes);
    const original = await readSnapshot(root, sample.symbol, period, {
      chartFunds: true,
    });
    const input = {
      instrument: { market: "cn-equity" as const, symbol: sample.symbol },
      root,
      period,
      adjustment: "none" as const,
      chartFunds: true,
    };
    const from = original.bars.at(-2)!.date.slice(0, 10);
    const to = original.bars.at(-1)!.date.slice(0, 10);
    const window = await readBars({ ...input, from, to });
    expect(window.bars).toEqual(
      original.bars.filter((bar) => bar.date.slice(0, 10) >= from),
    );
    expect(window.barStore.sourceFingerprint).toBe(original.hash);
    expect(
      readColumnCache(`tdx:${root}:${sample.symbol}:${period}`),
    ).toBeNull();
    const offset = period === "day" ? "Z" : "+08:00";
    const fallback = await readBars({
      ...input,
      from: `${from}T00:00:00${offset}`,
      to: `${to}T23:59:59${offset}`,
    });
    expect(fallback).toEqual({ ...window, createdAt: fallback.createdAt });
    expect((await readBars(input)).bars).toEqual(original.bars);
    const warm = await readBars(input);
    expect(warm.bars).toEqual(original.bars);
    warm.bars[0]!.close = -1;
    expect((await readBars(input)).bars).toEqual(original.bars);
    if (/^sh600/.test(sample.symbol)) {
      expect((await readBars({ ...input, limit: 2 })).bars).toEqual(
        (await readTailSnapshot(root, sample.symbol, period, 2)).bars,
      );
      const end = original.bars.at(-1)!.date.slice(0, 10);
      expect((await readBars({ ...input, limit: 2, to: end })).bars).toEqual(
        (await readHistoricalSnapshot(root, sample.symbol, period, 2, end))
          .bars,
      );
    }
    expect(await readFile(file)).toEqual(bytes);
  }
});
const rows: Bar[] = [10, 9, 10].map((close, i) => ({
  date: `2026-01-0${i + 5}`,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: i * 100,
  amount: i * 1000,
}));
it("fails with a diagnosed count or byte budget and preserves intentional limits", async () => {
  const input = {
    instrument: { market: "cn-equity" as const, symbol: "sh600000" },
    root: directory,
    period: "day" as const,
    adjustment: "none" as const,
    now: Date.parse("2026-01-09"),
  };
  const frozen = {
    id: "budget",
    symbol: "sh600000",
    period: "day" as const,
    source: "tdx-local",
    hash: "budget-fixture",
    adjustment: "none" as const,
    createdAt: 10,
    bars: rows,
  };
  const budget = new BarResourceBudget({ maxBars: 4, maxEstimatedBytes: 1024 });
  expect(
    (await readBars({ ...input, limit: 2 }, frozen, undefined, budget)).bars,
  ).toEqual(rows.slice(-2));
  await expect(
    readBars(input, frozen, undefined, budget),
  ).rejects.toMatchObject({
    code: "BAR_STORE_BUDGET_EXCEEDED",
    diagnostic: {
      stage: "source",
      symbol: "sh600000",
      period: "day",
      retainedBars: 2,
      requestedBars: 3,
      maxBars: 4,
    },
  });
  expect(
    (
      await readBars(
        input,
        { ...frozen, bars: rows.slice(0, 2) },
        undefined,
        budget,
      )
    ).bars,
  ).toHaveLength(2);
  await expect(
    readBars(
      input,
      frozen,
      undefined,
      new BarResourceBudget({ maxBars: 10, maxEstimatedBytes: 767 }),
    ),
  ).rejects.toMatchObject({
    code: "BAR_STORE_BUDGET_EXCEEDED",
    diagnostic: {
      stage: "source",
      requestedBars: 3,
      estimatedBytes: 768,
      maxEstimatedBytes: 767,
    },
  });
  vi.stubEnv("QUANT_BAR_STORE_MAX_BARS", undefined);
  vi.stubEnv("QUANT_BAR_STORE_MAX_ESTIMATED_BYTES", undefined);
  try {
    await expect(
      readBars({ ...input, limit: 2_000_001 }, frozen),
    ).rejects.toMatchObject({
      code: "BAR_STORE_BUDGET_EXCEEDED",
      diagnostic: { stage: "limit", maxBars: 2_000_000 },
    });
    vi.stubEnv("QUANT_BAR_STORE_MAX_BARS", "2");
    await expect(readBars(input, frozen)).rejects.toMatchObject({
      code: "BAR_STORE_BUDGET_EXCEEDED",
      diagnostic: { stage: "source", maxBars: 2, maxEstimatedBytes: 512 },
    });
  } finally {
    vi.unstubAllEnvs();
  }
  const raised = new BarResourceBudget({ maxBars: 2_000_001 });
  expect(
    (await readBars({ ...input, limit: 2_000_001 }, frozen, undefined, raised))
      .bars,
  ).toEqual(rows);
  await expect(
    readBars(
      { ...input, freezeRaw: true },
      frozen,
      undefined,
      new BarResourceBudget({ maxBars: 5 }),
    ),
  ).rejects.toMatchObject({
    code: "BAR_STORE_BUDGET_EXCEEDED",
    diagnostic: { stage: "output", retainedBars: 0, requestedBars: 6 },
  });
});
it("rejects both smaller and larger checksum-valid counts before returning a decoded generation", async () => {
  const key = "cache-decoded-count";
  writeColumnCache(key, rows, "count-input", { source: "fixture" });
  const file = cachePath(key),
    original = await readFile(file);
  for (const count of [rows.length - 1, rows.length + 1]) {
    const body = Buffer.from(original);
    const metadata = JSON.parse(
      body.toString("utf8", 16, 16 + body.readUInt32LE(12)),
    );
    metadata.count = count;
    const json = Buffer.from(JSON.stringify(metadata));
    body.fill(0, 16, 16384);
    body.writeUInt32LE(json.length, 12);
    json.copy(body, 16);
    body.writeUInt32LE(crc32(json), 16380);
    await writeFile(file, body);
    expect(() => readColumnCache(key)).toThrow("缓存记录数不符");
  }
  await writeFile(file, original);
  expect(readColumnCache(key)?.bars).toEqual(rows);
});
it("rejects an oversized sparse cache before allocating its body", async () => {
  const key = "cache-oversized-file";
  writeColumnCache(key, rows, "bounded-input", { source: "fixture" });
  await truncate(cachePath(key), 128 * 1024 ** 2 + 1);
  expect(() => readColumnCache(key)).toThrow("单文件容量超限");
});
it("probes every byte even when the entire filesystem identity remains identical", () => {
  const bytes = Buffer.alloc(16384, 7);
  const identity = "same-path-inode-size-mtime-ctime-birthtime";
  const digest = () => createHash("sha256").update(bytes).digest("hex");
  let previous = contentDigest(identity, bytes);
  expect(previous).toBe(digest());
  for (const at of [0, 8192, bytes.length - 1]) {
    bytes[at] = bytes[at]! ^ 1;
    const next = contentDigest(identity, bytes);
    expect(next).not.toBe(previous);
    expect(next).toBe(digest());
    expect(contentDigest(identity, bytes)).toBe(next);
    previous = next;
  }
});
it("upgrades a SHA256-verified v1 header without changing its columns and detects metadata corruption", async () => {
  const key = "cache-v1-upgrade";
  writeColumnCache(key, rows, "v1-input", { source: "fixture" });
  const file = cachePath(key);
  const body = await readFile(file);
  const metadata = JSON.parse(
    body.toString("utf8", 16, 16 + body.readUInt32LE(12)),
  );
  delete metadata.checksum;
  const json = Buffer.from(JSON.stringify(metadata));
  body.fill(0, 0, 16384);
  body.write("QBARCOL1");
  body.writeUInt32LE(1, 8);
  body.writeUInt32LE(json.length, 12);
  json.copy(body, 16);
  await writeFile(file, body);
  expect(readColumnCache(key)?.bars).toEqual(rows);
  const upgraded = await readFile(file);
  expect(upgraded.readUInt32LE(8)).toBe(2);
  expect(upgraded.subarray(16384)).toEqual(body.subarray(16384));
  upgraded[40] = upgraded[40]! ^ 1;
  await writeFile(file, upgraded);
  expect(() => readColumnCache(key)).toThrow("头部校验");
});
it("appends column blocks, replaces corrections, detects corruption and preserves timestamp labels exactly", async () => {
  const key = "cache-parity";
  writeColumnCache(key, rows.slice(0, 2), "v1", { source: "fixture" });
  const before = await readFile(cachePath(key));
  writeColumnCache(key, rows, "v2", { source: "fixture" });
  const after = await readFile(cachePath(key));
  expect(after.subarray(16384, before.length)).toEqual(before.subarray(16384));
  expect(after.length).toBe(before.length + 64);
  expect(readColumnCache(key)?.bars).toEqual(rows);
  const corrected = rows.map((b) => ({ ...b, close: b.open + 0.25 }));
  writeColumnCache(key, corrected, "v3", {});
  expect(readColumnCache(key)?.bars).toEqual(corrected);
  const bytes = await readFile(cachePath(key));
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  await writeFile(cachePath(key), bytes);
  expect(() => readColumnCache(key)).toThrow("校验");
  for (const date of [
    "2022-11-30T15:00:00+08:00",
    "2026-01-01T01:00:00+00:00",
    "2026-01-01T01:00:00.000Z",
    "2026-01-01T01:00:00Z",
  ]) {
    writeColumnCache(`time:${date}`, [{ ...rows[0]!, date }], "time", {});
    expect(readColumnCache(`time:${date}`)?.bars[0]?.date).toBe(date);
  }
});
it("source replacement invalidates the cache even at identical size and includes changed OHLC", async () => {
  const root = join(directory, "replacement"),
    parent = join(root, "vipdoc/sh/lday");
  await mkdir(parent, { recursive: true });
  const sample = samples.find(
    (s) => s.symbol === "sh600000" && s.period === "day",
  )!;
  const file = join(parent, "sh600000.day"),
    bytes = Buffer.from(sample.hex, "hex");
  await writeFile(file, bytes);
  const input = {
    instrument: { market: "cn-equity" as const, symbol: sample.symbol },
    root,
    period: "day" as const,
    adjustment: "none" as const,
  };
  const first = await readBars(input);
  const before = await stat(file);
  bytes.writeUInt32LE(bytes.readUInt32LE(16) + 1, 16);
  await writeFile(file, bytes);
  expect((await stat(file)).size).toBe(before.size);
  const next = await readBars(input);
  expect(next.bars[0]!.close).toBe(first.bars[0]!.close + 0.01);
  expect(next.hash).not.toBe(first.hash);
});
it("GBBQ arithmetic has the required forward denominator and causal backward prefix", () => {
  const factors = adjustmentFactors(rows, [
    { date: rows[1]!.date, category: 1, name: "fixture", dividend: 1 },
  ]);
  expect(factors.map((f) => f.factor)).toEqual([1, 10 / 9, 10 / 9]);
  expect(
    applyAdjustmentByDate(rows, factors, "forward").map((b) => b.close),
  ).toEqual([9, 9, 10]);
  expect(
    applyAdjustmentByDate(rows, factors, "backward").map((b) => b.close),
  ).toEqual([10, 10, (10 * 10) / 9]);
});
it("detects same-size, restored-mtime corrections anywhere in a long source and rebuilds damaged cache", async () => {
  const root = join(directory, "same-time-source");
  const parent = join(root, "vipdoc/sh/lday");
  await mkdir(parent, { recursive: true });
  const file = join(parent, "sh600000.day");
  const bytes = Buffer.alloc(512 * 32);
  for (let i = 0; i < 512; i++) {
    const day = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
    const at = i * 32;
    bytes.writeUInt32LE(Number(day.replaceAll("-", "")), at);
    [1000, 1100, 900, 1000].forEach((v, n) =>
      bytes.writeUInt32LE(v, at + 4 + n * 4),
    );
    bytes.writeFloatLE(10000, at + 20);
    bytes.writeUInt32LE(1000, at + 24);
  }
  await writeFile(file, bytes);
  const input = {
    instrument: { market: "cn-equity" as const, symbol: "sh600000" },
    root,
    period: "day" as const,
    adjustment: "none" as const,
  };
  await utimes(file, 1700000000, 1700000000);
  let previous = await readBars(input);
  const original = await stat(file);
  for (const i of [0, 256, 511]) {
    bytes.writeUInt32LE(1001, i * 32 + 16);
    await writeFile(file, bytes);
    await utimes(file, original.atime, original.mtime);
    expect((await stat(file)).mtimeMs).toBe(original.mtimeMs);
    const next = await readBars(input);
    expect(next.bars[i]!.close).toBe(10.01);
    expect(next.hash).not.toBe(previous.hash);
    previous = next;
  }
  const path = cachePath(`tdx:${root}:sh600000:day`);
  for (const position of [0, 16384 + 100, (await stat(path)).size - 1]) {
    const body = await readFile(path);
    body[position] = body[position]! ^ 1;
    await writeFile(path, body);
    expect((await readBars(input)).bars).toEqual(previous.bars);
    expect(readColumnCache(`tdx:${root}:sh600000:day`)?.bars).toEqual(
      previous.bars,
    );
  }
});
it("adjusts actual Store reads with GBBQ factors before limit/from and excludes future events at a historical cutoff", async () => {
  const root = join(directory, "adjustment-source");
  const blob = Buffer.from(actionsFixture.gbbqBase64, "base64");
  const events = parseGbbq(blob).get("sz000001")!;
  const action = events.find((e) => e.category === 1)!;
  const bars = [-1, 0, 1].map((n, i) => ({
    ...rows[i]!,
    date: new Date(Date.parse(action.date) + n * 86400000)
      .toISOString()
      .slice(0, 10),
  }));
  const bytes = Buffer.alloc(96);
  bars.forEach((bar, i) => {
    const at = i * 32;
    bytes.writeUInt32LE(Number(bar.date.replaceAll("-", "")), at);
    [bar.open, bar.high, bar.low, bar.close].forEach((v, col) =>
      bytes.writeUInt32LE(v * 100, at + 4 + col * 4),
    );
    bytes.writeFloatLE(bar.amount, at + 20);
    bytes.writeUInt32LE(bar.volume, at + 24);
  });
  await mkdir(join(root, "vipdoc/sz/lday"), { recursive: true });
  await mkdir(join(root, "T0002/hq_cache"), { recursive: true });
  await writeFile(join(root, "vipdoc/sz/lday/sz000001.day"), bytes);
  await writeFile(join(root, "T0002/hq_cache/gbbq"), blob);
  const input = {
    instrument: { market: "cn-equity" as const, symbol: "sz000001" },
    root,
    period: "day" as const,
  };
  const factors = adjustmentFactors(bars, events);
  for (const adjustment of ["forward", "backward"] as const) {
    const actual = await readBars({ ...input, adjustment });
    expect(actual.bars).toEqual(
      applyAdjustmentByDate(bars, factors, adjustment),
    );
    expect(actual.barStore.adjustment).toBe(adjustment);
    expect((await readBars({ ...input, adjustment, limit: 1 })).bars).toEqual(
      actual.bars.slice(-1),
    );
    expect(
      (await readBars({ ...input, adjustment, from: bars[1]!.date })).bars,
    ).toEqual(actual.bars.slice(1));
  }
  expect((await readBars({ ...input, adjustment: "none" })).bars).toEqual(bars);
  expect(
    (await readBars({ ...input, adjustment: "forward", to: bars[0]!.date }))
      .bars,
  ).toEqual(bars.slice(0, 1));
});
