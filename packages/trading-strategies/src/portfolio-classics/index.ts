const reference =
  "https://github.com/OpenSourceAP/CrossSection/blob/9f053398c4995651d822e90d81526d0644c6f3e5/Signals/pyCode/Predictors/";
const profitabilityPaper =
  "https://mysimon.rochester.edu/novy-marx/research/OSoV.pdf";
/** Values are ratios from the existing strict point-in-time financial feature provider, never percentages. */
export const portfolioClassicFactorMetadata = {
  grossProfitability: {
    id: "grossProfitability",
    period: null,
    skip: 0,
    unit: "ratio",
    sourceFeature: "gross-profit-assets",
    financialFields: [74, 75, 40],
    reportBasis: "latest-visible-annual",
  },
  cashAccrualQuality: {
    id: "cashAccrualQuality",
    period: null,
    skip: 0,
    unit: "ratio",
    sourceFeature: "cash-quality",
    financialFields: [95, 107, 40],
    reportBasis: "visible-ttm-over-current-assets",
  },
  assetGrowth: {
    id: "assetGrowth",
    period: null,
    skip: 0,
    unit: "ratio",
    sourceFeature: "asset-growth",
    exclusiveMinimum: -1,
    financialFields: [40],
    reportBasis: "same-report-period-prior-year",
  },
} as const;
/** Declarative recipes use the unified portfolio ranking/execution path, not another portfolio engine. */
export const portfolioClassicDefinitions = [
  {
    id: "portfolio-gross-profitability",
    name: "毛利资产盈利能力组合",
    family: "质量",
    factors: ["grossProfitability"],
    descending: true,
    positiveFactors: [],
    capabilities: ["cross-section", "point-in-time-financials"],
    sources: [reference + "GP.py", profitabilityPaper],
    rule: "最新已可见非金融企业年报：(营业收入-营业成本)/同年期末资产；按毛利资产盈利能力降序，前K只等权（默认10）。资产分母必须正；真实负毛利保留。沪深只做多、公告后可见及周度组合回放为本地改编，不复刻原美国多空组合。",
  },
  {
    id: "portfolio-cash-accruals",
    name: "现金法低应计质量组合",
    family: "质量",
    factors: ["cashAccrualQuality"],
    descending: true,
    positiveFactors: [],
    capabilities: ["cross-section", "point-in-time-financials"],
    sources: [
      reference + "Accruals.py",
      "https://iangow.github.io/far_book/accruals.html",
    ],
    rule: "严格可见非金融财报的(经营现金流TTM-合并净利润TTM)/最近期末正资产；数值高代表现金法应计较低，前K只等权（默认10）。负值保留，不把缺现金流当0。明确为项目既有现金法/期末资产变体，不声称等同Sloan资产负债表法或平均资产分母。",
  },
  {
    id: "portfolio-conservative-investment",
    name: "保守资产增长组合",
    family: "多因子",
    factors: ["assetGrowth"],
    descending: false,
    positiveFactors: [],
    capabilities: ["cross-section", "point-in-time-financials"],
    sources: [
      reference + "AssetGrowth.py",
      "https://news.darden.virginia.edu/articles/buy-low-growth-firms",
    ],
    rule: "按最近已可见报告期资产/上一年同报告期正资产-1升序，前K只等权（默认10）；资产收缩为有效负值，两期正资产和同报告期证据缺一留空。采用既有季度/年报同比字段，不冒称原美国年度分组和六月固定滞后。",
  },
  {
    id: "portfolio-profitability-value",
    name: "毛利盈利能力与价值组合",
    family: "多因子",
    factors: ["grossProfitability", "bookToPrice"],
    descending: true,
    positiveFactors: ["bookToPrice"],
    capabilities: ["cross-section", "point-in-time-financials", "market-cap"],
    sources: [reference + "GP.py", profitabilityPaper],
    rule: "在毛利资产盈利能力和同日账面市值比B/P均已知的非金融共同样本内，分别作并列平均百分位，等权合成后降序，前K只等权（默认10）。B/P须正，负毛利保留；合成、周调仓和只做多为公开盈利能力结合价值思想的透明本地基线。",
  },
] as const;
export const portfolioClassicIds = portfolioClassicDefinitions.map((d) => d.id);
export type PortfolioClassicId =
  (typeof portfolioClassicDefinitions)[number]["id"];
