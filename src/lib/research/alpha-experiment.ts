import { z } from "zod";
import { researchDateSchema as date } from "trading-strategies/research/contracts/date";
import {
  factorAccumulator,
  forwardReturn,
  icStatistics,
  spearman,
} from "./factor-evaluation";

const positiveInt = z.number().int().positive();
const fraction = z.number().finite().min(0).max(1);
const symbol = z.string().regex(/^(sh|sz|bj)\d{6}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const alphaBenchmarks = [
  { id: "sh000906", name: "中证800", primary: true },
  { id: "sh000300", name: "沪深300", primary: false },
  { id: "sh000905", name: "中证500", primary: false },
  { id: "sh000852", name: "中证1000", primary: false },
  { id: "eligible-equal", name: "当日合格池等权", primary: false },
] as const;
export const alphaBuiltins = [
  "momentum",
  "volatility",
  "turnover",
  "amount",
  "reversal",
] as const;
const factor = z
  .object({
    factorId: z.string().trim().min(1),
    direction: z.union([z.literal(-1), z.literal(1)]).default(1),
    formula: z.string().trim().min(1).max(20000).optional(),
    parameters: z.record(z.number().finite()).default({}),
    weight: z.number().finite().nonnegative().optional(),
  })
  .strict();
export const alphaExperimentSchema = z
  .object({
    factors: z.array(factor).min(1).max(32),
    weightingMethod: z.enum(["equal", "custom", "icir"]).default("equal"),
    winsorizeMethod: z.enum(["none", "mad", "quantile"]).default("mad"),
    neutralizationMode: z
      .enum(["none", "industry", "size", "industry_size"])
      .default("none"),
    madK: z.number().finite().positive().default(3),
    quantileTail: z.number().min(0).lt(0.5).default(0.01),
    minTradingDays: positiveInt.default(60),
    liquidityWindow: positiveInt.default(20),
    minAverageAmount: z.number().finite().nonnegative().default(0),
    icirWindow: positiveInt.max(2500).default(60),
    icirMinSamples: positiveInt.min(2).default(10),
    icirHorizon: positiveInt.max(60).default(5),
    horizons: z
      .array(positiveInt.max(60))
      .min(1)
      .max(10)
      .default([1, 5, 10, 20]),
    quantiles: z.union([z.literal(5), z.literal(10)]).default(5),
  })
  .strict()
  .superRefine((c, ctx) => {
    const error = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (
      new Set(c.factors.map((f) => f.factorId)).size !== c.factors.length ||
      new Set(c.horizons).size !== c.horizons.length
    )
      error("因子或期限重复");
    if (c.icirMinSamples > c.icirWindow) error("ICIR 最少样本数超过窗口");
    if (
      c.weightingMethod === "custom" &&
      (c.factors.some((f) => f.weight === undefined) ||
        !(c.factors.reduce((s, f) => s + f.weight!, 0) > 0) ||
        !Number.isFinite(c.factors.reduce((s, f) => s + f.weight!, 0)))
    )
      error("自定义权重须逐项填写且总和为正有限数");
    for (const f of c.factors)
      if (!f.formula && !alphaBuiltins.some((id) => id === f.factorId))
        error("未知内置因子 " + f.factorId);
  });
export type AlphaExperiment = z.infer<typeof alphaExperimentSchema>;
export const alphaTargetOptionsSchema = z
  .object({
    topN: positiveInt.max(500).default(10),
    every: positiveInt.max(250).default(5),
    maxWeight: fraction.positive().default(0.1),
  })
  .strict();
export type AlphaTargetOptions = z.infer<typeof alphaTargetOptionsSchema>;
export const alphaEvaluationInputSchema = z
  .object({
    start: date,
    end: date,
    snapshotId: hash.optional(),
    targetOptions: alphaTargetOptionsSchema.default({}),
  })
  .strict()
  .refine((v) => v.start <= v.end, "评估区间倒序");
export type AlphaEvaluationInput = z.infer<typeof alphaEvaluationInputSchema>;
const scheduledRow = z
  .object({
    strategyId: z.literal("alpha-top-n"),
    date,
    availableAt: date,
    sourceHash: hash,
    targets: z.record(symbol, fraction.positive()),
    scores: z.record(symbol, z.number().finite()),
  })
  .strict();
export type AlphaScheduledTarget = z.infer<typeof scheduledRow>;
export const alphaCalendarIndices = [
  "sh000001",
  "sh000300",
  "sh000906",
  "sz399001",
  "index-union",
] as const;
type AlphaCalendarIndex = (typeof alphaCalendarIndices)[number];
export const targetSnapshotSchema = z
  .object({
    version: z.literal(1),
    snapshotHash: hash,
    panelId: hash,
    start: date,
    end: date,
    options: alphaTargetOptionsSchema,
    calendarIndex: z.enum(alphaCalendarIndices).optional(),
    config: alphaExperimentSchema.optional(),
    scheduledTargets: z.array(scheduledRow),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (
      s.start > s.end ||
      s.scheduledTargets.some(
        (r, i) =>
          r.date !== r.availableAt ||
          r.date < s.start ||
          r.date > s.end ||
          (i > 0 && s.scheduledTargets[i - 1]!.date >= r.date) ||
          Object.keys(r.targets).length > s.options.topN ||
          Object.keys(r.targets).length !== Object.keys(r.scores).length ||
          Object.entries(r.targets).some(
            ([k, w]) =>
              !Object.hasOwn(r.scores, k) ||
              w !== Math.min(1 / s.options.topN, s.options.maxWeight),
          ),
      )
    )
      ctx.addIssue({ code: "custom", message: "冻结目标日期、持仓或权重非法" });
  });
export type TargetSnapshot = z.infer<typeof targetSnapshotSchema>;
const risk = z
  .object({
    reduceThreshold: fraction,
    pauseThreshold: fraction,
    recoverThreshold: fraction,
    recoverConsecutiveDays: z.number().int().positive(),
    reducedScale: fraction,
    maxTotalStopRisk: fraction,
    maxIndustryWeight: fraction,
    maxSingleInstrumentWeight: fraction,
    maxEtfWeight: fraction.nullable(),
    riskPerTrade: fraction,
    atrStopMultiple: z.number().positive().finite(),
    missingStopFraction: fraction.positive().nullable(),
  })
  .partial()
  .strict();
export const alphaBacktestInputSchema = z
  .object({
    snapshot: targetSnapshotSchema,
    costScenario: z.enum(["base", "double-cost"]).default("base"),
    initial: z.number().finite().positive().default(1_000_000),
    riskPolicy: risk.optional(),
  })
  .strict();
export type AlphaBacktestInput = z.input<typeof alphaBacktestInputSchema>;

const scoreSchema = z.object({ symbol, score: z.number().finite() }).strict();
export type AlphaScore = z.infer<typeof scoreSchema>;
const decisionSchema = z
  .object({
    date,
    scores: z
      .array(scoreSchema)
      .refine(
        (rows) => new Set(rows.map((s) => s.symbol)).size === rows.length,
        "单日证券重复",
      ),
  })
  .strict();
export function selectAlphaTargets(
  scores: readonly AlphaScore[],
  options: AlphaTargetOptions,
) {
  const selected = scores
    .filter((s) => Number.isFinite(s.score))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
    )
    .slice(0, options.topN);
  const weight = Math.min(1 / options.topN, options.maxWeight);
  return {
    targets: Object.fromEntries(selected.map((s) => [s.symbol, weight])),
    scores: Object.fromEntries(selected.map((s) => [s.symbol, s.score])),
  };
}
async function sha256(parts: readonly unknown[]) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(parts)),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
function targetHash(day: Omit<AlphaScheduledTarget, "sourceHash">) {
  // A later panel revision or a longer evaluation range cannot alter the digest of an identical decision.
  return sha256([
    1,
    day.strategyId,
    day.date,
    day.availableAt,
    Object.keys(day.targets)
      .sort()
      .map((s) => [s, day.targets[s], day.scores[s]]),
  ]);
}
function snapshotDigest(s: Omit<TargetSnapshot, "snapshotHash">) {
  return sha256([
    s.version,
    s.panelId,
    s.start,
    s.end,
    s.options.topN,
    s.options.every,
    s.options.maxWeight,
    s.scheduledTargets.map((r) => r.sourceHash),
    ...(s.calendarIndex || s.config
      ? [s.calendarIndex ?? null, s.config ?? null]
      : []),
  ]);
}
export async function createTargetSnapshot(
  panelId: string,
  input: z.input<typeof alphaEvaluationInputSchema>,
  decisions: readonly { date: string; scores: readonly AlphaScore[] }[],
  context?: { calendarIndex?: AlphaCalendarIndex; config: AlphaExperiment },
): Promise<TargetSnapshot> {
  const {
    start,
    end,
    targetOptions: options,
  } = alphaEvaluationInputSchema.parse(input);
  let i = 0;
  const scheduledTargets: TargetSnapshot["scheduledTargets"] = [];
  let previous = "";
  for (const decision of decisions) {
    const d = decisionSchema.parse(decision);
    if (d.date <= previous) throw new Error("决策日必须唯一且升序");
    previous = d.date;
    if (d.date < start || d.date > end) continue;
    if (i++ % options.every) continue;
    const row = {
      strategyId: "alpha-top-n" as const,
      date: d.date,
      availableAt: d.date,
      ...selectAlphaTargets(d.scores, options),
    };
    scheduledTargets.push({
      ...row,
      sourceHash: await targetHash(row),
    });
  }
  const snapshot = {
    version: 1 as const,
    panelId,
    start,
    end,
    options,
    scheduledTargets,
    ...context,
  };
  return targetSnapshotSchema.parse({
    ...snapshot,
    snapshotHash: await snapshotDigest(snapshot),
  });
}
export async function toScheduledTargets(
  snapshot: TargetSnapshot,
): Promise<AlphaScheduledTarget[]> {
  const s = targetSnapshotSchema.parse(snapshot);
  if ((await snapshotDigest(s)) !== s.snapshotHash)
    throw new Error("冻结快照摘要不匹配");
  for (const r of s.scheduledTargets)
    if ((await targetHash(r)) !== r.sourceHash)
      throw new Error("冻结目标摘要不匹配");
  return s.scheduledTargets;
}

type Vector = ArrayLike<number>;
function percentile(sorted: readonly number[], p: number) {
  const x = (sorted.length - 1) * p,
    i = Math.floor(x);
  return sorted[i]! + (sorted[Math.ceil(x)]! - sorted[i]!) * (x - i);
}
export function winsorize(
  values: Vector,
  method: AlphaExperiment["winsorizeMethod"],
  k = 3,
  tail = 0.01,
) {
  const out = Float64Array.from(values);
  if (method === "none") return out;
  const sorted = Array.from(values)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!sorted.length) return out;
  let lo: number, hi: number;
  if (method === "quantile") {
    lo = percentile(sorted, tail);
    hi = percentile(sorted, 1 - tail);
  } else {
    const m = percentile(sorted, 0.5),
      mad = percentile(
        sorted.map((v) => Math.abs(v - m)).sort((a, b) => a - b),
        0.5,
      );
    lo = m - k * 1.4826 * mad;
    hi = m + k * 1.4826 * mad;
  }
  return out.map((v) =>
    Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : NaN,
  );
}
export function zScore(values: Vector) {
  let sum = 0,
    n = 0,
    lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (Number.isFinite(v)) {
      sum += v;
      n++;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const m = sum / n;
  let squares = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (Number.isFinite(v)) squares += (v - m) ** 2;
  }
  const sd = Math.sqrt(squares / n);
  return Float64Array.from(values, (v) =>
    hi > lo && sd > 0 && Number.isFinite(v) ? (v - m) / sd : NaN,
  );
}
/** Frisch-Waugh-Lovell: remove group intercepts from BOTH response and log cap, then fit one slope.
 * Constant within-group size is collinear and adds no identifiable direction. */
export function neutralize(
  values: Vector,
  industry: Vector,
  cap: Vector,
  mode: AlphaExperiment["neutralizationMode"],
) {
  return neutralizeSection(values, industry, cap, mode).residuals;
}

function neutralizeSection(
  values: Vector,
  industry: Vector,
  cap: Vector,
  mode: AlphaExperiment["neutralizationMode"],
) {
  if (mode === "none")
    return { residuals: Float64Array.from(values), singularSize: false };
  const useIndustry = mode !== "size",
    useSize = mode !== "industry";
  const groups = new Map<number, { y: number; x: number; n: number }>();
  const out = new Float64Array(values.length).fill(NaN),
    size = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!,
      g = useIndustry ? industry[i]! : 0;
    if (
      !Number.isFinite(v) ||
      (useIndustry && !(g > 0)) ||
      (useSize && !(Number.isFinite(cap[i]) && cap[i]! > 0))
    )
      continue;
    const x = useSize ? Math.log(cap[i]!) : 0;
    size[i] = x;
    out[i] = v;
    const s = groups.get(g) ?? { y: 0, x: 0, n: 0 };
    s.y += v;
    s.x += x;
    s.n++;
    groups.set(g, s);
  }
  let xy = 0,
    xx = 0;
  for (let i = 0; i < values.length; i++)
    if (Number.isFinite(out[i])) {
      const s = groups.get(useIndustry ? industry[i]! : 0)!;
      out[i] = out[i]! - s.y / s.n;
      size[i] = size[i]! - s.x / s.n;
      xy += out[i]! * size[i]!;
      xx += size[i]! ** 2;
    }
  if (!useSize || !groups.size) return { residuals: out, singularSize: false };
  if (xx <= 1e-12) return { residuals: out.fill(NaN), singularSize: true };
  const slope = xy / xx;
  return {
    residuals: out.map((v, i) => v - slope * size[i]!),
    singularSize: false,
  };
}
/** Window ends at the latest sample whose entire forward return is observable at decision close. */
export function causalIcirWeights(
  history: readonly (readonly (number | null)[])[],
  t: number,
  c: AlphaExperiment,
) {
  const end = t - c.icirHorizon,
    start = Math.max(0, end - c.icirWindow + 1);
  const strengths = history.map((h) => {
    const samples =
      end < 0
        ? []
        : h.slice(start, end + 1).filter((x): x is number => x !== null);
    return samples.length < c.icirMinSamples
      ? null
      : icStatistics(samples).icir;
  });
  const total = strengths.reduce<number>((s, v) => s + Math.max(v ?? 0, 0), 0);
  const fallback = strengths.some((s) => s === null) || !(total > 0);
  return {
    weights: fallback
      ? history.map(() => 1 / history.length)
      : strengths.map((v) => Math.max(0, v!) / total),
    fallback,
  };
}
export function composeAlphaScores(
  columns: readonly Vector[],
  weights: readonly number[],
) {
  return Float64Array.from({ length: columns[0]?.length ?? 0 }, (_, i) => {
    let sum = 0,
      total = 0;
    columns.forEach((col, f) => {
      if (Number.isFinite(col[i]) && weights[f]! > 0) {
        sum += col[i]! * weights[f]!;
        total += weights[f]!;
      }
    });
    return total ? sum / total : NaN;
  });
}

/** All vectors share the market calendar. NaN denotes a missing observation. */
export type AlphaSecuritySeries = {
  symbol: string;
  close: Vector;
  volume: Vector;
  amount: Vector;
  industry: Vector;
  marketCap: Vector;
  factors: readonly Vector[];
  previousTradingDays?: number;
};
export type AlphaPanel = {
  panelId: string;
  calendar: readonly string[];
  calendarIndex?: AlphaCalendarIndex;
  calendarSource?: "index" | "panel-union";
  securities: readonly AlphaSecuritySeries[];
  indexCloses: Readonly<Record<string, Vector>>;
};

function eligibilityExclusion(
  s: AlphaSecuritySeries,
  t: number,
  observedDays: number,
  sum: number,
  count: number,
  c: AlphaExperiment,
) {
  const volume = s.volume[t]!,
    price = s.close[t]!,
    amount = s.amount[t]!;
  if (!observedDays) return "noTradingHistory";
  if (!Number.isFinite(volume) || volume === 0) return "suspended";
  if (volume < 0) return "invalidVolume";
  if (!Number.isFinite(price) || price <= 0) return "invalidPrice";
  if (!Number.isFinite(amount) || amount <= 0) return "invalidAmount";
  if (observedDays < c.minTradingDays) return "warmup";
  if (
    c.minAverageAmount > 0 &&
    (count < c.liquidityWindow || sum / count < c.minAverageAmount)
  )
    return "liquidity";
  return null;
}
export async function evaluateAlphaExperiment(
  panel: AlphaPanel,
  config: z.input<typeof alphaExperimentSchema>,
  input: z.input<typeof alphaEvaluationInputSchema>,
) {
  const c = alphaExperimentSchema.parse(config),
    request = alphaEvaluationInputSchema.parse(input);
  const { securities, calendar } = panel,
    n = securities.length;
  if (
    calendar.some((d, i) => i > 0 && d <= calendar[i - 1]!) ||
    new Set(securities.map((s) => s.symbol)).size !== n ||
    securities.some(
      (s) =>
        s.factors.length !== c.factors.length ||
        [
          s.close,
          s.volume,
          s.amount,
          s.industry,
          s.marketCap,
          ...s.factors,
        ].some((v) => v.length !== calendar.length),
    ) ||
    Object.values(panel.indexCloses).some((v) => v.length !== calendar.length)
  )
    throw new Error("Alpha 面板日期、证券或因子列未对齐");
  const begin = calendar.findIndex((d) => d >= request.start);
  if (begin < 0 || calendar[begin]! > request.end)
    throw new Error("评估区间无市场交易日");
  const count = securities.map((s) => s.previousTradingDays ?? 0),
    amountSum = new Float64Array(n),
    amountCount = new Uint32Array(n);
  const modes = [
    ...new Set([c.neutralizationMode, "none", "industry_size"] as const),
  ];
  type Mode = AlphaExperiment["neutralizationMode"];
  type Method = AlphaExperiment["weightingMethod"];
  const views = [
    { id: "selected", mode: c.neutralizationMode, method: c.weightingMethod },
    { id: "original", mode: "none", method: c.weightingMethod },
    { id: "strict", mode: "industry_size", method: c.weightingMethod },
    { id: "equal", mode: c.neutralizationMode, method: "equal" },
    { id: "icir", mode: c.neutralizationMode, method: "icir" },
  ] as const;
  const history = new Map(
    modes.map((mode) => [mode, c.factors.map(() => [] as (number | null)[])]),
  );
  const opts = { ...request, horizons: c.horizons, quantiles: c.quantiles };
  const accumulators = new Map<string, ReturnType<typeof factorAccumulator>>();
  for (const v of views)
    accumulators.set(v.mode + "/" + v.method, factorAccumulator(opts));
  const factorMetrics = c.factors.map(() => factorAccumulator(opts));
  const equal = c.factors.map(() => 1 / c.factors.length),
    custom = c.factors.map((f) => f.weight ?? 0);
  const customTotal = custom.reduce((s, x) => s + x, 0);
  if (customTotal > 0)
    custom.forEach((x, i) => {
      custom[i] = x / customTotal;
    });
  const daily: {
    date: string;
    eligible: number;
    scored: number;
    exclusions: Record<string, number>;
    missingCap: number;
    unknownIndustry: number;
    neutralizationExcluded: number;
    strictNeutralizationExcluded: number;
    zeroVarianceFactors: string[];
    singularSizeFactors: string[];
    singularCompositeSize: boolean;
    degenerateComposite: boolean;
    weights: number[];
    fallbackToEqual: boolean;
  }[] = [];
  const decisions: { date: string; scores: AlphaScore[] }[] = [];
  const benchmarkSeries = alphaBenchmarks.map((b) => ({
    ...b,
    horizons: c.horizons.map((horizon) => ({
      horizon,
      series: [] as { date: string; value: number | null }[],
    })),
  }));
  const fallbackCounts = new Map<Mode, number>();
  for (let t = 0; t < calendar.length && calendar[t]! <= request.end; t++) {
    const date = calendar[t]!,
      inRange = t >= begin;
    const eligible: number[] = [],
      exclusions: Record<string, number> = {
        noTradingHistory: 0,
        suspended: 0,
        invalidPrice: 0,
        invalidVolume: 0,
        invalidAmount: 0,
        warmup: 0,
        liquidity: 0,
      };
    let missingCap = 0,
      unknownIndustry = 0,
      neutralizationExcluded = 0,
      strictNeutralizationExcluded = 0;
    for (let j = 0; j < n; j++) {
      const s = securities[j]!,
        volume = s.volume[t]!,
        amount = s.amount[t]!;
      const observed = Number.isFinite(volume) && volume > 0;
      if (observed) count[j] = count[j]! + 1;
      // Trailing market sessions; absent turnover amounts never become zero observations.
      if (observed && Number.isFinite(amount) && amount > 0) {
        amountSum[j] = amountSum[j]! + amount;
        amountCount[j] = amountCount[j]! + 1;
      }
      const old = t - c.liquidityWindow;
      if (
        old >= 0 &&
        s.volume[old]! > 0 &&
        Number.isFinite(s.amount[old]) &&
        s.amount[old]! > 0
      ) {
        amountSum[j] = amountSum[j]! - s.amount[old]!;
        amountCount[j] = amountCount[j]! - 1;
      }
      const reason = eligibilityExclusion(
        s,
        t,
        count[j]!,
        amountSum[j]!,
        amountCount[j]!,
        c,
      );
      if (reason) {
        exclusions[reason] = exclusions[reason]! + 1;
        continue;
      }
      eligible.push(j);
      const capMissing = !(
          s.marketCap[t]! > 0 && Number.isFinite(s.marketCap[t])
        ),
        indMissing = !(s.industry[t]! > 0);
      if (capMissing) missingCap++;
      if (indMissing) unknownIndustry++;
      if (capMissing || indMissing) strictNeutralizationExcluded++;
      if (
        (capMissing &&
          (c.neutralizationMode === "size" ||
            c.neutralizationMode === "industry_size")) ||
        (indMissing &&
          (c.neutralizationMode === "industry" ||
            c.neutralizationMode === "industry_size"))
      )
        neutralizationExcluded++;
    }
    if (t < begin - c.icirWindow - c.icirHorizon) continue;
    const ret = (h: number, j: number) =>
      !(securities[j]!.volume[t + h]! > 0)
        ? NaN
        : forwardReturn(securities[j]!.close[t], securities[j]!.close[t + h]);
    const cap = eligible.map((j) => securities[j]!.marketCap[t]!),
      industry = eligible.map((j) => securities[j]!.industry[t]!);
    const raw = c.factors.map((f, k) =>
      zScore(
        winsorize(
          eligible.map((j) => securities[j]!.factors[k]![t]! * f.direction),
          c.winsorizeMethod,
          c.madK,
          c.quantileTail,
        ),
      ),
    );
    const zeroVarianceFactors: string[] = [],
      singularSizeFactors: string[] = [];
    let selectedWeights = equal,
      scored = 0,
      selectedFallback = false,
      singularCompositeSize = false,
      degenerateComposite = false;
    for (const mode of modes) {
      const factors =
        mode === "none"
          ? raw
          : raw.map((col, k) => {
              const { residuals, singularSize } = neutralizeSection(
                col,
                industry,
                cap,
                mode,
              );
              if (singularSize && mode === c.neutralizationMode)
                singularSizeFactors.push(c.factors[k]!.factorId);
              // Round-off in an exactly fitted response is not a rankable residual.
              if (!residuals.some((x) => Math.abs(x) > 1e-12))
                residuals.fill(NaN);
              return residuals;
            });
      if (mode === c.neutralizationMode)
        factors.forEach((col, k) => {
          if (
            !col.some(Number.isFinite) &&
            !singularSizeFactors.includes(c.factors[k]!.factorId) &&
            eligible.some(
              (j, i) =>
                Number.isFinite(securities[j]!.factors[k]![t]) &&
                (mode === "none" || mode === "size" || industry[i]! > 0) &&
                (mode === "none" ||
                  mode === "industry" ||
                  (Number.isFinite(cap[i]) && cap[i]! > 0)),
            )
          )
            zeroVarianceFactors.push(c.factors[k]!.factorId);
        });
      const hist = history.get(mode)!;
      const methods = new Set<Method>(
        views.filter((v) => v.mode === mode).map((v) => v.method),
      );
      if (methods.has("icir")) {
        for (const [k, col] of factors.entries()) {
          const x: number[] = [],
            y: number[] = [];
          for (let a = 0; a < eligible.length; a++) {
            const label = ret(c.icirHorizon, eligible[a]!);
            if (Number.isFinite(col[a]) && Number.isFinite(label)) {
              x.push(col[a]!);
              y.push(label);
            }
          }
          hist[k]![t] = spearman(x, y);
        }
      }
      if (!inRange) continue;
      function observe(
        acc: ReturnType<typeof factorAccumulator>,
        column: Vector,
      ) {
        const ids: number[] = [],
          xs: number[] = [];
        for (let i = 0; i < column.length; i++)
          if (Number.isFinite(column[i])) {
            ids.push(eligible[i]!);
            xs.push(column[i]!);
          }
        acc.add(date, t - begin, ids, xs, ret);
        return { ids, xs };
      }
      if (mode === c.neutralizationMode)
        factors.forEach((col, k) => observe(factorMetrics[k]!, col));
      const icir = methods.has("icir")
        ? causalIcirWeights(hist, t, c)
        : { weights: equal, fallback: false };
      if (icir.fallback)
        fallbackCounts.set(mode, (fallbackCounts.get(mode) ?? 0) + 1);
      for (const method of methods) {
        const weights =
          method === "custom"
            ? custom
            : method === "equal"
              ? equal
              : icir.weights;
        let scores = composeAlphaScores(factors, weights);
        let singularSize = false;
        // Available-factor normalization gives each name different weights when coverage differs.
        // Reproject the resulting portfolio signal to keep its own industry and size exposures neutral.
        if (mode !== "none" && factors.length > 1) {
          ({ residuals: scores, singularSize } = neutralizeSection(
            scores,
            industry,
            cap,
            mode,
          ));
        }
        let minScore = Infinity,
          maxScore = -Infinity;
        for (const score of scores) {
          if (!Number.isFinite(score)) continue;
          minScore = Math.min(minScore, score);
          maxScore = Math.max(maxScore, score);
        }
        const constantScores =
          minScore <= maxScore && maxScore - minScore <= 1e-12;
        if (constantScores) scores.fill(NaN);
        const { ids, xs } = observe(
          accumulators.get(mode + "/" + method)!,
          scores,
        );
        if (mode === c.neutralizationMode && method === c.weightingMethod) {
          selectedWeights = weights;
          scored = ids.length;
          selectedFallback = method === "icir" && icir.fallback;
          singularCompositeSize = singularSize;
          degenerateComposite = constantScores;
          // Only scheduled dates need scores. Retain at most N names per date in the worker result.
          const selected =
            (t - begin) % request.targetOptions.every === 0
              ? selectAlphaTargets(
                  ids.map((j, i) => ({
                    symbol: securities[j]!.symbol,
                    score: xs[i]!,
                  })),
                  request.targetOptions,
                ).scores
              : {};
          decisions.push({
            date,
            scores: Object.entries(selected).map(([symbol, score]) => ({
              symbol,
              score,
            })),
          });
        }
      }
    }
    if (!inRange) continue;
    daily.push({
      date,
      eligible: eligible.length,
      scored,
      exclusions,
      missingCap,
      unknownIndustry,
      neutralizationExcluded,
      strictNeutralizationExcluded,
      zeroVarianceFactors,
      singularSizeFactors,
      singularCompositeSize,
      degenerateComposite,
      weights: selectedWeights,
      fallbackToEqual: selectedFallback,
    });
    for (const b of benchmarkSeries)
      for (const h of b.horizons) {
        let value: number;
        if (b.id === "eligible-equal") {
          let sum = 0,
            valid = 0;
          for (const j of eligible) {
            const r = ret(h.horizon, j);
            if (Number.isFinite(r)) {
              valid++;
              sum += r;
            }
          }
          value = sum / valid;
        } else {
          const prices = panel.indexCloses[b.id];
          value = forwardReturn(prices?.[t], prices?.[t + h.horizon]);
        }
        h.series.push({ date, value: Number.isFinite(value) ? value : null });
      }
  }
  const metrics = accumulators
    .get(c.neutralizationMode + "/" + c.weightingMethod)!
    .result();
  const decay = (m: typeof metrics) =>
    m.horizons.map((h) => ({
      horizon: h.horizon,
      rankIC: h.icMean,
      icir: h.icIr,
      pearsonIC: h.pearson.mean,
      topBottom: h.spread,
    }));
  const comparisons = views.map((v) => ({
    ...v,
    decay: decay(accumulators.get(v.mode + "/" + v.method)!.result()),
    fallbackToEqualDays:
      v.method === "icir" ? (fallbackCounts.get(v.mode) ?? 0) : 0,
  }));
  const degenerateNeutralizeDays = daily.filter(
      (d) => d.singularSizeFactors.length || d.singularCompositeSize,
    ).length,
    degenerateCompositeDays = daily.filter((d) => d.degenerateComposite).length;
  return {
    config: c,
    input: request,
    metrics,
    factorMetrics: factorMetrics.map((a, k) => ({
      factorId: c.factors[k]!.factorId,
      metrics: a.result(),
    })),
    decay: decay(metrics),
    comparisons,
    daily,
    degenerateNeutralizeDays,
    degenerateCompositeDays,
    fallbackToEqualDays: daily.filter((d) => d.fallbackToEqual).length,
    benchmarks: benchmarkSeries.map((b) => ({
      ...b,
      horizons: b.horizons.map((h) => ({
        ...h,
        coverage:
          h.series.filter((p) => p.value !== null).length / h.series.length,
      })),
    })),
    targetSnapshot: await createTargetSnapshot(
      panel.panelId,
      { ...request, start: daily[0]!.date, end: daily.at(-1)!.date },
      decisions,
      { calendarIndex: panel.calendarIndex, config: c },
    ),
    metadata: {
      panelId: panel.panelId,
      universe: n,
      calendarSource: panel.calendarSource ?? "panel-union",
      calendar: panel.calendarIndex
        ? `本地面板指数 ${panel.calendarIndex} 交易日历；收益标签严格对齐日历`
        : "缺少覆盖评估区间的指数日历，使用本地面板交易日并集；全市场缺档日可能无法识别",
      survivorship:
        "证券池为冻结面板内的全部股票；指定子集快照仅覆盖该子集。当前本地文件可能遗漏已退市证券，存在存续样本偏差。",
      coverage: `GP16 市值仅使用当日有效观测；行业仅使用本地成员观测日起的分类，行业码 0 或缺市值时从相应中性化截面剔除。换手率为成交股数除以已生效的 GBBQ 流通股数，缺证据留空。log(GP16) 回归退化留空 ${degenerateNeutralizeDays} 日，合成得分为常量留空 ${degenerateCompositeDays} 日。`,
      formula:
        "公式取首个输出；递归指标从本地最早有成交的日线预热。公式 RPS 按同一冻结面板内有两端成交的股票逐周期排名，缺端点留空。",
      liquidity:
        "启用成交额门槛时要求最近窗口的每个市场交易日均有正成交额。预热以有正成交量的观测日计。",
      weights:
        "按方向调整后取成熟 RankIC 的滚动均值/样本标准差；负值截为 0，样本不足、方差为零或全无正权重时回退等权。",
      returns:
        "因果后复权收盘至市场 t+h 收盘，缺复权证据或目标日缺价留空；分组超额相对当日有标签的得分池。分组要求至少两倍组数的有效股票且分位边界无重复。累计按首日起每 h 日非重叠分组收益复利，仅累计有观测的区间。",
      targets:
        "每档 min(1/TopN, 权重上限)，不足留现金；调仓日没有有效得分时目标为空仓。",
    },
  };
}
export type AlphaEvaluationResult = Awaited<
  ReturnType<typeof evaluateAlphaExperiment>
>;
