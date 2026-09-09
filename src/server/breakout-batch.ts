import { analyzeBreakout, type BreakoutPoint } from "./breakout";
import { readSnapshot, readTailSnapshot, isAStock } from "./tdx";
import { completedBarFilter } from "./screening";
import { screeningKey, screeningManifest } from "./screen-cache";
import { strategySchema } from "~/lib/domain";

type Batch = {
  total: number;
  candidates: { symbol: string; hash: string; point: BreakoutPoint }[];
  errors: { symbol: string; error: string }[];
  fullHistoryReads: number;
  elapsedMs: number;
  cacheHit: boolean;
};
// One result only, bounded by the A-share universe. Same manifest and completion
// cutoff as the existing screener. No mutation of the screener/cache modules.
let cached: { key: string; manifest: string; result: Batch } | undefined;

/** Daily universe entry. A 61-bar tail can DISPROVE a core condition because
 * all structural/volume thresholds depend only on the prior 60 sessions.
 * It can NEVER confirm a signal: candidates are re-read and evaluated against
 * their full history so all recursive M1 indicator seeds stay identical to M2.
 * IO is confined here; breakout.ts remains a pure deterministic calculation.
 */
export async function breakoutBatch(
  root: string,
  symbols: string[],
  now = Date.now(),
): Promise<Batch> {
  const started = performance.now();
  const universe = [...new Set(symbols)].sort();
  if (universe.some((s) => !isAStock(s)))
    throw new Error("双突破批量仅支持A股日线");
  const input = {
    root,
    symbols: universe,
    period: "day" as const,
    strategy: strategySchema.parse({ type: "dual-breakout", params: {} }),
  };
  const key = screeningKey(input, now),
    manifest = await screeningManifest(input);
  if (manifest && cached?.key === key && cached.manifest === manifest) {
    return {
      ...structuredClone(cached.result),
      elapsedMs: performance.now() - started,
      cacheHit: true,
    };
  }
  const result: Batch = {
    total: universe.length,
    candidates: [],
    errors: [],
    fullHistoryReads: 0,
    elapsedMs: 0,
    cacheHit: false,
  };
  const completed = completedBarFilter("day", now);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, universe.length) }, async () => {
      while (cursor < universe.length) {
        const symbol = universe[cursor++]!;
        try {
          const tail = await readTailSnapshot(root, symbol, "day", 62);
          const preliminary = analyzeBreakout(
            tail.bars.filter((b) => completed(b.date)),
          ).latest;
          if (
            !preliminary ||
            ![preliminary.long, preliminary.short].some(
              (s) =>
                s.checks.trend === "是" &&
                s.checks.level === "是" &&
                s.checks.volume === "是",
            )
          )
            continue;
          result.fullHistoryReads++;
          const source = await readSnapshot(root, symbol, "day");
          const point = analyzeBreakout(
            source.bars.filter((b) => completed(b.date)),
          ).latest;
          if (point && [point.long, point.short].some((s) => s.status === "是"))
            result.candidates.push({ symbol, hash: source.hash, point });
        } catch (error) {
          result.errors.push({ symbol, error: String(error) });
        }
      }
    }),
  );
  result.candidates.sort((a, b) => a.symbol.localeCompare(b.symbol));
  result.errors.sort((a, b) => a.symbol.localeCompare(b.symbol));
  // Do not memoize a mixed generation if TDX updates during the scan.
  const after = await screeningManifest(input);
  if (manifest && manifest !== after)
    result.errors.push({ symbol: "*", error: "扫描期间行情文件变化，请重跑" });
  result.elapsedMs = performance.now() - started;
  if (manifest && manifest === after && !result.errors.length)
    cached = { key, manifest, result: structuredClone(result) };
  return result;
}
