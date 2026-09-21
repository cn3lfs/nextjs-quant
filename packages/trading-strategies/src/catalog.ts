export type StrategyFamily =
  | "breakout"
  | "indicator-confluence"
  | "volume-price"
  | "wyckoff"
  | "chan"
  | "growth"
  | "value"
  | "sentiment"
  | "industry-chain";

export type StrategyReadiness =
  | "observed-complete-batch"
  | "observed-incomplete-batch"
  | "implemented-no-backtest";

export type DataCoverage = "available" | "partial" | "missing" | "unknown";

export type EvidencePartition = {
  events: number;
  signals: number;
  trades: number;
  closedRoundTrips: number;
  wins: number;
  losses: number;
  expectancy: number | null;
};

export type BacktestEvidence = {
  readiness: Exclude<StrategyReadiness, "implemented-no-backtest">;
  batch: "B3" | "B4" | "B5";
  archive: string;
  rawPath: string;
  resultHash: string;
  label: "样本不足" | "无交易" | "规则实现失败";
  evidenceLevel: "raw-record-summary" | "raw-only";
  recordId?: string;
  summaryPath?: string;
  partitions?: {
    development: EvidencePartition;
    validation: EvidencePartition;
  };
  totalEvents: number;
  totalOutcomes: number | null;
  totalClosedRoundTrips: number;
  chanBaselineUnverified?: boolean;
};

export type StrategyRepresentative = {
  id: string;
  name: string;
  family: StrategyFamily;
  representativeMethodId: string;
  representativePreset?: string;
  readiness: StrategyReadiness;
  dataCoverage: DataCoverage;
  description: string;
  evidence?: BacktestEvidence;
  notes: readonly string[];
};

const b3Evidence = (
  preset: string,
  method: string,
  hash: string,
  label: "样本不足" | "无交易" | "规则实现失败",
  development: EvidencePartition,
  validation: EvidencePartition,
  totalEvents: number,
  totalClosedRoundTrips: number,
): BacktestEvidence => ({
  readiness: "observed-complete-batch",
  batch: "B3",
  archive: ".codex-runs/r3-results/b3",
  rawPath: `.codex-runs/r3-results/b3/raw/${preset}.json`,
  resultHash: hash,
  label,
  evidenceLevel: "raw-record-summary",
  recordId: `r3-b3-${method}-${preset}`,
  summaryPath: ".codex-runs/r3-results/b3/summary.json",
  partitions: { development, validation },
  totalEvents,
  totalOutcomes: null,
  totalClosedRoundTrips,
});

export const strategyRepresentatives: readonly StrategyRepresentative[] = [
  {
    id: "breakout",
    name: "双突破直接确认",
    family: "breakout",
    representativeMethodId: "SW01",
    representativePreset: "sw-double-prior20",
    readiness: "observed-complete-batch",
    dataCoverage: "partial",
    description: "以双突破和前二十日均量确认作为代表的趋势/突破方向。",
    evidence: b3Evidence(
      "sw-double-prior20",
      "SW01",
      "8558793a020de838f2afcea7d44ba200036cb3c620c39f55de7d49f9e977dc18",
      "样本不足",
      {
        events: 4081,
        signals: 3955,
        trades: 2513,
        closedRoundTrips: 2511,
        wins: 1284,
        losses: 1227,
        expectancy: 0.00404689329499971,
      },
      {
        events: 2508,
        signals: 2495,
        trades: 1310,
        closedRoundTrips: 1305,
        wins: 629,
        losses: 676,
        expectancy: 0.0012028260139951888,
      },
      6589,
      3816,
    ),
    notes: [
      "这是固定持有期事件/组合统计，不是盈利证明。",
      "B3 结果标签为样本不足；保留该事实，不升级成策略有效结论。",
    ],
  },
  {
    id: "indicator-confluence",
    name: "多指标共振",
    family: "indicator-confluence",
    representativeMethodId: "SW11-confluence-count",
    representativePreset: "sw-confluence",
    readiness: "observed-complete-batch",
    dataCoverage: "partial",
    description: "以多项技术指标确认计数作为技术指标组合方向的唯一代表。",
    evidence: b3Evidence(
      "sw-confluence",
      "SW11-confluence-count",
      "fd36e1d733f9c03b9d3c269fa3a7d009c8c4e4ab84840442a36128f0280f963f",
      "样本不足",
      {
        events: 607,
        signals: 596,
        trades: 480,
        closedRoundTrips: 480,
        wins: 233,
        losses: 247,
        expectancy: 0.012011023510990548,
      },
      {
        events: 1210,
        signals: 1192,
        trades: 815,
        closedRoundTrips: 810,
        wins: 386,
        losses: 424,
        expectancy: 0.00732503934658403,
      },
      1817,
      1290,
    ),
    notes: [
      "不再把 MACD/KDJ/RSI/布林/均线的每个变体都作为独立包入口。",
      "预设 ID 在原方法表中可能复用；本包通过 sourceMethodIds 保留归属。",
    ],
  },
  {
    id: "volume-price",
    name: "价涨量增确认",
    family: "volume-price",
    representativeMethodId: "VP-vp-up-expanded-confirm",
    representativePreset: "vp-up-expanded-confirm",
    readiness: "observed-complete-batch",
    dataCoverage: "partial",
    description: "以价涨量增并放量确认作为量价方向的标志性代表。",
    evidence: b3Evidence(
      "vp-up-expanded-confirm",
      "VP-vp-up-expanded-confirm",
      "ce523ecd5368f2ec12673dcda6ed047349864b6a74904effe2be8fadbc6bce05",
      "样本不足",
      {
        events: 107,
        signals: 106,
        trades: 62,
        closedRoundTrips: 62,
        wins: 33,
        losses: 29,
        expectancy: 0.018573832721346738,
      },
      {
        events: 179,
        signals: 178,
        trades: 99,
        closedRoundTrips: 99,
        wins: 52,
        losses: 47,
        expectancy: 0.009311489010303,
      },
      286,
      161,
    ),
    notes: [
      "量能可比性和公司行动覆盖是数据门禁；有效池不足时不能解释为策略无效。",
      "其余价量组合保留在源方法表和历史审计中，不继续作为独立包策略。",
    ],
  },
  {
    id: "wyckoff",
    name: "SOS-JAC 突破",
    family: "wyckoff",
    representativeMethodId: "WY02",
    representativePreset: "wy-sos-daily",
    readiness: "observed-incomplete-batch",
    dataCoverage: "partial",
    description: "以 Wyckoff 的 SOS-JAC 日线突破作为结构交易方向代表。",
    evidence: {
      readiness: "observed-incomplete-batch",
      batch: "B4",
      archive: ".codex-runs/r3-results/b4-full-min11",
      rawPath: ".codex-runs/r3-results/b4-full-min11/raw/wy-sos-daily.json",
      resultHash:
        "c5d1210d2ac5623458ad831b5222172733f1eccb5800b8b2002d577f224eccc0",
      label: "无交易",
      evidenceLevel: "raw-only",
      totalEvents: 0,
      totalOutcomes: 0,
      totalClosedRoundTrips: 0,
    },
    notes: [
      "B4 全批只有 46/48 个目标归档；本条 raw 存在不等于 B4 全批完成。",
      "无事件来自当前覆盖和门禁条件下的观察，不能推出 Wyckoff 方向无效。",
    ],
  },
  {
    id: "chan",
    name: "三类买点",
    family: "chan",
    representativeMethodId: "CH03",
    representativePreset: "chan-third-native",
    readiness: "observed-incomplete-batch",
    dataCoverage: "partial",
    description: "以三类买点作为缠论结构方向的唯一工程代表。",
    evidence: {
      readiness: "observed-incomplete-batch",
      batch: "B4",
      archive: ".codex-runs/r3-results/b4-full-min11",
      rawPath: ".codex-runs/r3-results/b4-full-min11/raw/chan-third-native.json",
      resultHash:
        "387189441c5cb94272c7187541f9aeeddd34bfdb2aa2576b7d95e5de8285d267",
      label: "无交易",
      evidenceLevel: "raw-only",
      totalEvents: 387,
      totalOutcomes: 387,
      totalClosedRoundTrips: 0,
      chanBaselineUnverified: true,
    },
    notes: [
      "当前记录有 387 个结构观察，但交易统计为 0；这不是收益结论。",
      "依赖 czsc 的基线尚未独立验证，本包不把它标成正确性已证实。",
    ],
  },
  {
    id: "growth",
    name: "CANSLIM 98% 高点入口",
    family: "growth",
    representativeMethodId: "CA-B-N2",
    representativePreset: "canslim-high-98",
    readiness: "implemented-no-backtest",
    dataCoverage: "unknown",
    description: "以独立的 52 周高点 98% 入口作为成长股方向代表。",
    notes: [
      "已有工程入口和固定输入测试，但没有真实历史回测结果。",
      "完整 CANSLIM/SEPA 方法不在本代表条目中被假装完成。",
    ],
  },
  {
    id: "value",
    name: "六维价值评分",
    family: "value",
    representativeMethodId: "FA08",
    readiness: "implemented-no-backtest",
    dataCoverage: "missing",
    description: "以六维价值评分作为基本面/价值方向代表。",
    notes: [
      "当前属于工程版本/输入适配范围，S7 真实因子回测尚未开始。",
      "缺失字段不填零，也不把查询模板当成回测结果。",
    ],
  },
  {
    id: "sentiment",
    name: "三状态情绪切换",
    family: "sentiment",
    representativeMethodId: "MS04",
    readiness: "implemented-no-backtest",
    dataCoverage: "unknown",
    description: "以冻结三状态标签和仓位切换作为市场情绪方向代表。",
    notes: [
      "属于已登记的工程方法，S7 真实历史回测尚未开始。",
      "主观输入必须保留来源和时点，不能从收益倒推标签。",
    ],
  },
  {
    id: "industry-chain",
    name: "长中短逻辑组合",
    family: "industry-chain",
    representativeMethodId: "IC04",
    readiness: "implemented-no-backtest",
    dataCoverage: "missing",
    description: "以长中短逻辑同向和过期退出作为产业链方向代表。",
    notes: [
      "当前未完成真实历史回测，不能给出胜率、收益或优劣排序。",
      "事件/新闻/产业链的其他方法保留在全量方法登记中。",
    ],
  },
] as const satisfies readonly StrategyRepresentative[];

const familyIds = new Set(strategyRepresentatives.map((item) => item.family));

export function listStrategyRepresentatives() {
  return strategyRepresentatives;
}

export function findStrategyRepresentative(id: string) {
  return strategyRepresentatives.find((item) => item.id === id);
}

export function hasOneRepresentativePerFamily() {
  return familyIds.size === strategyRepresentatives.length;
}
