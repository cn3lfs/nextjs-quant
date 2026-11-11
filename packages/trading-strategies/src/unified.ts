import {
  portfolioRpsDefinitions,
  portfolioRpsFactorMetadata,
} from "./portfolio-rps/index.js";
import {
  portfolioClassicDefinitions,
  portfolioClassicFactorMetadata,
} from "./portfolio-classics/index.js";
import { classicDefinitions } from "./classics/index.js";
import {
  nativeStudyDefinition,
  isNativeStudyStrategy,
  createNativeStudyRule,
  type FrozenChanObservation,
} from "./native-study.js";
import {
  riskParityWeights,
  type PortfolioReturn,
} from "./portfolio-risk-parity.js";
import { representativeSources } from "./research/representative-sources.js";
import {
  strategyCategoryForFamily,
  type StrategyCategory,
} from "./taxonomy.js";
import type { Bar } from "trading-strategy-core/bars";
import {
  studyCatalog,
  studyStrategies,
  studyWarmup,
  type StudyStrategy,
} from "./study-catalog.js";
import { createExtendedStudyRule } from "./study-rules.js";
import { strategyRepresentatives } from "./catalog.js";
import {
  createStudyDecision,
  type StudyDecisionState,
  type StudyOrder,
} from "./study-decision.js";

export type StrategyDataCapability =
  | "ohlcv"
  | "account-state"
  | "cross-section"
  | "point-in-time-financials"
  | "market-cap"
  | "structure"
  | "events"
  | "derivatives"
  | "order-book"
  | "training"
  | "short-borrow"
  | "sentiment-panel"
  | "news-evidence"
  | "valuation-evidence";
export type StrategyDefinition = {
  category: StrategyCategory;
  id: string;
  version: number;
  name: string;
  family: string;
  rule: string;
  origin: "international" | "domestic";
  sources: readonly string[];
  capabilities: readonly StrategyDataCapability[];
  output: "signal" | "weights" | "order" | "research";
  implementation: "implemented" | "research-only" | "missing-data";
  warmupBars: number;
  candidateFactors?: readonly StrategyCandidateFactor[];
};
export type StrategyCandidateFactor = {
  id: string;
  period: number | null;
  skip: number;
  unit: "ratio" | "yuan";
  benchmark?: string;
  exclusiveMinimum?: number;
};
export const strategyCandidateFactors: Readonly<
  Record<string, StrategyCandidateFactor>
> = {
  ...portfolioClassicFactorMetadata,
  ...portfolioRpsFactorMetadata,
  momentum: { id: "momentum", period: 250, skip: 20, unit: "ratio" },
  shortReturn: { id: "shortReturn", period: 5, skip: 0, unit: "ratio" },
  earningsYield: { id: "earningsYield", period: null, skip: 0, unit: "ratio" },
  bookToPrice: { id: "bookToPrice", period: null, skip: 0, unit: "ratio" },
  cashflowYield: { id: "cashflowYield", period: null, skip: 0, unit: "ratio" },
  roe: { id: "roe", period: null, skip: 0, unit: "ratio" },
  profitGrowth: { id: "profitGrowth", period: null, skip: 0, unit: "ratio" },
  marketCap: { id: "marketCap", period: null, skip: 0, unit: "yuan" },
  volatility: { id: "volatility", period: 60, skip: 0, unit: "ratio" },
  beta: {
    id: "beta",
    period: 60,
    skip: 0,
    unit: "ratio",
    benchmark: "sh000300",
  },
};
export type StrategyInstance = {
  strategyId: string;
  parameters?: { topK?: number };
};
/** Factor values must already be point-in-time, normalized units; missing remains null. */
export type StrategyCandidate = {
  symbol: string;
  availableAt: string;
  values: Readonly<Record<string, number | null>>;
  returns?: readonly PortfolioReturn[];
};
export type StrategyContext = {
  asOf: string;
  bars?: readonly Bar[];
  index?: number;
  position?: { entry: number; entryIndex: number };
  candidates?: readonly StrategyCandidate[];
  account?: StudyDecisionState & { initial: number; firstIndex: number };
  native?: {
    firstIndex: number;
    observations: readonly FrozenChanObservation[];
  };
};
export type StrategyOutput =
  | { kind: "order"; order: StudyOrder | null; allocationMonth: string }
  | { kind: "signal"; enter: boolean; exit: boolean }
  | {
      kind: "weights";
      weights: { symbol: string; weight: number }[];
      excluded: string[];
    };
export type StrategyAvailability = {
  available: boolean;
  missing: StrategyDataCapability[];
  reason: string | null;
};

const technicalSource =
  "https://www.quantconnect.com/learning/articles/investment-strategy-library";
const factorSource =
  "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html";
const allocationIds = [
  "hold",
  "hold80",
  "grid",
  "vol-target",
  "constant-mix",
  "cppi",
  "dca",
] as const;
const accountIds: readonly string[] = [
  ...allocationIds,
  "ma",
  "breakout",
  "pullback",
  "range",
];
const researchCapabilities: Record<string, readonly StrategyDataCapability[]> =
  {
    wyckoff: ["ohlcv", "structure"],
    chan: ["ohlcv", "structure"],
    growth: ["ohlcv"],
    value: ["point-in-time-financials", "market-cap", "valuation-evidence"],
    sentiment: ["sentiment-panel"],
    "industry-chain": ["news-evidence", "events"],
  };
const portfolioDefinitions = [
  {
    id: "rank-momentum",
    name: "横截面动量",
    family: "动量",
    factors: ["momentum"],
    descending: true,
    capabilities: ["ohlcv", "cross-section"],
    rule: "按截至决策日的跳过近期动量降序，前K只等权；默认K=10。",
  },
  {
    id: "rank-reversal",
    name: "短期反转组合",
    family: "反转",
    factors: ["shortReturn"],
    descending: false,
    capabilities: ["ohlcv", "cross-section"],
    rule: "按短期收益升序，前K只等权；默认K=10。",
  },
  {
    id: "rank-value",
    name: "盈利收益率组合",
    family: "价值",
    factors: ["earningsYield"],
    descending: true,
    capabilities: ["cross-section", "point-in-time-financials", "market-cap"],
    rule: "按当时可见盈利收益率E/P降序，前K只等权；负值不补零。",
  },
  {
    id: "rank-book-value",
    name: "账面市值比组合",
    family: "价值",
    factors: ["bookToPrice"],
    descending: true,
    capabilities: ["cross-section", "point-in-time-financials", "market-cap"],
    rule: "按当时可见B/P降序，前K只等权。",
  },
  {
    id: "rank-cashflow",
    name: "现金流收益率组合",
    family: "价值",
    factors: ["cashflowYield"],
    descending: true,
    capabilities: ["cross-section", "point-in-time-financials", "market-cap"],
    rule: "按当时可见经营现金流/总市值降序，前K只等权。",
  },
  {
    id: "rank-quality",
    name: "ROE质量组合",
    family: "质量",
    factors: ["roe"],
    descending: true,
    capabilities: ["cross-section", "point-in-time-financials"],
    rule: "按当时可见ROE降序，前K只等权。",
  },
  {
    id: "rank-growth",
    name: "利润增长组合",
    family: "成长",
    factors: ["profitGrowth"],
    descending: true,
    capabilities: ["cross-section", "point-in-time-financials"],
    rule: "按当时可见同比利润增长率降序，前K只等权；基期异常由数据适配层留空。",
  },
  {
    id: "rank-small-cap",
    name: "小市值组合",
    family: "规模",
    factors: ["marketCap"],
    descending: false,
    capabilities: ["cross-section", "market-cap"],
    rule: "按决策日总市值升序，前K只等权；非正市值排除。",
  },
  {
    id: "rank-low-volatility",
    name: "低波动组合",
    family: "低风险",
    factors: ["volatility"],
    descending: false,
    capabilities: ["ohlcv", "cross-section"],
    rule: "按历史收益波动率升序，前K只等权。",
  },
  {
    id: "rank-low-beta",
    name: "低Beta组合",
    family: "低风险",
    factors: ["beta"],
    descending: false,
    capabilities: ["ohlcv", "cross-section"],
    rule: "按与固定基准的历史收益Beta升序，前K只等权。",
  },
  {
    id: "rank-quality-momentum",
    name: "质量动量组合",
    family: "多因子",
    factors: ["roe", "momentum"],
    descending: true,
    capabilities: ["ohlcv", "cross-section", "point-in-time-financials"],
    rule: "ROE与动量在有效共同样本内分别排序，平均百分位降序，前K只等权。",
  },
  {
    id: "allocation-equal",
    name: "等权配置",
    family: "配置",
    factors: [],
    descending: true,
    capabilities: ["cross-section"],
    rule: "所有有效候选等权；不按代码截取前K。",
  },
  {
    id: "allocation-inverse-volatility",
    name: "反波动配置",
    family: "配置",
    factors: ["volatility"],
    descending: true,
    capabilities: ["ohlcv", "cross-section"],
    rule: "各候选权重与正波动率倒数成比例，不冒称含协方差的风险平价。",
  },
  {
    id: "allocation-risk-parity",
    name: "协方差风险平价",
    family: "配置",
    factors: ["volatility"],
    descending: true,
    capabilities: ["ohlcv", "cross-section"],
    sources: [
      "https://arxiv.org/abs/1311.4057",
      "https://github.com/convexfi/riskparity.py",
    ],
    rule: "完全对齐60日简单收益样本协方差，加1e-6平均方差对角ridge，long-only等风险贡献；不足或零波动排除，未收敛报错，不降级反波动配置。",
  },
  ...portfolioClassicDefinitions,
  ...portfolioRpsDefinitions,
] as const;

const dailyDefinitions: Omit<StrategyDefinition, "category">[] =
  studyStrategies.map((id) => ({
    id,
    version: 1,
    ...studyCatalog[id],
    origin: "international",
    sources: (id.startsWith("research-")
      ? representativeSources[id.slice(9)]
      : undefined) ??
      classicDefinitions.find((d) => d.id === id)?.sources ?? [technicalSource],
    capabilities: accountIds.includes(id)
      ? ["ohlcv", "account-state"]
      : ["ohlcv"],
    output: accountIds.includes(id) ? "order" : "signal",
    implementation: "implemented",
    warmupBars: studyWarmup(id),
  }));

const definitions: readonly Omit<StrategyDefinition, "category">[] = [
  ...dailyDefinitions,
  {
    ...nativeStudyDefinition,
    origin: "domestic",
    capabilities: ["ohlcv", "structure"],
    output: "signal",
    implementation: "implemented",
  },
  ...portfolioDefinitions.map((d): Omit<StrategyDefinition, "category"> => ({
    id: d.id,
    version: 1,
    name: d.name,
    family: d.family,
    rule: d.rule,
    origin: "international",
    sources: "sources" in d ? d.sources : [factorSource],
    capabilities: [...d.capabilities],
    output: "weights",
    implementation: "implemented",
    warmupBars: 0,
    candidateFactors: d.factors.map((f) => strategyCandidateFactors[f]!),
  })),
  ...strategyRepresentatives
    .filter(
      (d) =>
        ![
          "breakout",
          "indicator-confluence",
          "volume-price",
          "wyckoff",
          "growth",
          "chan",
        ].includes(d.id),
    )
    .map((d): Omit<StrategyDefinition, "category"> => ({
      id: `research-${d.id}`,
      version: 1,
      name: d.name,
      family: d.family,
      rule: d.description,
      origin: d.family === "chan" ? "domestic" : "international",
      sources: representativeSources[d.id]!,
      capabilities: researchCapabilities[d.family]!,
      output: "research",
      implementation: "research-only",
      warmupBars: 0,
    })),
  ...(
    [
      [
        "pairs",
        "配对/协整与市场中性",
        "统计套利",
        ["cross-section", "short-borrow"],
      ],
      ["futures-carry", "期现套利与Carry", "套利", ["derivatives"]],
      ["options-volatility", "期权波动率策略", "波动率", ["derivatives"]],
      ["event-driven", "公告事件驱动", "事件", ["events"]],
      ["market-making", "高频做市", "高频", ["order-book"]],
      [
        "machine-learning",
        "机器学习选股",
        "机器学习",
        ["cross-section", "training"],
      ],
    ] as const
  ).map(
    ([id, name, family, capabilities]): Omit<
      StrategyDefinition,
      "category"
    > => ({
      id,
      name,
      family,
      version: 1,
      rule: "当前缺少经验证的输入和执行模型；仅登记研究方向，不开放运行。",
      origin: "international",
      sources: [technicalSource],
      capabilities,
      output: "research",
      implementation: "missing-data",
      warmupBars: 0,
    }),
  ),
];

export const unifiedStrategyCatalog: readonly StrategyDefinition[] =
  definitions.map((definition) => ({
    ...definition,
    category: strategyCategoryForFamily(definition.family),
  }));

export function getStrategyDefinition(id: string) {
  return unifiedStrategyCatalog.find((d) => d.id === id);
}
export function checkStrategyAvailability(
  id: string,
  capabilities: readonly StrategyDataCapability[],
): StrategyAvailability {
  const definition = getStrategyDefinition(id);
  if (!definition)
    return { available: false, missing: [], reason: "策略不存在" };
  const missing = definition.capabilities.filter(
    (c) => !capabilities.includes(c),
  );
  const available =
    definition.implementation === "implemented" && missing.length === 0;
  return {
    available,
    missing,
    reason: available
      ? null
      : definition.implementation !== "implemented"
        ? "仅研究登记，尚无统一可执行规则"
        : `缺少输入：${missing.join("、")}`,
  };
}

export function evaluateStrategy(
  instance: StrategyInstance,
  context: StrategyContext,
): StrategyOutput {
  const definition = getStrategyDefinition(instance.strategyId);
  if (!definition || definition.implementation !== "implemented")
    throw new Error("策略不存在或未实现");
  if (!validDate(context.asOf)) throw new Error("asOf必须为有效交易日期");
  const portfolio = portfolioDefinitions.find(
    (d) => d.id === instance.strategyId,
  );
  if (portfolio) return portfolioWeights(portfolio, instance, context);
  let previous = "";
  for (const bar of context.bars ?? []) {
    if (
      !validDate(bar.date) ||
      bar.date <= previous ||
      ![bar.open, bar.high, bar.low, bar.close].every(
        (v) => Number.isFinite(v) && v > 0,
      ) ||
      ![bar.volume, bar.amount].every((v) => Number.isFinite(v) && v >= 0) ||
      bar.low > Math.min(bar.open, bar.close) ||
      bar.high < Math.max(bar.open, bar.close) ||
      bar.high < bar.low
    )
      throw new Error("行情日期顺序或数值无效");
    previous = bar.date;
  }
  const bars = context.bars?.filter((b) => b.date <= context.asOf);
  if (!bars || bars.length <= definition.warmupBars)
    throw new Error(`需要至少${definition.warmupBars + 1}根已完成行情`);
  const index = context.index ?? bars.length - 1;
  if (
    !Number.isInteger(index) ||
    index < definition.warmupBars ||
    index >= bars.length
  )
    throw new Error("决策索引或预热无效");
  const prefix = bars.slice(0, index + 1);
  if (isNativeStudyStrategy(instance.strategyId)) {
    if (!context.native)
      throw new Error("原生缠论需要按固定前缀采集并验证的原生观察");
    const observations = context.native.observations.filter(
      (row) => row.date <= prefix.at(-1)!.date,
    );
    return {
      kind: "signal",
      ...createNativeStudyRule(
        prefix,
        context.native.firstIndex,
        observations,
      )(index, context.position ?? { entry: 0, entryIndex: index }),
    };
  }
  const rule = createExtendedStudyRule(
    instance.strategyId as StudyStrategy,
    prefix,
  );
  if (!rule) {
    if (!context.account) throw new Error("该策略需要account账户状态");
    const { initial, firstIndex, ...state } = context.account;
    const order = createStudyDecision(
      instance.strategyId as StudyStrategy,
      prefix,
      prefix,
      initial,
      firstIndex,
    )(index, state);
    return { kind: "order", order, allocationMonth: state.lastAllocationMonth };
  }
  const position = context.position ?? { entry: 0, entryIndex: index };
  return { kind: "signal", ...rule(index, position) };
}

function portfolioWeights(
  definition: (typeof portfolioDefinitions)[number],
  instance: StrategyInstance,
  context: StrategyContext,
): StrategyOutput {
  const topK = instance.parameters?.topK ?? 10;
  if (!Number.isInteger(topK) || topK < 1) throw new Error("topK必须为正整数");
  if (!context.candidates) throw new Error("缺少横截面候选输入");
  const symbols = new Set<string>();
  const excluded: string[] = [];
  const candidates = context.candidates.filter((candidate) => {
    if (!candidate.symbol || symbols.has(candidate.symbol))
      throw new Error("证券代码为空或重复");
    symbols.add(candidate.symbol);
    if (!validDate(candidate.availableAt)) throw new Error("候选可见日期无效");
    const valid =
      candidate.availableAt <= context.asOf &&
      definition.factors.every((factor) => {
        const value = candidate.values[factor];
        return (
          value !== null &&
          value !== undefined &&
          Number.isFinite(value) &&
          (strategyCandidateFactors[factor]?.exclusiveMinimum === undefined ||
            value > strategyCandidateFactors[factor]!.exclusiveMinimum!) &&
          (!("positiveFactors" in definition) ||
            !definition.positiveFactors.some(
              (required) => required === factor,
            ) ||
            value > 0) &&
          (!(factor === "marketCap" || factor === "volatility") || value > 0)
        );
      });
    if (!valid) excluded.push(candidate.symbol);
    return valid;
  });
  if (definition.id === "allocation-risk-parity") {
    const result = riskParityWeights(
      candidates.map((c) => ({ symbol: c.symbol, returns: c.returns ?? [] })),
      context.asOf,
    );
    return {
      kind: "weights",
      weights: result.weights,
      excluded: [...excluded, ...result.excluded],
    };
  }
  const ranks = new Map<string, number>();
  for (const factor of definition.factors) {
    const sorted = [...candidates].sort(
      (a, b) =>
        a.values[factor]! - b.values[factor]! ||
        a.symbol.localeCompare(b.symbol),
    );
    for (let i = 0; i < sorted.length;) {
      let end = i + 1;
      while (
        end < sorted.length &&
        sorted[end]!.values[factor] === sorted[i]!.values[factor]
      )
        end++;
      const rank = (i + end - 1) / 2 / Math.max(1, sorted.length - 1);
      for (let j = i; j < end; j++)
        ranks.set(
          sorted[j]!.symbol,
          (ranks.get(sorted[j]!.symbol) ?? 0) + rank,
        );
      i = end;
    }
  }
  const allocation = definition.id.startsWith("allocation-");
  const selected = [...candidates]
    .sort((a, b) => {
      const difference =
        (ranks.get(a.symbol) ?? 0) - (ranks.get(b.symbol) ?? 0);
      return (
        (definition.descending ? -difference : difference) ||
        a.symbol.localeCompare(b.symbol)
      );
    })
    .slice(0, allocation ? candidates.length : topK);
  const minimumVol = Math.min(...selected.map((c) => c.values.volatility ?? 1));
  const values = selected.map((c) =>
    definition.id === "allocation-inverse-volatility"
      ? minimumVol / c.values.volatility!
      : 1,
  );
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    kind: "weights",
    weights: selected.map((c, i) => ({
      symbol: c.symbol,
      weight: values[i]! / total,
    })),
    excluded,
  };
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}
