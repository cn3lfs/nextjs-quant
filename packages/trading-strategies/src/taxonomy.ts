/** Stable maintenance domains; original method IDs and evidence remain independent. */
export const strategyCategories = [
  { id: "trend", name: "趋势跟随", description: "方向与趋势持续" },
  {
    id: "breakout",
    name: "突破与回调",
    description: "区间突破、趋势回踩及技术共振",
  },
  { id: "momentum", name: "动量与相对强弱", description: "时序和横截面强弱" },
  {
    id: "reversion",
    name: "反转与均值回归",
    description: "价格、振荡指标的短期回归",
  },
  {
    id: "volume",
    name: "量价与流动性",
    description: "成交量额、量价结构及流动性",
  },
  {
    id: "structure",
    name: "结构与形态",
    description: "缠论、威科夫及确认结构",
  },
  {
    id: "growth",
    name: "成长与成长形态",
    description: "CANSLIM、SEPA与盈利成长",
  },
  {
    id: "value-quality",
    name: "价值与质量",
    description: "估值、财务质量与现金流",
  },
  {
    id: "factor",
    name: "规模、低风险与多因子",
    description: "横截面风格及联合排序",
  },
  {
    id: "rotation",
    name: "轮动与市场环境",
    description: "行业、产业链、情绪及市场状态",
  },
  {
    id: "allocation",
    name: "配置与资金管理",
    description: "仓位、风控、配置及持有对照",
  },
  { id: "event", name: "日历与事件", description: "季节性、披露及事件时点" },
  {
    id: "relative-value",
    name: "统计套利与相对价值",
    description: "多腿价差、配对及对冲",
  },
  {
    id: "derivatives",
    name: "衍生品与Carry",
    description: "期现、期权与合约收益结构",
  },
  {
    id: "models-execution",
    name: "模型、微观结构与执行",
    description: "训练模型、盘口与执行算法",
  },
] as const;
export type StrategyCategory = (typeof strategyCategories)[number]["id"];

const families: Readonly<Record<string, StrategyCategory>> = {
  趋势: "trend",
  突破: "breakout",
  回调: "breakout",
  breakout: "breakout",
  "indicator-confluence": "breakout",
  动量: "momentum",
  反转: "reversion",
  量价: "volume",
  "volume-price": "volume",
  chan: "structure",
  wyckoff: "structure",
  growth: "growth",
  成长: "growth",
  value: "value-quality",
  价值: "value-quality",
  质量: "value-quality",
  规模: "factor",
  低风险: "factor",
  多因子: "factor",
  sentiment: "rotation",
  "industry-chain": "rotation",
  仓位: "allocation",
  配置: "allocation",
  基准: "allocation",
  日历: "event",
  事件: "event",
  统计套利: "relative-value",
  套利: "derivatives",
  波动率: "derivatives",
  高频: "models-execution",
  机器学习: "models-execution",
};
export function strategyCategoryForFamily(family: string): StrategyCategory {
  const category = families[family];
  if (!category) throw new Error(`策略家族尚未分类：${family}`);
  return category;
}

export type StrategyMethodKind =
  "rule" | "risk-policy" | "analysis" | "data-tool";
const sourceDomains: Readonly<
  Record<string, readonly [StrategyCategory, StrategyMethodKind]>
> = {
  "swing-trader": ["breakout", "rule"],
  "stop-loss": ["allocation", "risk-policy"],
  "canslim-analyst": ["growth", "rule"],
  "sepa-strategy-analyst": ["growth", "rule"],
  "volume-price-analysis": ["volume", "rule"],
  "wyckoff-trader": ["structure", "rule"],
  "chan-theory": ["structure", "rule"],
  "opening-price-playbook": ["breakout", "risk-policy"],
  "astock-market-rules": ["allocation", "risk-policy"],
  "industry-chain-analyst": ["rotation", "analysis"],
  "market-sentiment-analyst": ["rotation", "analysis"],
  "tmt-crowding": ["rotation", "analysis"],
  "news-industry-analyst": ["rotation", "analysis"],
  "message-analyst": ["event", "analysis"],
  "gf-windmill": ["rotation", "analysis"],
  "value-investing": ["value-quality", "analysis"],
  "fundamental-analyst": ["value-quality", "analysis"],
  "guo-yongqing-valuation": ["value-quality", "analysis"],
  "tdx-doc": ["models-execution", "data-tool"],
  "westock-data": ["models-execution", "data-tool"],
};
/** Classify the recorded method source, without promoting research/tools to trading strategies. */
export function strategyMethodClassification(sources: readonly string[]) {
  const source = sources[0]?.split("/")[0];
  const domain =
    source &&
    (sourceDomains[source] ??
      (source.startsWith("hithink-")
        ? (["models-execution", "data-tool"] as const)
        : undefined));
  if (!domain) throw new Error(`方法来源尚未分类：${source ?? "缺失"}`);
  return { category: domain[0], kind: domain[1] };
}
