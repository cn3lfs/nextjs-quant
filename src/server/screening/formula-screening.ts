import { recordResearchUsage } from "../research/research-usage";
import { createHash } from "node:crypto";
import type { Snapshot } from "~/lib/domain";
import { strategySchema } from "~/lib/domain";
import { evaluateFormula, FormulaError } from "~/lib/formula/tdx-formula";
import {
  validateScreenFormula,
  type ScreeningFormula,
} from "~/lib/formula/formula-screen";
import { workProgress, type WorkProgress } from "~/lib/research/workflow/work-progress";
import { readSnapshot, scan } from "../data-sources/tdx/tdx";
import { type ScreeningResult } from "./screening";
import { completedBarFilter } from "~/lib/completed-bars";
import { metrics } from "~/lib/screening/screening-metrics";
import { sqlite } from "../db";
import { RpsStore } from "./rps-store";
import { usesRpsFields } from "~/lib/formula/tdx-formula-check";
import { parseFormula } from "~/lib/formula/tdx-formula-syntax";

export type FormulaWork = {
  attemptId?: string;
  type: "formula-screen";
  root: string;
  formula: ScreeningFormula;
  now: number;
};
/** Full local history is needed by recursive/cumulative formulas. Never truncate
 * their initial state to the legacy dual-MA tail window. Runs only in worker.
 * Latest completed local day is explicit, with stale securities excluded.
 */
export async function screenFormula(
  work: FormulaWork,
  progress?: (n: number, phase: string, counts: WorkProgress) => void,
): Promise<ScreeningResult> {
  const formula = validateScreenFormula(work.formula);
  const rps = usesRpsFields(parseFormula(formula.source))
    ? new RpsStore(sqlite())
    : undefined;
  const started = performance.now();
  const securities = (await scan(work.root)).securities
    .filter((s) => s.period === "day")
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const result: ScreeningResult = {
    candidates: [],
    snapshots: [],
    errors: [],
    excluded: [],
    total: securities.length,
    asOf: null,
    elapsedMs: 0,
  };
  let usageStart: string | null = null;
  const completed = completedBarFilter("day", work.now);
  const observed: { symbol: string; name: string; date: string }[] = [];
  const strategy = strategySchema.parse({});
  for (const [index, security] of securities.entries()) {
    let snapshot: Snapshot;
    try {
      snapshot = await readSnapshot(work.root, security.symbol, "day");
    } catch (error) {
      result.errors.push({
        symbol: security.symbol,
        error: error instanceof Error ? error.message : "行情读取失败",
      });
      progress?.(
        Math.round(((index + 1) / securities.length) * 90),
        "公式选股",
        workProgress(
          "公式选股",
          "证券",
          index + 1,
          securities.length,
          result.errors.length,
          result.excluded.length,
        ),
      );
      continue;
    }
    const bars = snapshot.bars.filter((b) => completed(b.date));
    const last = bars.at(-1);
    if (!last)
      result.excluded.push({
        symbol: security.symbol,
        reason: "没有已完成的日线",
      });
    else {
      const first = bars[0]!.date;
      if (usageStart === null || first < usageStart) usageStart = first;
      observed.push({
        symbol: security.symbol,
        name: security.name,
        date: last.date,
      });
      if (result.asOf === null || last.date > result.asOf)
        result.asOf = last.date;
      // Formula errors are task failures, not per-security skips or approximations.
      let value: number | null | undefined;
      try {
        value = evaluateFormula(
          formula.source,
          bars,
          formula.parameters,
          rps?.curve(security.symbol),
        ).outputs[0]!.values.at(-1);
      } catch (e) {
        if (e instanceof FormulaError)
          throw new Error(`${security.symbol}：${e.message}`);
        throw e;
      }
      if (value == null)
        result.excluded.push({
          symbol: security.symbol,
          date: last.date,
          reason: rps
            ? "公式输出无效：RPS缺失、历史不足或计算定义域为空"
            : "公式输出无效：历史不足或计算定义域为空",
        });
      else if (value !== 0) {
        const detail = metrics(bars, strategy);
        // Candidate table's default MA/volume columns are descriptive only.
        // Short histories have unavailable metrics, not fabricated zeros.
        if (!detail)
          result.excluded.push({
            symbol: security.symbol,
            date: last.date,
            reason: "候选表指标历史不足",
          });
        else {
          const hash = createHash("sha256")
            .update(JSON.stringify(bars))
            .digest("hex");
          const selected = {
            ...snapshot,
            bars,
            hash,
            id: `snapshot-formula-${security.symbol}-${hash.slice(0, 16)}`,
          };
          result.snapshots.push(selected);
          result.candidates.push({
            symbol: security.symbol,
            name: security.name,
            snapshotId: selected.id,
            metrics: { ...detail, matched: true },
          });
        }
      }
    }
    if ((index + 1) % 25 === 0 || index + 1 === securities.length)
      progress?.(
        Math.round(((index + 1) / securities.length) * 90),
        "公式选股",
        workProgress(
          "公式选股",
          "证券",
          index + 1,
          securities.length,
          result.errors.length,
          result.excluded.length,
        ),
      );
  }
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
