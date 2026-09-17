import { z } from "zod";
import { asOfTimestampSchema, type AsOfDomain } from "./as-of";
import { researchDateSchema } from "./research-usage";

type Condition = {
  field: string;
  op: "gt" | "lt" | "gte" | "lte" | "eq" | "top" | "bottom";
  value: number | string | boolean;
};
type Template = {
  method: string;
  title: string;
  asset: string;
  conditions: Condition[];
  boundary?: string;
  source?: string;
};
const rule = (
  method: string,
  title: string,
  asset: string,
  field: string,
  op: Condition["op"],
  value: Condition["value"],
  boundary?: string,
): Template => ({
  method,
  title,
  asset,
  conditions: [{ field, op, value }],
  boundary,
});

// Only named source examples are registered. Text is descriptive, never evaluated.
export const queryTemplates: Record<string, Template> = {
  "gf-etf-top10": {
    ...rule(
      "QT-etf",
      "ETF涨幅榜前十",
      "domestic-equity-etf",
      "dailyReturnPct",
      "top",
      10,
    ),
    source: "gf-etf-rank/SKILL.md",
  },
  "gf-etf-five-day-rise3": {
    method: "QT-etf",
    title: "5日涨幅榜且连涨3天",
    asset: "domestic-equity-etf",
    conditions: [
      { field: "riseStreak", op: "gte", value: 3 },
      { field: "fiveDayReturnPct", op: "top", value: 10 },
    ],
    source: "gf-etf-rank/SKILL.md",
    boundary:
      "过滤连涨3天冻结为连续上涨至少3交易日；榜单大小工程固定默认10，先过滤后排名",
  },
  "gf-etf-flow": {
    ...rule(
      "QT-etf",
      "ETF主力资金榜默认前十",
      "domestic-equity-etf",
      "netFlowCny",
      "top",
      10,
    ),
    source: "gf-etf-rank/SKILL.md",
    boundary: "榜单大小工程固定默认10；资金统计单位与供应商口径须冻结",
  },
  "gf-etf-subscription": {
    ...rule(
      "QT-etf",
      "ETF净申购榜默认前十",
      "domestic-equity-etf",
      "netSubscriptionShares",
      "top",
      10,
    ),
    source: "gf-etf-rank/SKILL.md",
    boundary: "榜单大小工程固定默认10；净申购使用基金份额，不混用金额",
  },
  "gf-lhb-most3m": {
    ...rule(
      "QT-astock",
      "近3个月龙虎榜次数最多",
      "hs-stock",
      "lhbCount3m",
      "top",
      1,
    ),
    source: "gf-lhb/SKILL.md",
    boundary: "近3个自然月次数并列第一；仅筛选，不推断跟游资买入",
  },
  "mx-price500": {
    ...rule("QT-astock", "股价大于500元", "hs-stock", "closeCny", "gt", 500),
    source: "mx-ds-mcp-skill/SKILL.md",
  },
  "mx-pe-low50": {
    ...rule("QT-astock", "市盈率最低50只", "hs-stock", "pe", "bottom", 50),
    source: "mx-ds-mcp-skill/SKILL.md",
    boundary: "固定TTM市盈率；原文未排除负数，不暗加正PE条件",
  },
  "mx-chinext-pe-low50": {
    method: "QT-astock",
    title: "创业板市盈率最低50只",
    asset: "hs-stock",
    source: "mx-ds-mcp-skill/SKILL.md",
    conditions: [
      { field: "board", op: "eq", value: "chinext" },
      { field: "pe", op: "bottom", value: 50 },
    ],
    boundary: "先固定历史创业板成员，再按TTM市盈率升序；负PE保留",
  },
  "gf-industry-top2": {
    ...rule(
      "QT-astock",
      "行业指标排名前二",
      "hs-stock",
      "providerIndustryRank",
      "lte",
      2,
    ),
    source: "gf-quant/SKILL.md",
    boundary:
      "复现已发布行业指标排名；每次只允许一个冻结的指标与报告期，指标名称/方向/行业版本需证据，不把不同指标合并",
  },
  "astock-return5": rule(
    "QT-astock",
    "今日涨跌幅超过5%",
    "hs-stock",
    "dailyReturnPct",
    "gt",
    5,
  ),
  "astock-cap100": rule(
    "QT-astock",
    "市值大于100亿",
    "hs-stock",
    "marketCapCny",
    "gt",
    10_000_000_000,
  ),
  "astock-tech": rule(
    "QT-astock",
    "科技股",
    "hs-stock",
    "technology",
    "eq",
    true,
    "科技归属须提供冻结分类版本，不能按名称猜测",
  ),
  "astock-bank": rule("QT-astock", "银行股", "hs-stock", "bank", "eq", true),
  "astock-limitup": rule(
    "QT-astock",
    "今日涨停",
    "hs-stock",
    "closedAtLimitUp",
    "eq",
    true,
    "使用当期已核验涨停价状态，不添加统一10%阈值",
  ),
  "sector-top5": rule(
    "QT-sector",
    "涨幅前五板块",
    "sector",
    "dailyReturnPct",
    "top",
    5,
  ),
  "sector-top1": rule(
    "QT-sector",
    "今日涨幅最大板块",
    "sector",
    "dailyReturnPct",
    "top",
    1,
    "最大解释为并列第一，不偷换成前五",
  ),
  "sector-inflow": rule(
    "QT-sector",
    "资金净流入板块",
    "sector",
    "netFlowCny",
    "gt",
    0,
  ),
  "sector-tech": rule(
    "QT-sector",
    "科技板块",
    "sector",
    "technology",
    "eq",
    true,
  ),
  "etf-csi300": rule(
    "QT-etf",
    "沪深300ETF",
    "domestic-equity-etf",
    "trackingIndex",
    "eq",
    "sh000300",
  ),
  "etf-chinext": rule(
    "QT-etf",
    "创业板ETF",
    "domestic-equity-etf",
    "trackingIndex",
    "eq",
    "sz399006",
  ),
  "etf-size10": rule(
    "QT-etf",
    "规模大于10亿ETF",
    "domestic-equity-etf",
    "sizeCny",
    "gt",
    1_000_000_000,
  ),
  "etf-largest": rule(
    "QT-etf",
    "规模最大ETF",
    "domestic-equity-etf",
    "sizeCny",
    "top",
    1,
  ),
  "cb-premium10": rule(
    "QT-cb",
    "转股溢价率低于10%",
    "convertible",
    "conversionPremiumPct",
    "lt",
    10,
  ),
  "cb-aaa": rule("QT-cb", "AAA级可转债", "convertible", "rating", "eq", "AAA"),
  "cb-years3": rule(
    "QT-cb",
    "剩余期限3年内",
    "convertible",
    "remainingYears",
    "lte",
    3,
    "工程按剩余自然日/365.25，不等同赎回安全保证",
  ),
  "fund-equity": rule(
    "QT-fund",
    "股票型基金",
    "fund",
    "fundType",
    "eq",
    "equity",
  ),
  "fund-best": rule(
    "QT-fund",
    "收益最好基金",
    "fund",
    "trailingYearReturnPct",
    "top",
    1,
    "原文未指定收益窗口，冻结过去365自然日净值含分红收益工程版",
  ),
  "fund-size100": rule(
    "QT-fund",
    "百亿规模基金",
    "fund",
    "sizeCny",
    "gte",
    10_000_000_000,
  ),
  "fundcompany-top10": rule(
    "QT-fundcompany",
    "规模前十基金公司",
    "fundcompany",
    "sizeCny",
    "top",
    10,
  ),
  "fundcompany-largest": rule(
    "QT-fundcompany",
    "规模最大基金公司",
    "fundcompany",
    "sizeCny",
    "top",
    1,
  ),
  "fundcompany-head": rule(
    "QT-fundcompany",
    "头部基金公司",
    "fundcompany",
    "sizeCny",
    "top",
    10,
    "头部工程解释为同文规模前十",
  ),
  "fundcompany-best": rule(
    "QT-fundcompany",
    "业绩最好基金公司",
    "fundcompany",
    "trailingYearReturnPct",
    "top",
    1,
    "需冻结旗下基金及期初资产加权365日含分红收益，不能混用明星产品",
  ),
  "fundmanager-top10": rule(
    "QT-fundmanager",
    "近一年收益前十基金经理",
    "fundmanager",
    "trailingYearReturnPct",
    "top",
    10,
  ),
  "fundmanager-best": rule(
    "QT-fundmanager",
    "业绩最好基金经理",
    "fundmanager",
    "trailingYearReturnPct",
    "top",
    1,
    "冻结365日与任职期管理份额，业绩归属证据缺失则不可用",
  ),
  "fundmanager-size100": rule(
    "QT-fundmanager",
    "百亿基金经理",
    "fundmanager",
    "sizeCny",
    "gte",
    10_000_000_000,
  ),
  "fundmanager-star": rule(
    "QT-fundmanager",
    "明星基金经理",
    "fundmanager",
    "starClassification",
    "eq",
    true,
    "来源没有明星标准；仅保留有事前冻结分类证据的版本，不推断明星",
  ),
  "futures-oil": rule(
    "QT-futures",
    "原油期货",
    "futures",
    "underlying",
    "eq",
    "crude-oil",
  ),
  "futures-gold": rule(
    "QT-futures",
    "黄金期货",
    "futures",
    "underlying",
    "eq",
    "gold",
  ),
  "futures-rebar": rule(
    "QT-futures",
    "螺纹钢期货",
    "futures",
    "underlying",
    "eq",
    "rebar",
  ),
  "futures-long": rule(
    "QT-futures",
    "多头持仓期货",
    "futures",
    "longPositions",
    "gt",
    0,
    "仅有多头持仓不代表净多或看涨，不生成方向交易",
  ),
  "hk-tech": rule(
    "QT-hkstock",
    "港股科技股",
    "hk-stock",
    "technology",
    "eq",
    true,
  ),
  "hk-bank": rule("QT-hkstock", "港股银行股", "hk-stock", "bank", "eq", true),
  "hk-return5": rule(
    "QT-hkstock",
    "港股涨跌幅超过5%",
    "hk-stock",
    "dailyReturnPct",
    "gt",
    5,
  ),
  "hk-northbound": rule(
    "QT-hkstock",
    "北向资金增持港股",
    "hk-stock",
    "northboundHoldingChange",
    "gt",
    0,
    "原文方向与市场冲突；不可执行且不得暗改南向",
  ),
  "us-buy-rating": rule(
    "QT-usstock",
    "评级买入美股",
    "us-stock",
    "rating",
    "eq",
    "buy",
  ),
  "us-tech": rule(
    "QT-usstock",
    "美股科技股",
    "us-stock",
    "technology",
    "eq",
    true,
  ),
  "us-pe20": rule(
    "QT-usstock",
    "美股市盈率低于20",
    "us-stock",
    "pe",
    "lt",
    20,
    "原文无正PE条件，负PE仍保留通过，不擅加盈利筛选",
  ),
  "us-top5": rule(
    "QT-usstock",
    "涨幅前五美股",
    "us-stock",
    "dailyReturnPct",
    "top",
    5,
  ),
};

export const queryFieldUnits: Record<string, string> = {
  riseStreak: "consecutive-positive-trading-days",
  fiveDayReturnPct: "5-trading-day-return-%",
  netSubscriptionShares: "fund-shares",
  lhbCount3m: "3-calendar-month-listing-count",
  closeCny: "CNY/share",
  board: "historical-board",
  providerIndustryRank: "published-industry-indicator-rank",
  dailyReturnPct: "%",
  marketCapCny: "CNY",
  sizeCny: "CNY",
  netFlowCny: "CNY",
  technology: "frozen-classification",
  bank: "frozen-classification",
  starClassification: "frozen-classification",
  closedAtLimitUp: "verified-limit-state",
  trackingIndex: "index-id",
  conversionPremiumPct: "%",
  rating: "published-rating",
  remainingYears: "days/365.25",
  fundType: "fund-type",
  trailingYearReturnPct: "365-calendar-day-total-return-%",
  underlying: "underlying-id",
  longPositions: "contracts",
  northboundHoldingChange: "shares",
  pe: "TTM-multiple",
};
const text = z.string().trim().min(1);
export const queryTemplateAliases = [
  {
    source: "hithink-market-query/SKILL.md",
    example: "MACD金叉的股票",
    method: "SW06-macd-golden",
    preset: "macd-golden",
    boundary: "复用本地12/26/9 DIF上穿DEA，不让问财当前结果替代历史指标",
  },
] as const;
const observation = z
  .object({
    value: z.union([z.number().finite(), z.string(), z.boolean()]),
    unit: text,
    evidence: text,
    version: text,
    effectiveAt: researchDateSchema,
    availableAt: asOfTimestampSchema,
    capturedAt: asOfTimestampSchema,
  })
  .strict();
export const queryPanelSchema = z
  .object({
    asset: z.enum([
      "hs-stock",
      "sector",
      "domestic-equity-etf",
      "convertible",
      "fund",
      "fundcompany",
      "fundmanager",
      "futures",
      "hk-stock",
      "us-stock",
    ]),
    date: researchDateSchema,
    sessionClosedAt: asOfTimestampSchema,
    sessionEvidence: text,
    universeId: text,
    membershipEvidence: text,
    rankingContext: z
      .object({
        metric: text,
        reportPeriod: researchDateSchema,
        direction: z.enum(["ascending", "descending"]),
        industryVersion: text,
        availableAt: asOfTimestampSchema,
        evidence: text,
      })
      .strict()
      .optional(),
    universe: z.array(text).min(1),
    rows: z
      .array(z.object({ id: text, values: z.record(observation) }).strict())
      .min(1),
  })
  .strict()
  .refine(
    (p) =>
      (p.asset !== "hs-stock" ||
        p.universe.every((id) => /^(sh(60|68)|sz(00|30))\d{4}$/.test(id))) &&
      new Set(p.universe).size === p.universe.length &&
      new Set(p.rows.map((r) => r.id)).size === p.rows.length &&
      p.rows.length === p.universe.length &&
      p.rows.every((r) => p.universe.includes(r.id)),
    "完整证券池成员与数据行须一一对应；不能以查询第一页冒充全池",
  );

export const queryFactorRules = Object.fromEntries(
  [...new Set(Object.values(queryTemplates).map((t) => t.method))].map(
    (method) => [
      method,
      "逐例冻结筛选，不解析自然语言，不自动放宽；每日收盘筛选，次一合法开盘等权再平衡、落选退出；品种独立，缺数据不造结果",
    ],
  ),
);

/** Pure screening only. Execution must use the registered market's separate rules. */
export function evaluateQueryTemplate(
  id: string,
  raw: unknown,
  cutoff: { asOf: string; capturedBy?: string },
) {
  const template = queryTemplates[id];
  if (!template) throw new Error("未知固定查询预设，禁止自由文本规则");
  const clock = z
    .object({
      asOf: asOfTimestampSchema,
      capturedBy: asOfTimestampSchema.optional(),
    })
    .parse(cutoff);
  const parsed = queryPanelSchema.safeParse(raw);
  const base = {
    id,
    ...template,
    version: "query-template-v1",
    source:
      template.source ??
      `hithink-${template.method.slice(3)}-selector/SKILL.md`,
    schedule: {
      observe: "daily-close",
      rebalance: "next-legal-open",
      exit: "removed-at-next-legal-open",
      allocation: "equal-weight-with-cash-and-capacity-limits",
    },
    stockBacktestEligible: template.asset === "hs-stock",
    selected: [] as string[],
    missing: [] as string[],
  };
  if (!parsed.success)
    return {
      ...base,
      status: "missing" as const,
      missing: [parsed.error.message],
    };
  const p = parsed.data;
  if (p.asset !== template.asset)
    return {
      ...base,
      status: "not-applicable" as const,
      missing: [`需要${template.asset}独立证券池；不得混入${p.asset}`],
    };
  if (id === "hk-northbound")
    return {
      ...base,
      status: "rule-unresolved" as const,
      missing: [template.boundary!],
    };
  const missing: string[] = [];
  if (
    id === "gf-industry-top2" &&
    (!p.rankingContext ||
      p.rankingContext.reportPeriod > p.date ||
      Date.parse(p.rankingContext.availableAt) > Date.parse(clock.asOf))
  )
    missing.push("行业排名须冻结同一指标、报告期、方向、分类版本及其可知时间");
  const fields = template.conditions.map((c) => c.field);
  for (const row of p.rows)
    for (const field of fields) {
      const v = row.values[field];
      const numeric =
        template.conditions.find((c) => c.field === field)!.op !== "eq";
      if (
        !v ||
        v.unit !== queryFieldUnits[field] ||
        v.effectiveAt !== p.date ||
        Date.parse(v.availableAt) > Date.parse(clock.asOf) ||
        Date.parse(v.capturedAt) < Date.parse(v.availableAt) ||
        (clock.capturedBy != null &&
          Date.parse(v.capturedAt) > Date.parse(clock.capturedBy)) ||
        (numeric && typeof v.value !== "number") ||
        ([
          "remainingYears",
          "longPositions",
          "lhbCount3m",
          "riseStreak",
        ].includes(field) &&
          (typeof v.value !== "number" || v.value < 0)) ||
        (["longPositions", "lhbCount3m", "riseStreak"].includes(field) &&
          (typeof v.value !== "number" || !Number.isInteger(v.value))) ||
        (field === "providerIndustryRank" &&
          (typeof v.value !== "number" ||
            !Number.isInteger(v.value) ||
            v.value < 1)) ||
        (!numeric &&
          typeof v.value !==
            typeof template.conditions.find((c) => c.field === field)!.value)
      )
        missing.push(`${row.id}/${field}:字段、单位、可知时点或版本缺失`);
    }
  if (
    Date.parse(p.sessionClosedAt) > Date.parse(clock.asOf) ||
    (["hs-stock", "sector", "domestic-equity-etf"].includes(p.asset) &&
      Date.parse(p.sessionClosedAt) < Date.parse(`${p.date}T15:00:00+08:00`))
  )
    missing.push("必须有当日收盘时间证据，不能提前使用最终值");
  if (missing.length) return { ...base, status: "missing" as const, missing };
  const matches = (value: string | number | boolean, c: Condition) => {
    if (c.op === "eq") return value === c.value;
    const n = value as number,
      threshold = c.value as number;
    if (c.op === "gt") return n > threshold;
    if (c.op === "gte") return n >= threshold;
    if (c.op === "lt") return n < threshold;
    return n <= threshold;
  };
  const cohort = p.rows.filter((row) =>
    template.conditions
      .filter((c) => c.op !== "top" && c.op !== "bottom")
      .every((c) => matches(row.values[c.field]!.value, c)),
  );
  const selected = p.rows
    .filter((row) =>
      template.conditions.every((c) => {
        const v = row.values[c.field]!.value;
        const n = v as number,
          threshold = c.value as number;
        if (c.op === "top" || c.op === "bottom")
          return (
            1 +
              cohort.filter((other) =>
                c.op === "top"
                  ? (other.values[c.field]!.value as number) > n
                  : (other.values[c.field]!.value as number) < n,
              ).length <=
            threshold
          );
        return matches(v, c);
      }),
    )
    .map((row) => row.id)
    .sort();
  return {
    ...base,
    selected,
    status: "computed" as const,
    evidence: {
      ...p,
      universe: [...p.universe].sort(),
      rows: [...p.rows].sort((a, b) => a.id.localeCompare(b.id)),
    },
    ties: "competition-rank-inclusive",
    realBacktest: false,
  };
}

export function evaluateQueryFactor(
  id: string,
  req: {
    symbol: string;
    observationDate: string;
    asOf: string;
    capturedBy?: string;
  },
  read: (domain: AsOfDomain, field: string, at: string) => unknown,
) {
  const panel = read("capital", "queryPanel", req.observationDate);
  const parsed = queryPanelSchema.parse(panel);
  if (parsed.date !== req.observationDate)
    throw new Error("查询截面日期不匹配");
  const templates = Object.entries(queryTemplates).filter(
    ([, t]) => t.method === id,
  );
  if (!templates.length) throw new Error("未知查询方法");
  const variants = templates.map(([key]) =>
    evaluateQueryTemplate(key, panel, req),
  );
  if (!variants.some((v) => v.status === "computed"))
    throw new Error(
      variants
        .map((v) => `${v.id}:${v.status}:${v.missing.join("；")}`)
        .join("\n"),
    );
  // Never collapse independent templates to an OR-based trading signal.
  return {
    points: 0,
    participation: "rule" as const,
    details: {
      buyEligible: false,
      action: "screening-variants-only",
      variants,
      aliases: id === "QT-astock" ? queryTemplateAliases : [],
      futureMarket: !["QT-astock", "QT-sector", "QT-etf"].includes(id),
      limitations: [
        "逐预设独立结果；没有合并买入信号",
        "板块需另有历史成员映射，ETF与后续品种不能转成沪深股票成交",
        "未接真实历史数据，未执行交易回测",
      ],
    },
  };
}

/** Frozen selection changes are intents, never fills. Missing snapshots retain positions. */
export function queryRebalance(
  result: ReturnType<typeof evaluateQueryTemplate>,
  held: readonly string[],
) {
  if (result.status !== "computed" || !result.stockBacktestEligible)
    return {
      status: "unavailable" as const,
      entries: [],
      exits: [],
      retained: [...held].sort(),
      reason:
        result.status !== "computed"
          ? result.status
          : "后续品种或板块不能进入沪深股票执行器",
    };
  const selected = new Set(result.selected),
    existing = new Set(held);
  return {
    status: "ready" as const,
    entries: result.selected.filter((id) => !existing.has(id)),
    exits: [...existing].filter((id) => !selected.has(id)).sort(),
    retained: [...existing].filter((id) => selected.has(id)).sort(),
    targetWeight: result.selected.length ? 1 / result.selected.length : 0,
    execution: result.schedule,
    reason: null,
  };
}
