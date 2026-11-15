import { task, config, json, readArtifact, delivery, digest } from "./context";
import { mainCrypto } from "./main-inputs";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { evaluatePerformance } from "quant-performance";
import type { ValidationScore } from "quant-backtest";
import type { CandidateCheckpoint } from "../../../src/server/research/validation-scale";
const rows: unknown[] = [];
for (const period of ["day", "4h", "1h", "15m"] as const) {
  const { dataset } = await mainCrypto(period);
  const families =
    period === "day"
      ? ["dual-ma-day", "range-day"]
      : period === "4h"
        ? ["dual-ma-4h", "range-4h"]
        : [`range-${period}`];
  function assess(score: ValidationScore, start: string, end: string) {
    const dates = dataset.dates.filter((d) => d >= start && d <= end);
    if (dates.length !== score.daily.length)
      throw new Error(
        `Benchmark dates mismatch ${period}/${start}/${end}/${dates.length}/${score.daily.length}`,
      );
    const maps = dataset.instruments.map((i) => {
      const bars = i.bars.filter(
        (b) => b.date.slice(0, 10) >= start && b.date.slice(0, 10) <= end,
      );
      const first = bars[0]!.open,
        closes = new Map<string, number>();
      for (const b of bars) closes.set(b.date.slice(0, 10), b.close);
      return { first, closes };
    });
    const benchmark = dates.map((date) =>
      maps.every((m) => m.closes.has(date))
        ? maps.reduce((n, m) => n + (0.5 * m.closes.get(date)!) / m.first, 0)
        : null,
    );
    if (
      benchmark.some((v) => v === null) ||
      score.daily.some((v) => v === null)
    )
      return {
        available: false,
        reason:
          "Missing same-window BTC or ETH or strategy daily observations; no filled benchmark",
      };
    let nav = 1,
      previous = 1;
    const points = dates.map((date, i) => {
      nav *= 1 + score.daily[i]!;
      const b = benchmark[i]!,
        r = b / previous - 1;
      previous = b;
      return { date, value: nav, benchmarkReturn: r };
    });
    const e = evaluatePerformance(1, points),
      b = evaluatePerformance(
        1,
        dates.map((date, i) => ({ date, value: benchmark[i]! })),
      );
    if (
      score.return !== null &&
      Math.abs(e.totalReturn.value! - score.return) > 1e-8
    )
      throw new Error("Strategy daily reconstruction mismatch");
    if (
      score.riskAdjusted?.sharpe !== null &&
      score.riskAdjusted?.sharpe !== undefined &&
      Math.abs(e.sharpe.value! - score.riskAdjusted.sharpe) > 1e-8
    )
      throw new Error("Strategy Sharpe reconstruction mismatch");
    return {
      available: true,
      return: e.totalReturn.value,
      benchmarkReturn: b.totalReturn.value,
      excess: e.excessReturn.value,
      sharpe: e.sharpe.value,
      benchmarkSharpe: b.sharpe.value,
      sharpeDifference:
        e.sharpe.value === null || b.sharpe.value === null
          ? null
          : e.sharpe.value - b.sharpe.value,
      calmarDifference:
        e.calmar.value === null || b.calmar.value === null
          ? null
          : e.calmar.value - b.calmar.value,
    };
  }
  for (const family of families)
    for (const sizing of config.sizing) {
      const suffix = sizing === "legacy" ? "" : `-${sizing}`;
      const p = await json<{
        complete: boolean;
        pointer: { path: string; sha256: string };
      }>(join(task, `btc-eth-${family}${suffix}-progress.json`));
      if (!p.complete) throw new Error("Main crypto incomplete");
      const group = await readArtifact<{ checkpoints: CandidateCheckpoint[] }>(
        p.pointer,
      );
      for (const c of group.checkpoints)
        rows.push({
          id: c.row.id,
          period,
          full: assess(c.fullPeriod, dataset.dates[0]!, dataset.dates.at(-1)!),
          holdout: {
            start: c.row.holdout.start,
            end: c.row.holdout.end,
            base: assess(
              c.row.holdout.base,
              c.row.holdout.start,
              c.row.holdout.end,
            ),
            doubledCost: assess(
              c.row.holdout.doubledCost,
              c.row.holdout.start,
              c.row.holdout.end,
            ),
            delayed: assess(
              c.row.holdout.delayed,
              c.row.holdout.start,
              c.row.holdout.end,
            ),
          },
          windows: c.row.windows.map((w) => ({
            start: w.start,
            end: w.end,
            base: assess(w.base, w.start, w.end),
            doubledCost: assess(w.doubledCost, w.start, w.end),
            delayed: assess(w.delayed, w.start, w.end),
          })),
        });
    }
}
const path = join(task, "benchmark-50-50.json");
await writeFile(
  path,
  JSON.stringify(
    {
      basis:
        "Each evaluation window independently invests50% initial capital at each symbol first native open, holds without rebalance or benchmark transaction charges; positive missingness is never filled. Strategy daily returns are reconciled to original return and Sharpe before comparison.",
      rows,
    },
    null,
    2,
  ),
);
await delivery({
  alternateBenchmark: {
    path,
    sha256: digest(await readFile(path)),
    rows: rows.length,
    basis:
      "BTC/ETH50/50 hold, window-specific initial weights; diagnostic, primary promotion remains BTC hold",
  },
});
console.log(JSON.stringify({ complete: true, rows: rows.length }));
process.exit(0);
