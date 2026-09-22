import { z } from "zod";
import { evidenceEnvelope } from "../../infra/evidence";
import type { Evidence } from "~/lib/domain";

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const time = Date.parse(`${v}T00:00:00Z`);
    return (
      Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === v
    );
  }, "无效日历日期");
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().finite().nonnegative();
const percent = z.number().finite().min(0).max(100);
const timestamp = z
  .number()
  .int()
  .nonnegative()
  .max(Date.parse("9999-12-31T15:59:59.999Z"));
const provenance = z
  .object({
    evidenceId: z.string().min(1),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.string().min(1),
    asOf: day,
    fetchedAt: timestamp,
  })
  .strict();

// Adapters must verify the source payload and its universe before constructing
// these inputs. A well-formed number or citation alone is not source verification.
export const marketSentimentInputSchema = z
  .object({
    cutoff: day,
    observedAt: timestamp,
    maxAgeDays: z.number().int().min(0).max(31),
    activity: z
      .object({
        provenance,
        universe: z.literal("legu-all-a"),
        up: count,
        down: count,
        realLimitUp: count,
        realLimitDown: count,
        limitDefinition: z.literal("exclude-st-one-price-no-volume"),
      })
      .strict()
      .refine(
        (v) =>
          Number.isSafeInteger(v.up + v.down) &&
          Number.isSafeInteger(v.realLimitUp + v.realLimitDown),
        "家数合计超出安全整数",
      )
      .nullable(),
    strength: z
      .object({
        provenance,
        universe: z.literal("legu-all-a"),
        window: z.literal(20),
        newHigh: count,
        newLow: count,
      })
      .strict()
      .refine(
        (v) => Number.isSafeInteger(v.newHigh + v.newLow),
        "家数合计超出安全整数",
      )
      .nullable(),
    valuation: z
      .object({
        provenance,
        universe: z.literal("legu-all-a"),
        metric: z.literal("pe-ttm-median"),
        lookbackYears: z.literal(10),
        percentile: percent,
      })
      .strict()
      .nullable(),
    leverage: z
      .object({
        provenance,
        universe: z.literal("sse-szse-financing"),
        currency: z.literal("CNY"),
        unit: z.literal("yuan"),
        observations: z.literal(60),
        balance: amount,
        peakIncludingCurrent: amount.positive(),
      })
      .strict()
      .refine(
        (v) => v.balance <= v.peakIncludingCurrent,
        "含当日的60观测峰值不能低于当日融资余额",
      )
      .nullable(),
  })
  .strict();
export type MarketSentimentInput = z.infer<typeof marketSentimentInputSchema>;
type Provenance = z.infer<typeof provenance>;
export const marketSentimentVersion = "ashare-fear-greed-1";

function label(score: number | null) {
  if (score === null) return null;
  const thresholds = [20, 40, 45, 55, 65, 75, 85];
  const labels = [
    "极度恐惧",
    "恐惧",
    "偏冷",
    "中性",
    "偏热",
    "贪婪",
    "极度贪婪",
    "狂热",
  ];
  const index = thresholds.findIndex((limit) => score < limit);
  return labels[index === -1 ? 7 : index]!;
}

export function marketSentiment(input: MarketSentimentInput) {
  const data = marketSentimentInputSchema.parse(input);
  const sources = new Map<string, string>();
  for (const item of [
    data.activity,
    data.strength,
    data.valuation,
    data.leverage,
  ]) {
    if (!item) continue;
    const p = item.provenance,
      encoded = JSON.stringify(p);
    if (sources.has(p.evidenceId) && sources.get(p.evidenceId) !== encoded)
      throw new Error("同一证据ID不能指向不同来源、日期或哈希");
    sources.set(p.evidenceId, encoded);
  }
  const observedDay = new Date(data.observedAt + 8 * 3600000)
    .toISOString()
    .slice(0, 10);
  if (data.cutoff > observedDay)
    throw new Error("市场背景截止日不能晚于采集日");
  const cutoffMs = Date.parse(`${data.cutoff}T00:00:00Z`);
  const unavailable = (p: Provenance | undefined) => {
    if (!p) return "未取得该因子的已核验证据";
    if (p.fetchedAt > data.observedAt) return "证据采集时间晚于本次观察时间";
    if (p.asOf > data.cutoff) return "源日期晚于研究截止日";
    const fetchedDay = new Date(p.fetchedAt + 8 * 3600000)
      .toISOString()
      .slice(0, 10);
    if (p.asOf > fetchedDay) return "源日期晚于证据采集日";
    if (
      (cutoffMs - Date.parse(`${p.asOf}T00:00:00Z`)) / 86400000 >
      data.maxAgeDays
    )
      return "源日期超过本次显式允许的日历天数";
    return null;
  };
  const ratio = (a: number, b: number) =>
    a + b === 0 ? null : (a / (a + b)) * 100;
  const a = data.activity,
    s = data.strength,
    v = data.valuation,
    l = data.leverage;
  const specs = [
    {
      key: "breadth",
      weight: 25,
      source: a?.provenance,
      value: a ? ratio(a.up, a.down) : null,
      formula: "上涨/(上涨+下跌)*100",
    },
    {
      key: "limits",
      weight: 20,
      source: a?.provenance,
      value: a ? ratio(a.realLimitUp, a.realLimitDown) : null,
      formula: "真实涨停/(真实涨停+真实跌停)*100",
    },
    {
      key: "strength",
      weight: 25,
      source: s?.provenance,
      value: s ? ratio(s.newHigh, s.newLow) : null,
      formula: "20日新高/(20日新高+20日新低)*100",
    },
    {
      key: "valuation",
      weight: 15,
      source: v?.provenance,
      value: v?.percentile ?? null,
      formula: "全A PE(TTM)中位数近10年百分位",
    },
    {
      key: "leverage",
      weight: 15,
      source: l?.provenance,
      value: l
        ? Math.min(
            100,
            Math.max(
              0,
              ((l.balance / l.peakIncludingCurrent - 0.85) / 0.15) * 100,
            ),
          )
        : null,
      formula: "clamp((融资余额/含当日60观测峰值-0.85)/0.15*100,0,100)",
    },
  ];
  const candidates = specs.map((f) => {
    const missing =
      unavailable(f.source) ??
      (f.value === null ? "分母为零，比例未定义" : null);
    return {
      ...f,
      source: f.source ?? null,
      value: missing ? null : f.value,
      missing,
    };
  });
  const availableWeight = candidates.reduce(
    (sum, f) => sum + (f.value === null ? 0 : f.weight),
    0,
  );
  const factors = candidates.map((f) => ({
    ...f,
    effectiveWeight: f.value === null ? 0 : f.weight / availableWeight,
  }));
  const used = factors.filter((f) => f.value !== null).length;
  const score = used
    ? factors.reduce((sum, f) => sum + (f.value ?? 0) * f.effectiveWeight, 0)
    : null;
  return {
    version: marketSentimentVersion,
    cutoff: data.cutoff,
    observedAt: data.observedAt,
    maxAgeDays: data.maxAgeDays,
    score,
    label: label(score),
    used,
    total: 5,
    coverage: used === 5 ? "complete" : used ? "partial" : "unavailable",
    factors,
    citations: [
      ...new Set(
        factors
          .filter((f) => f.value !== null)
          .map((f) => f.source!.evidenceId),
      ),
    ],
    missing: factors
      .filter((f) => f.missing)
      .map((f) => ({ factor: f.key, reason: f.missing! })),
    warnings: [
      "自建A股恐惧贪婪代理（0–100），非官方指数；不等于九维市场情绪总分，不与CNN或加密恐贪读数横向比较。",
      "缺失因子剔除后按剩余权重归一化；覆盖数量不等于统计置信度。",
      "因子来自不同统计口径，保留各自来源日期；单日宽度与涨跌停可能受反弹影响，不能替代20日趋势。",
      "此计算只筛源日期，不证明资料当时已经公开；当前抓取的历史行不能直接用于无前视回测。",
      "无可比较的连续归档时不生成5日均值、5日变化、历史顶部或交易动作。",
    ],
  };
}

export function marketSentimentEvidence(input: MarketSentimentInput): Evidence {
  const normalized = marketSentimentInputSchema.parse(input);
  const facts = marketSentiment(normalized);
  const payload = { input: normalized, facts };
  const dates = [
    ...new Set(
      facts.factors.filter((f) => f.value !== null).map((f) => f.source!.asOf),
    ),
  ];
  const envelope = evidenceEnvelope(payload, {
    source: "market-sentiment/ashare-proxy",
    symbol: null,
    type: "quote-financial",
    asOf: dates.length === 1 ? dates[0]! : null,
    publishedAt: null,
    fetchedAt: normalized.observedAt,
    currency: null,
    unit: { score: "0–100", effectiveWeight: "ratio" },
    adjustment: "not-applicable",
    reportPeriod: null,
    quality: facts.used ? "partial" : "unavailable",
    warnings: facts.warnings,
  });
  return {
    id: `market-sentiment-${envelope.payloadHash}`,
    source: "市场情绪 / 自建A股五因子代理 / JS计算",
    asOf: envelope.asOf ?? "各因子日期分别披露",
    text: JSON.stringify(payload),
    envelope,
  };
}
