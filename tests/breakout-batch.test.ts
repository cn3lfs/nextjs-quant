import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import valid from "./fixtures/breakout-valid.json";
import fake from "./fixtures/breakout-false.json";
import short from "./fixtures/breakout-insufficient.json";
import type { Bar } from "../src/lib/domain";
import { breakoutBatch } from "../src/server/strategies/breakout/breakout-batch";
import { analyzeBreakout } from "../src/server/strategies/breakout/breakout";

function bytes(bars: Bar[]) {
  const buffer = Buffer.alloc(bars.length * 32);
  bars.forEach((b, i) => {
    const at = i * 32;
    buffer.writeUInt32LE(Number(b.date.replaceAll("-", "")), at);
    [b.open, b.high, b.low, b.close].forEach((p, j) =>
      buffer.writeUInt32LE(Math.round(p * 100), at + 4 + j * 4),
    );
    buffer.writeFloatLE(b.amount, at + 20);
    buffer.writeUInt32LE(b.volume, at + 24);
  });
  return buffer;
}
it("tail rejection/full-history confirmation equals direct engine, and cache validates files without sharing objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-breakout-batch-"));
  for (const f of [valid, fake, short]) {
    const directory = join(root, "vipdoc", f.symbol.slice(0, 2), "lday");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${f.symbol}.day`), bytes(f.bars));
  }
  const symbols = [valid.symbol, fake.symbol, short.symbol];
  const now = Date.parse("2025-04-03T15:05:00+08:00");
  const cold = await breakoutBatch(root, symbols, now);
  expect(cold.errors).toEqual([]);
  expect(cold.candidates.map((c) => c.symbol)).toEqual([valid.symbol]);
  expect(cold.candidates[0]!.point).toEqual(analyzeBreakout(valid.bars).latest);
  expect(cold.fullHistoryReads).toBe(1);
  cold.candidates[0]!.point.long.quality = "tampered";
  const warm = await breakoutBatch(root, symbols, now);
  expect(warm.cacheHit).toBe(true);
  expect(warm.candidates[0]!.point.long.quality).toBe("4/5");
  const changed = structuredClone(valid.bars);
  changed.at(-1)!.volume = 1;
  await writeFile(
    join(root, "vipdoc", "bj", "lday", `${valid.symbol}.day`),
    bytes(changed),
  );
  const refreshed = await breakoutBatch(root, symbols, now);
  expect(refreshed.cacheHit).toBe(false);
  expect(refreshed.candidates).toEqual([]);
  const missing = await breakoutBatch(root, [...symbols, "sh600000"], now);
  expect(missing.cacheHit).toBe(false);
  expect(missing.errors.map((e) => e.symbol)).toContain("sh600000");
});
it("does not confirm an unfinished daily breakout before 15:05", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-breakout-clock-"));
  await mkdir(join(root, "vipdoc", "bj", "lday"), { recursive: true });
  await writeFile(
    join(root, "vipdoc", "bj", "lday", `${valid.symbol}.day`),
    bytes(valid.bars),
  );
  expect(
    (
      await breakoutBatch(
        root,
        [valid.symbol],
        Date.parse(`${valid.cutoff}T15:04:00+08:00`),
      )
    ).candidates,
  ).toEqual([]);
  expect(
    (
      await breakoutBatch(
        root,
        [valid.symbol],
        Date.parse(`${valid.cutoff}T15:05:00+08:00`),
      )
    ).candidates,
  ).toHaveLength(1);
});
