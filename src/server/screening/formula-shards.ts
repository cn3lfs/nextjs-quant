import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { ScreeningFormula } from "~/lib/formula/formula-screen";
import type { FormulaPart, FormulaWork } from "./formula-screening";
import { scanFormulaRange } from "./formula-screening";

type Security = { symbol: string; name: string };
/** One contiguous range, scanned in a nested thread of the formula worker. */
export type FormulaShardWork = {
  type: "formula-shard";
  root: string;
  now: number;
  formula: ScreeningFormula;
  securities: Security[];
};
type Step = (processed: number, errors: number, excluded: number) => void;

/** Below this many securities the thread start-up is not worth it. */
const MIN_PARALLEL = 400;
/**
 * Threads for one formula screen: all cores but two, capped at 8 (user
 * decision D1, 2026-09-30). The screen's own job still holds one of the two
 * global compute slots; the shards run inside it, so market loads and
 * backtests keep the other slot.
 */
export function formulaThreads(securities: number) {
  if (securities < MIN_PARALLEL) return 1;
  return Math.max(1, Math.min(8, availableParallelism() - 2));
}

/** Contiguous ranges so that concatenated results keep symbol order. */
export function formulaRanges<T>(items: readonly T[], count: number): T[][] {
  const size = Math.ceil(items.length / count);
  return Array.from({ length: count }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  ).filter((range) => range.length);
}

/** Only the bundled runtime worker can start copies of itself. */
function workerEntry(): string | null {
  return typeof __filename === "string" && /worker\.cjs$/.test(__filename)
    ? __filename
    : null;
}

export async function scanFormulaParallel(
  work: Pick<FormulaWork, "root" | "now">,
  formula: ScreeningFormula,
  securities: readonly Security[],
  step?: Step,
): Promise<FormulaPart[]> {
  const entry = workerEntry();
  const threads = entry ? formulaThreads(securities.length) : 1;
  if (threads <= 1)
    return [await scanFormulaRange(work, formula, securities, step)];
  const ranges = formulaRanges(securities, threads);
  const counts = ranges.map(() => ({ processed: 0, errors: 0, excluded: 0 }));
  const children: Worker[] = [];
  const report = () =>
    step?.(
      counts.reduce((s, c) => s + c.processed, 0),
      counts.reduce((s, c) => s + c.errors, 0),
      counts.reduce((s, c) => s + c.excluded, 0),
    );
  try {
    return await Promise.all(
      ranges.map(
        (range, i) =>
          new Promise<FormulaPart>((resolve, reject) => {
            const child = new Worker(entry!);
            children.push(child);
            child.on(
              "message",
              (message: {
                shardProgress?: {
                  processed: number;
                  errors: number;
                  excluded: number;
                };
                result?: FormulaPart;
                error?: string;
              }) => {
                if (message.shardProgress) {
                  counts[i] = message.shardProgress;
                  report();
                } else if (message.error) reject(new Error(message.error));
                else if (message.result) resolve(message.result);
              },
            );
            child.on("error", reject);
            child.on("exit", (code) => {
              if (code !== 0)
                reject(new Error(`公式选股分段线程异常退出（${code}）`));
            });
            const shard: FormulaShardWork = {
              type: "formula-shard",
              root: work.root,
              now: work.now,
              formula,
              securities: range.map(({ symbol, name }) => ({ symbol, name })),
            };
            child.postMessage(shard);
          }),
      ),
    );
  } finally {
    await Promise.all(children.map((child) => child.terminate()));
  }
}
