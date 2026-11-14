import { recordResearchUsage } from "../research/research-usage";
import {
  validateScreenFormula,
  type ScreeningFormula,
} from "~/lib/formula/formula-screen";
import {
  workProgress,
  type WorkProgress,
} from "~/lib/research/workflow/work-progress";
import { scan } from "../data-sources/tdx/tdx";
import type { ScreeningResult } from "./screening-result";
import { scanFormulaParallel } from "./formula-shards";
import { mergeFormulaParts, type FormulaRangeWork } from "./formula-range";

export type FormulaWork = FormulaRangeWork & {
  attemptId?: string;
  type: "formula-screen";
  formula: ScreeningFormula;
};

/** Full local history is needed by recursive/cumulative formulas. Never truncate
 * their initial state to the legacy dual-MA tail window. Runs only in worker.
 * Latest completed local day is explicit, with stale securities excluded.
 * Large universes are split into contiguous ranges scanned in parallel threads
 * (formula-shards.ts); the merged result equals a sequential scan.
 */
export async function screenFormula(
  work: FormulaWork,
  progress?: (n: number, phase: string, counts: WorkProgress) => void,
): Promise<ScreeningResult> {
  const formula = validateScreenFormula(work.formula);
  const started = performance.now();
  const securities = (await scan(work.root)).securities
    .filter((s) => s.period === "day")
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const report = (processed: number, errors: number, excluded: number) =>
    progress?.(
      Math.round((processed / securities.length) * 90),
      "公式选股",
      workProgress(
        "公式选股",
        "证券",
        processed,
        securities.length,
        errors,
        excluded,
      ),
    );
  const parts = await scanFormulaParallel(work, formula, securities, report);
  const merged = mergeFormulaParts(parts);
  const usageStart = merged.usageStart;
  const observed = merged.observed;
  const result: ScreeningResult = {
    candidates: merged.candidates,
    snapshots: merged.snapshots,
    errors: merged.errors,
    excluded: merged.excluded,
    total: securities.length,
    asOf: merged.asOf,
    elapsedMs: 0,
  };
  const stale = new Set(
    observed.filter((s) => s.date !== result.asOf).map((s) => s.symbol),
  );
  result.excluded = result.excluded.filter((s) => !stale.has(s.symbol));
  result.excluded.push(
    ...observed
      .filter((s) => stale.has(s.symbol))
      .map((s) => ({ ...s, reason: "行情日期落后于公式选股基准日" })),
  );
  result.candidates = result.candidates.filter((s) => !stale.has(s.symbol));
  result.snapshots = result.snapshots.filter((s) => !stale.has(s.symbol));
  // Date alignment can exclude additional securities after the scan. Publish
  // the final counts so the completed progress card agrees with the result.
  progress?.(
    90,
    "公式选股",
    workProgress(
      "公式选股",
      "证券",
      securities.length,
      securities.length,
      result.errors.length,
      result.excluded.length,
    ),
  );
  result.elapsedMs = performance.now() - started;
  if (usageStart !== null && result.asOf !== null)
    recordResearchUsage(
      () => ({
        kind: "formula-screen",
        symbols: ["*"],
        universeSize: securities.length,
        range: { start: usageStart!, end: result.asOf! },
        candidateCount: 1,
        config: {
          kind: "formula-screen",
          source: formula.source,
          parameters: formula.parameters,
          root: work.root,
        },
      }),
      work.attemptId,
    );
  return result;
}
