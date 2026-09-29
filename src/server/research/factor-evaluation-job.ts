import { z } from "zod";
import { completedBarFilter } from "~/lib/completed-bars";
import { evaluateFormula, FormulaError } from "~/lib/formula/tdx-formula";
import { validateScreenFormula } from "~/lib/formula/formula-screen";
import {
  evaluateFactor,
  type FactorSeries,
} from "~/lib/research/factor-evaluation";
import {
  workProgress,
  type WorkProgress,
} from "~/lib/research/workflow/work-progress";
import { readSnapshot, scan } from "../data-sources/tdx/tdx";
import { recordResearchUsage } from "./research-usage";
import {
  adjustmentFactors,
  applyAdjustmentByDate,
  readGbbq,
} from "../data-sources/tdx/tdx-gbbq";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const factorEvaluationSchema = z
  .object({
    source: z.string().min(1).max(20000),
    parameters: z.record(z.number().finite()).default({}),
    start: day,
    end: day,
    horizons: z
      .array(z.number().int().min(1).max(60))
      .min(1)
      .max(6)
      .default([1, 5, 10, 20]),
    quantiles: z.number().int().min(2).max(10).default(5),
  })
  .refine((v) => v.start <= v.end, "开始日期不能晚于结束日期");
export type FactorEvaluationInput = z.infer<typeof factorEvaluationSchema>;
export type FactorWork = FactorEvaluationInput & {
  attemptId?: string;
  type: "factor-eval";
  root: string;
  now: number;
};
/** A-share common stocks (SH/SZ main boards, ChiNext, STAR, BSE). */
const aShare = /^(sh(60|68)|sz(00|30)|bj(43|83|87|88|92))\d{4}$/;

/**
 * Evaluates a formula's output as a cross-sectional factor over local A-share
 * daily bars. Factor and forward returns both use backward-adjusted (后复权)
 * bars from the local gbbq; a security without gbbq events is used unadjusted
 * and counted. Runs in a worker.
 */
export async function evaluateFactorWork(
  work: FactorWork,
  progress?: (n: number, phase: string, counts: WorkProgress) => void,
) {
  const input = factorEvaluationSchema.parse(work);
  validateScreenFormula({
    name: "因子",
    source: input.source,
    parameters: input.parameters,
  });
  const started = performance.now();
  const securities = (await scan(work.root)).securities
    .filter((s) => s.period === "day" && aShare.test(s.symbol))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const gbbq = await readGbbq(work.root).catch(() => null);
  const completed = completedBarFilter("day", work.now);
  const maxHorizon = Math.max(...input.horizons);
  const series: FactorSeries[] = [];
  const errors: { symbol: string; error: string }[] = [];
  let unadjusted = 0;
  // One string per trading day instead of one per security-day.
  const days = new Map<string, string>();
  const intern = (date: string) => {
    const key = date.slice(0, 10);
    const known = days.get(key);
    if (known) return known;
    days.set(key, key);
    return key;
  };
  const PREFETCH = 8;
  const pending: Promise<
    Awaited<ReturnType<typeof readSnapshot>> | { error: unknown }
  >[] = [];
  const read = (i: number) => {
    const security = securities[i];
    if (security)
      pending[i] = readSnapshot(work.root, security.symbol, "day").catch(
        (error: unknown) => ({ error }),
      );
  };
  for (let i = 0; i < PREFETCH; i++) read(i);
  for (const [index, security] of securities.entries()) {
    const loaded = await pending[index]!;
    delete pending[index];
    read(index + PREFETCH);
    if ("error" in loaded) {
      errors.push({
        symbol: security.symbol,
        error:
          loaded.error instanceof Error ? loaded.error.message : "行情读取失败",
      });
      continue;
    }
    const raw = loaded.bars.filter((b) => completed(b.date));
    if (!raw.length) continue;
    const events = gbbq?.events.get(security.symbol);
    if (!events?.length) unadjusted++;
    const bars = applyAdjustmentByDate(
      raw,
      adjustmentFactors(raw, events ?? []),
      "backward",
    );
    let factor: (number | null)[];
    try {
      factor = evaluateFormula(input.source, bars, input.parameters).outputs[0]!
        .values;
    } catch (e) {
      if (e instanceof FormulaError)
        throw new Error(`${security.symbol}：${e.message}`);
      throw e;
    }
    // Keep the window plus the tail the longest horizon needs.
    const first = bars.findIndex((b) => b.date >= input.start);
    if (first < 0) continue;
    let last = bars.findIndex((b) => b.date > input.end);
    last = last < 0 ? bars.length : Math.min(bars.length, last + maxHorizon);
    series.push({
      symbol: security.symbol,
      dates: bars.slice(first, last).map((b) => intern(b.date)),
      factor: factor.slice(first, last),
      close: bars.slice(first, last).map((b) => b.close),
    });
    if ((index + 1) % 50 === 0 || index + 1 === securities.length)
      progress?.(
        Math.round(((index + 1) / securities.length) * 90),
        "读取行情并计算因子",
        workProgress(
          "因子评估",
          "证券",
          index + 1,
          securities.length,
          errors.length,
          0,
        ),
      );
  }
  progress?.(
    95,
    "横截面评估",
    workProgress(
      "因子评估",
      "证券",
      securities.length,
      securities.length,
      errors.length,
      0,
    ),
  );
  const result = evaluateFactor(series, input);
  // Each evaluation is a research trial (multiple-testing ledger).
  recordResearchUsage(
    () => ({
      kind: "factor-eval",
      symbols: ["*"],
      universeSize: securities.length,
      range: { start: input.start, end: input.end },
      candidateCount: 1,
      config: { kind: "factor-eval", ...input, root: work.root },
    }),
    work.attemptId,
  );
  return {
    ...result,
    input,
    universe: securities.length,
    evaluated: series.length,
    unadjusted,
    gbbq: gbbq ? { path: gbbq.path, modified: gbbq.modified } : null,
    errors: errors.slice(0, 50),
    errorCount: errors.length,
    elapsedMs: Math.round(performance.now() - started),
    basis:
      "收盘价后复权；因子取当日收盘后的公式输出，前向收益为 t 日收盘至 t+h 日收盘，未扣成本、未考虑停牌与涨跌停成交限制，非可成交收益。分位收益已减当日横截面均值（alphalens 默认）。证券池为当前本地日线文件，含幸存者偏差。",
  };
}
