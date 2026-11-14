import { createHash } from "node:crypto";
import { strategySchema, type Snapshot } from "~/lib/domain";
import { evaluateFormula, FormulaError } from "~/lib/formula/tdx-formula";
import type { ScreeningFormula } from "~/lib/formula/formula-screen";

import { readBars } from "~/server/market/bar-store/read-bars";
import type { ScreeningResult } from "./screening-result";
import { completedBarFilter } from "~/lib/completed-bars";
import { metrics } from "trading-strategies/research/technical/screening-metrics";
import { sqlite } from "../db";
import { RpsStore } from "../db/rps-store";
import { usesRpsFields } from "~/lib/formula/tdx-formula-check";
import { parseFormula } from "~/lib/formula/tdx-formula-syntax";

export type FormulaRangeWork = { root: string; now: number };

/** Raw results of one contiguous range of securities (in symbol order). */
export type FormulaPart = {
  candidates: ScreeningResult["candidates"];
  snapshots: ScreeningResult["snapshots"];
  errors: ScreeningResult["errors"];
  excluded: ScreeningResult["excluded"];
  observed: { symbol: string; name: string; date: string }[];
  usageStart: string | null;
  asOf: string | null;
};
type Security = { symbol: string; name: string };

/**
 * Evaluates the formula over `securities` in order. Stale-date exclusion needs
 * the batch-wide as-of date, so it is left to the caller (mergeFormulaParts).
 */
export async function scanFormulaRange(
  work: FormulaRangeWork,
  formula: ScreeningFormula,
  securities: readonly Security[],
  step?: (processed: number, errors: number, excluded: number) => void,
): Promise<FormulaPart> {
  const rps = usesRpsFields(parseFormula(formula.source))
    ? new RpsStore(sqlite())
    : undefined;
  const result = {
    candidates: [] as FormulaPart["candidates"],
    snapshots: [] as FormulaPart["snapshots"],
    errors: [] as FormulaPart["errors"],
    excluded: [] as FormulaPart["excluded"],
    asOf: null as string | null,
  };
  let usageStart: string | null = null;
  const completed = completedBarFilter("day", work.now);
  const observed: { symbol: string; name: string; date: string }[] = [];
  const strategy = strategySchema.parse({});
  // Reads run up to PREFETCH files ahead while earlier ones are evaluated;
  // results are still consumed strictly in order, so outputs, errors and
  // progress are identical to a sequential scan.
  const PREFETCH = 8;
  const pending: Promise<Snapshot | { error: unknown }>[] = [];
  const read = (i: number) => {
    const security = securities[i];
    if (security)
      pending[i] = readBars({
        instrument: { market: "cn-equity", symbol: security.symbol },
        root: work.root,
        period: "day",
        adjustment: "forward",
        freezeRaw: true,
        to: new Date(work.now + 8 * 3600000).toISOString().slice(0, 10),
      }).catch((error: unknown) => ({ error }));
  };
  for (let i = 0; i < PREFETCH; i++) read(i);
  for (const [index, security] of securities.entries()) {
    let snapshot: Snapshot;
    const loaded = await pending[index]!;
    delete pending[index];
    read(index + PREFETCH);
    try {
      if ("error" in loaded) throw loaded.error;
      snapshot = loaded;
    } catch (error) {
      result.errors.push({
        symbol: security.symbol,
        error: error instanceof Error ? error.message : "行情读取失败",
      });
      step?.(index + 1, result.errors.length, result.excluded.length);
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
            .update(
              JSON.stringify({
                bars,
                adjustment: snapshot.adjustment,
                reference: snapshot.barStore?.adjustmentReference,
              }),
            )
            .digest("hex");
          const selected = {
            ...snapshot,
            requestedSource: "local" as const,
            bars,
            ...(snapshot.rawBars
              ? { rawBars: snapshot.rawBars.filter((b) => completed(b.date)) }
              : {}),
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
      step?.(index + 1, result.errors.length, result.excluded.length);
  }
  return { ...result, observed, usageStart };
}

/** Concatenates range results in range order: identical to one sequential scan. */
export function mergeFormulaParts(parts: readonly FormulaPart[]) {
  return {
    candidates: parts.flatMap((p) => p.candidates),
    snapshots: parts.flatMap((p) => p.snapshots),
    errors: parts.flatMap((p) => p.errors),
    excluded: parts.flatMap((p) => p.excluded),
    observed: parts.flatMap((p) => p.observed),
    usageStart: parts.reduce<string | null>(
      (min, p) =>
        p.usageStart !== null && (min === null || p.usageStart < min)
          ? p.usageStart
          : min,
      null,
    ),
    asOf: parts.reduce<string | null>(
      (max, p) =>
        p.asOf !== null && (max === null || p.asOf > max) ? p.asOf : max,
      null,
    ),
  };
}
