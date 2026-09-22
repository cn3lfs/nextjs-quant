/** Persistent M5 evidence tool. Source TDX files are read-only.
 * pnpm exec tsx tests/m5-local-review.ts --fixtures | --benchmark
 * Fixtures are explicit historical selections, never a scan for passing outputs.
 */
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  parseBars,
  isAStock,
  readSnapshot,
} from "../src/server/data-sources/tdx/tdx";
import { analyzeBreakout } from "../src/server/strategies/breakout/breakout";
import { breakoutBatch } from "../src/server/strategies/breakout/breakout-batch";
import { screenLocal } from "../src/server/screening/screening";
import { defaultStrategy } from "../src/lib/domain";
const root = process.env.M5_TDX_ROOT ?? "E:/new_tdx64";
const digest = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
if (process.argv.includes("--fixtures")) {
  for (const [name, symbol, cutoff] of [
    ["valid", "bj920748", "2025-03-07"],
    ["false", "sh600519", "2025-04-03"],
    ["insufficient", "sz002084", "ipo59"],
  ]) {
    const file = join(
      root,
      "vipdoc",
      symbol!.slice(0, 2),
      "lday",
      `${symbol}.day`,
    );
    const bytes = await readFile(file),
      all = parseBars(bytes, "day");
    const count =
      cutoff === "ipo59" ? 59 : all.findIndex((b) => b.date === cutoff) + 1;
    if (!count) throw new Error(`missing case ${symbol} ${cutoff}`);
    const bars = all.slice(0, count),
      future = all.slice(count, count + 5);
    await writeFile(
      `tests/fixtures/breakout-${name}.json`,
      JSON.stringify({
        symbol,
        source: file,
        adjustment: "none",
        sourceHash: digest(bytes),
        barsHash: digest(JSON.stringify(bars)),
        cutoff: bars.at(-1)!.date,
        bars,
        future,
      }) + "\n",
    );
    const p = analyzeBreakout(bars).latest!;
    console.log(
      JSON.stringify({
        name,
        symbol,
        count,
        date: p.date,
        bar: bars.at(-1),
        long: p.long,
        volume20: p.volume20,
        volumeRatio: p.volumeRatio,
      }),
    );
  }
}
if (process.argv.includes("--benchmark")) {
  const symbols = (
    await Promise.all(
      ["sh", "sz", "bj"].map(async (market) =>
        (await readdir(join(root, "vipdoc", market, "lday")))
          .filter((f) => f.endsWith(".day"))
          .map((f) => f.slice(0, -4)),
      ),
    )
  )
    .flat()
    .filter(isAStock)
    .sort();
  const input = {
    root,
    symbols,
    period: "day" as const,
    strategy: defaultStrategy,
  };
  const cold = await screenLocal(input),
    warm = await screenLocal(input);
  const batchCold = await breakoutBatch(root, symbols),
    batchWarm = await breakoutBatch(root, symbols);
  const result = {
    root,
    symbols: symbols.length,
    completed: symbols.length - batchCold.errors.length,
    errors: batchCold.errors,
    matched: batchCold.candidates.length,
    fullHistoryReads: batchCold.fullHistoryReads,
    coldScreenMs: cold.elapsedMs,
    warmScreenMs: warm.elapsedMs,
    coldBreakoutMs: batchCold.elapsedMs,
    warmBreakoutMs: batchWarm.elapsedMs,
    ratioCold: batchCold.elapsedMs / cold.elapsedMs,
    ratioWarm: batchWarm.elapsedMs / warm.elapsedMs,
    accepted:
      batchCold.errors.length === 0 &&
      batchCold.elapsedMs <= cold.elapsedMs * 2 &&
      batchWarm.elapsedMs <= warm.elapsedMs * 2,
    note: "same process/root/universe; cold vs cold and manifest-validated warm vs warm; tail only rejects core failures, positive signals use full M1 histories; no LLM/notification",
  };
  await mkdir("docs/m5-review", { recursive: true });
  await writeFile(
    "docs/m5-review/batch.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
}
