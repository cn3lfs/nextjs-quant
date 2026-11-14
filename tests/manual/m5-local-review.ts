/** Persistent M5 evidence tool. Source TDX files are read-only.
 * pnpm exec tsx tests/manual/m5-local-review.ts --fixtures
 * Fixtures are explicit historical selections, never a scan for passing outputs.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseBars } from "tstdx/local";
import { analyzeBreakout } from "trading-strategies/research/breakout/breakout";
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
