import type { ReviewValue } from "./trade-review";

/**
 * 基本面的主源是本地专业财务包 `gpcw*.dat` 的报告期数据，字段下标在
 * `src/server/tdx-financial-reports.ts` 锁定。金额单位为元。
 *
 * `totalShares` 是**报告期末**总股本，用于每股类指标；市值类指标要用协议快照叠加的
 * 最新股本，两者在有增发或回购时不同。
 */
export type ReportFields = {
  totalAssets: number;
  currentAssets: number;
  fixedAssets: number;
  intangibleAssets: number;
  inventory: number;
  receivables: number;
  currentLiabilities: number;
  longTermLiabilities: number;
  capitalReserve: number;
  netAssets: number;
  mainRevenue: number;
  mainProfit: number;
  operatingProfit: number;
  investmentIncome: number;
  totalProfit: number;
  afterTaxProfit: number;
  netProfit: number;
  undistributedProfit: number;
  operatingCashFlow: number;
  shareholders: number;
  totalShares: number;
  /** 归母每股净资产。与 `netAssets`（股东权益合计）不同口径，不能互相推导。 */
  bookValuePerShare: number;
};

/**
 * 协议 7709 财务快照里仍然有用的部分：最新股本（本地只有报告期末口径）、
 * 上市日期与快照更新日。其余字段本地都有且更权威，不再从这里取。
 *
 * 股本结构子项语义已被复用或错位（sh600519 的法人股大于总股本、sz000002 的
 * 发起人股为负、职工股槽位实际等于每股收益），tstdx 保留协议原值，这里只原样展示。
 */
export type SnapshotOverlay = {
  totalShares: number;
  floatShares: number;
  stateShares: number;
  founderShares: number;
  legalPersonShares: number;
  bShares: number;
  hShares: number;
  employeeShares: number;
  updatedDate: number;
  ipoDate: number;
  province: number;
  industry: number;
};

/** 报表明细，单位为元，全部来自本地财务包。 */
export const statementGroups = [
  {
    title: "资产负债",
    fields: [
      ["totalAssets", "总资产"],
      ["currentAssets", "流动资产"],
      ["fixedAssets", "固定资产"],
      ["intangibleAssets", "无形资产"],
      ["inventory", "存货"],
      ["receivables", "应收账款"],
      ["currentLiabilities", "流动负债"],
      ["longTermLiabilities", "长期负债"],
      ["capitalReserve", "资本公积"],
      ["netAssets", "净资产"],
    ],
  },
  {
    title: "利润",
    fields: [
      ["mainRevenue", "主营收入"],
      ["mainProfit", "主营利润"],
      ["operatingProfit", "营业利润"],
      ["investmentIncome", "投资收益"],
      ["totalProfit", "利润总额"],
      ["afterTaxProfit", "税后利润"],
      ["netProfit", "净利润"],
      ["undistributedProfit", "未分配利润"],
    ],
  },
  {
    title: "现金流",
    fields: [["operatingCashFlow", "经营现金流"]],
  },
] as const satisfies readonly {
  title: string;
  fields: readonly (readonly [keyof ReportFields, string])[];
}[];

/** 语义未确认的协议槽位，只按原值列出，不换算、不派生。 */
export const unverifiedFields = [
  ["stateShares", "国家股"],
  ["legalPersonShares", "法人股"],
  ["founderShares", "发起人股"],
  ["bShares", "B 股"],
  ["hShares", "H 股"],
  ["employeeShares", "职工股"],
] as const satisfies readonly (readonly [keyof SnapshotOverlay, string])[];

const pad = (n: number) => String(n).padStart(2, "0");

/** 通达信的 YYYYMMDD 整数日期；不合法或缺失返回 null，不猜测日期。 */
export function tdxDate(value: number): string | null {
  if (!Number.isInteger(value)) return null;
  const year = Math.floor(value / 10000),
    month = Math.floor(value / 100) % 100,
    day = value % 100;
  if (year < 1990 || year > 2100) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  )
    return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

const annualFactors: Record<string, number> = {
  "03-31": 4,
  "06-30": 2,
  "09-30": 4 / 3,
  "12-31": 1,
};

/**
 * 报告期简单年化倍数。只认四个标准季末，其余日期返回 null。
 * 这是「报告期累计 × 倍数」，不是 TTM：调用方必须原样披露口径。
 */
export function reportAnnualFactor(reportDate: string | null): number | null {
  return reportDate === null
    ? null
    : (annualFactors[reportDate.slice(5)] ?? null);
}

const measure = (n: number | null, reason: string): ReviewValue =>
  n !== null && Number.isFinite(n)
    ? { value: n, reason: null }
    : { value: null, reason };
const positive = (n: number) => (Number.isFinite(n) && n > 0 ? n : null);
const over = (numerator: number, denominator: number | null) =>
  denominator !== null && Number.isFinite(numerator)
    ? numerator / denominator
    : null;

export const shareBases = ["latest", "report"] as const;
export type ShareBasis = (typeof shareBases)[number];

export type FundamentalMetrics = {
  reportDate: string;
  annualFactor: number | null;
  /** 市值类指标用的股本口径：最新快照股本，还是报告期末股本。 */
  sharesBasis: ShareBasis | null;
  marketCap: ReviewValue;
  floatMarketCap: ReviewValue;
  floatRatio: ReviewValue;
  bookValuePerShare: ReviewValue;
  priceToBook: ReviewValue;
  sharesPerHolder: ReviewValue;
  reportedEps: ReviewValue;
  annualizedEps: ReviewValue;
  annualizedPe: ReviewValue;
  priceToSales: ReviewValue;
  reportedRoe: ReviewValue;
  netMargin: ReviewValue;
  debtRatio: ReviewValue;
  reservePerShare: ReviewValue;
  undistributedPerShare: ReviewValue;
};

/**
 * 派生指标。报表来自本地某个确定的报告期，价格来自实时五档，股本优先用协议快照的
 * 最新值——三者时点不同，任何一侧不可得就留空并给出原因，不用 0 或上期数填充。
 *
 * 每股类指标一律用报告期末股本：报告期的利润要配报告期的股本，换成最新股本会算错。
 */
export function fundamentalMetrics(input: {
  report: ReportFields;
  reportDate: string;
  /** 协议快照的最新股本；尚未到达时为 null，市值类指标退回报告期末口径。 */
  latestShares: { totalShares: number; floatShares: number } | null;
  price: number | null;
}): FundamentalMetrics {
  const { report, reportDate } = input;
  const last = input.price !== null ? positive(input.price) : null;
  const reportShares = positive(report.totalShares);
  const latestTotal = input.latestShares
    ? positive(input.latestShares.totalShares)
    : null;
  const latestFloat = input.latestShares
    ? positive(input.latestShares.floatShares)
    : null;
  // 市值口径：拿得到最新股本就用它，否则退回报告期末股本并如实标注。
  const capShares = latestTotal ?? reportShares;
  const sharesBasis: ShareBasis | null =
    capShares === null ? null : latestTotal !== null ? "latest" : "report";
  const equity = positive(report.netAssets),
    assets = positive(report.totalAssets),
    revenue = positive(report.mainRevenue),
    holders = positive(report.shareholders);
  const factor = reportAnnualFactor(reportDate);
  const eps = over(report.netProfit, reportShares);
  const annualEps = eps !== null && factor !== null ? eps * factor : null;
  /*
   * 每股净资产直接取财务包的归母口径，不用 netAssets ÷ 总股本自算：
   * netAssets 是股东权益合计，含少数股东权益与永续债，自算会让银行与券商的
   * 每股净资产偏高、市净率偏低（sz000001 会从 24.13 变成 28.25）。
   */
  const perShare = positive(report.bookValuePerShare);
  /*
   * 协议对银行股不给流动负债：sz000001 两项都是 0，sh601398 与 sh600036 只有长期负债，
   * 直接相加会得到 0.05% 这种明显错误的负债率。任何有资产的公司都有流动负债，
   * 所以流动负债缺失就是明细不全，整体留空。
   */
  const liabilities =
    positive(report.currentLiabilities) === null
      ? null
      : positive(report.currentLiabilities + report.longTermLiabilities);
  const annualRevenue =
    revenue !== null && factor !== null ? revenue * factor : null;
  return {
    reportDate,
    annualFactor: factor,
    sharesBasis,
    marketCap: measure(
      last !== null && capShares !== null ? last * capShares : null,
      "实时价或总股本不可得",
    ),
    floatMarketCap: measure(
      last !== null && latestFloat !== null ? last * latestFloat : null,
      "实时价不可得，或流通股本要等实时快照",
    ),
    floatRatio: measure(
      latestFloat !== null && latestTotal !== null
        ? latestFloat / latestTotal
        : null,
      "流通占比要等实时快照",
    ),
    bookValuePerShare: measure(perShare, "每股净资产不可得"),
    priceToBook: measure(
      last !== null && perShare !== null ? last / perShare : null,
      "实时价或每股净资产不可得",
    ),
    sharesPerHolder: measure(
      over(report.totalShares, holders),
      "总股本或股东户数不可得",
    ),
    reportedEps: measure(eps, "净利润或报告期末总股本不可得"),
    annualizedEps: measure(annualEps, "报告期不是标准季末或每股收益不可得"),
    annualizedPe: measure(
      last !== null && annualEps !== null && annualEps > 0
        ? last / annualEps
        : null,
      "实时价不可得、报告期不是标准季末或年化每股收益非正",
    ),
    priceToSales: measure(
      last !== null && capShares !== null && annualRevenue !== null
        ? (last * capShares) / annualRevenue
        : null,
      "实时价、总股本不可得或报告期不是标准季末",
    ),
    reportedRoe: measure(
      over(report.netProfit, equity),
      "净利润或净资产不可得",
    ),
    netMargin: measure(
      over(report.netProfit, revenue),
      "净利润或主营收入不可得",
    ),
    debtRatio: measure(
      liabilities !== null ? over(liabilities, assets) : null,
      "财务包未提供流动负债明细或总资产不可得",
    ),
    reservePerShare: measure(
      over(report.capitalReserve, reportShares),
      "资本公积或报告期末总股本不可得",
    ),
    undistributedPerShare: measure(
      over(report.undistributedProfit, reportShares),
      "未分配利润或报告期末总股本不可得",
    ),
  };
}

/**
 * 中文数量级展示。返回 null 表示该值无法展示，调用方显示缺失原因而不是 0。
 * 只改变展示写法，不改变单位语义。
 */
export function compactNumber(value: number | null, digits = 2): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const magnitude = Math.abs(value);
  if (magnitude >= 1e8) return `${(value / 1e8).toFixed(digits)} 亿`;
  if (magnitude >= 1e4) return `${(value / 1e4).toFixed(digits)} 万`;
  return value.toFixed(magnitude >= 1 || value === 0 ? digits : 4);
}
