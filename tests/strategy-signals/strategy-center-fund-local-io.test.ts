import gbbq from "../fixtures/tdx-gbbq.json";
import { readBars } from "~/server/market/bar-store/read-bars";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { evaluateStrategy } from "trading-strategies";
import { readSnapshot } from "tstdx/local";
import { captureStrategyCandidates } from "~/server/strategies/strategy-center-candidates";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), "quant-fund-local-io-")))
      throw new Error("unexpected cleanup target");
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "quant-fund-local-io-"));
  roots.push(root);
  const dates: string[] = [];
  for (let day = Date.UTC(2020, 0, 2); dates.length < 320; day += 86400000) {
    if (![0, 6].includes(new Date(day).getUTCDay()))
      dates.push(new Date(day).toISOString().slice(0, 10));
  }
  const symbols = ["sh600000", "sh510300", "sz159915"];
  const prices = new Map<string, number[]>();
  const bytes = new Map<string, Buffer>();
  for (const [symbol, base, step, scale, frequency] of [
    ["sh000300", 100000, 5, 100, 0.13],
    ["sh600000", 1001, 2, 100, 0.27],
    ["sh510300", 2001, 3, 1000, 0.37],
    ["sz159915", 3005, 2, 1000, 0.51],
  ] as const) {
    const body = Buffer.alloc(32 * dates.length);
    const closes = dates.map((date, index) => {
      const raw =
        base + step * index + Math.round(20 * Math.sin(frequency * index));
      const offset = index * 32;
      body.writeUInt32LE(Number(date.replaceAll("-", "")), offset);
      [raw, raw + 10, raw - 10, raw].forEach((value, i) =>
        body.writeUInt32LE(value, offset + 4 + i * 4),
      );
      body.writeFloatLE(1000000, offset + 20);
      body.writeUInt32LE(100000, offset + 24);
      return raw / scale;
    });
    const dir = join(root, "vipdoc", symbol.slice(0, 2), "lday");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${symbol}.day`), body);
    prices.set(symbol, closes);
    bytes.set(symbol, body);
  }
  await mkdir(join(root, "T0002/hq_cache"), { recursive: true });
  await writeFile(
    join(root, "T0002/hq_cache/gbbq"),
    Buffer.from(gbbq.gbbqBase64, "base64"),
  );
  return { root, symbols, dates, prices, bytes, asOf: dates[280]! };
}
const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");

it("reads actual two-market ETF .day files through default candidate IO with three decimal prices and original source hashes", async () => {
  const f = await fixture();
  // The default stock research reader retains its instrument guard outside this authorized intake.
  await expect(readSnapshot(f.root, "sh510300", "day")).rejects.toThrow(
    "场内基金须使用图表读取入口",
  );
  const capture = await captureStrategyCandidates(
    { strategyId: "portfolio-rps-5", symbols: f.symbols, asOf: f.asOf },
    f.root,
  );
  expect(capture.exclusions).toEqual([]);
  expect(capture.candidates).toHaveLength(3);
  for (const candidate of capture.candidates) {
    const price = f.prices.get(candidate.symbol)!;
    expect(candidate.values.rpsReturn5).toBeCloseTo(
      price[280]! / price[275]! - 1,
      13,
    );
    const evidence = capture.evidence.find(
      (row) => row.symbol === candidate.symbol,
    )!;
    expect(evidence.sourceHash).toBe(hash(f.bytes.get(candidate.symbol)!));
    const adjusted = await readBars({
      root: f.root,
      instrument: { market: "cn-equity", symbol: candidate.symbol },
      period: "day",
      adjustment: "forward",
      chartFunds: candidate.symbol !== "sh600000",
      freezeRaw: true,
      to: f.asOf,
    });
    expect(evidence.barsHash).toBe(adjusted.hash);
    expect(evidence.bars!.at(-1)!.date).toBe(f.asOf);
  }
  expect(
    capture.evidence.find((row) => row.symbol === "sh510300")!.bars![0]!.close,
  ).toBe(f.prices.get("sh510300")![30]);
  expect(
    (await readSnapshot(f.root, "sh510300", "day", { chartFunds: true }))
      .bars[0]!.close,
  ).toBe(2.001);
  expect(
    (await readSnapshot(f.root, "sz159915", "day", { chartFunds: true }))
      .bars[0]!.close,
  ).toBe(3.005);
  expect(capture.benchmarkSourceHash).toBe(hash(f.bytes.get("sh000300")!));
  const result = evaluateStrategy(
    { strategyId: "portfolio-rps-5", parameters: { topK: 3 } },
    { asOf: f.asOf, candidates: capture.candidates },
  );
  expect(result).toMatchObject({
    kind: "weights",
    weights: expect.arrayContaining(
      f.symbols.map((symbol) => ({ symbol, weight: 1 / 3 })),
    ),
  });
});

it("builds real mixed ETF/stock risk-parity return inputs and keeps future file revisions outside candidate facts", async () => {
  const f = await fixture(),
    request = {
      strategyId: "allocation-risk-parity",
      symbols: f.symbols,
      asOf: f.asOf,
    };
  const capture = await captureStrategyCandidates(request, f.root);
  expect(capture.exclusions).toEqual([]);
  expect(capture.candidates).toHaveLength(3);
  for (const candidate of capture.candidates) {
    expect(candidate.returns).toHaveLength(60);
    const price = f.prices.get(candidate.symbol)!;
    expect(candidate.returns![0]!.value).toBeCloseTo(
      price[221]! / price[220]! - 1,
      14,
    );
  }
  const result = evaluateStrategy(
    { strategyId: request.strategyId },
    { asOf: f.asOf, candidates: capture.candidates },
  );
  if (result.kind !== "weights") throw new Error("expected weights");
  expect(result.weights.map((row) => row.symbol).sort()).toEqual(
    [...f.symbols].sort(),
  );
  expect(result.weights.every((row) => row.weight > 0)).toBe(true);
  expect(result.weights.reduce((sum, row) => sum + row.weight, 0)).toBeCloseTo(
    1,
    12,
  );
  const path = join(f.root, "vipdoc/sh/lday/sh510300.day");
  const future = await readFile(path);
  for (let index = 281; index < f.dates.length; index++)
    [900000, 900010, 899990, 900000].forEach((value, column) =>
      future.writeUInt32LE(value, index * 32 + 4 + column * 4),
    );
  await writeFile(path, future);
  const revised = await captureStrategyCandidates(request, f.root);
  expect(revised.candidates).toEqual(capture.candidates);
  expect(
    revised.evidence.find((row) => row.symbol === "sh510300")!.barsHash,
  ).not.toBe(
    capture.evidence.find((row) => row.symbol === "sh510300")!.barsHash,
  );
  expect(
    evaluateStrategy(
      { strategyId: request.strategyId },
      { asOf: f.asOf, candidates: revised.candidates },
    ),
  ).toEqual(result);
});
