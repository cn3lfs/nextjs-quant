import type { ReviewValue } from "./trade-review";

/**
 * 通达信协议财务快照的结构最小集，字段来自 tstdx `finance`。
 *
 * 2026-09-15 与本地专业财务包 `gpcw*.dat` 逐字段交叉核对（sh600519 / sz000002 /
 * sz300750 / sz000001）后的可信度划分：
 * - 金额字段单位已在 tstdx 按千元换算成元，与财务包的元单位数值吻合到 float32 精度。
 * - `totalShares` / `floatShares` 为股；`bookValuePerShare` 为元/股；`shareholders` 为户。
 * - 股本结构子项（国家股、发起人股、法人股、B 股、H 股、职工股）语义已被复用或错位，
 *   在财务包里任何倍率下都没有对应值，tstdx 保留协议原值；这里只原样展示，不参与派生。
 * - `updatedDate` 是快照更新日，不是报告期；报告期由本地财务包反查，见
 *   `src/server/tdx-financial-reports.ts`。
 */
export type FinanceSnapshot = {
  totalShares: number;
  floatShares: number;
  stateShares: number;
  founderShares: number;
  legalPersonShares: number;
  bShares: number;
  hShares: number;
  employeeShares: number;
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
  totalCashFlow: number;
  shareholders: number;
  bookValuePerShare: number;
  province: number;
  industry: number;
  updatedDate: number;
  ipoDate: number;
};

/** 已核对单位的报表明细，单位为元。 */
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
    fields: [
      ["operatingCashFlow", "经营现金流"],
      ["totalCashFlow", "现金流合计"],
    ],
  },
] as const satisfies readonly {
  title: string;
  fields: readonly (readonly [keyof FinanceSnapshot, string])[];
}[];

/** 语义未确认的字段，只按协议原值列出，不换算、不派生。 */
export const unverifiedFields = [
  ["stateShares", "国家股"],
  ["legalPersonShares", "法人股"],
  ["founderShares", "发起人股"],
  ["bShares", "B 股"],
  ["hShares", "H 股"],
  ["employeeShares", "职工股"],
] as const satisfies readonly (readonly [keyof FinanceSnapshot, string])[];

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

export type FundamentalMetrics = {
  /** 由本地财务包反查确定，快照本身不含报告期。 */
  reportDate: string | null;
  snapshotDate: string | null;
  ipoDate: string | null;
  annualFactor: number | null;
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
 * 派生指标。价格来自实时五档快照、财务来自某个已确定的报告期，两者时点不同：
 * 任何一侧不可得就留空并给出原因，不用 0 或上期数填充。
 */
export function fundamentalMetrics(
  finance: FinanceSnapshot,
  price: number | null,
  reportDate: string | null,
): FundamentalMetrics {
  const last = price !== null ? positive(price) : null;
  const total = positive(finance.totalShares),
    floating = positive(finance.floatShares),
    perShare = positive(finance.bookValuePerShare),
    holders = positive(finance.shareholders),
    equity = positive(finance.netAssets),
    assets = positive(finance.totalAssets),
    revenue = positive(finance.mainRevenue);
  const factor = reportAnnualFactor(reportDate);
  const eps = over(finance.netProfit, total);
  const annualEps = eps !== null && factor !== null ? eps * factor : null;
  /*
   * 协议对银行股不给流动负债：sz000001 两项都是 0，sh601398 与 sh600036 只有长期负债，
   * 直接相加会得到 0.05% 这种明显错误的负债率。任何有资产的公司都有流动负债，
   * 所以流动负债缺失就是明细不全，整体留空。
   */
  const liabilities =
    positive(finance.currentLiabilities) === null
      ? null
      : positive(finance.currentLiabilities + finance.longTermLiabilities);
  const annualRevenue =
    revenue !== null && factor !== null ? revenue * factor : null;
  return {
    reportDate,
    snapshotDate: tdxDate(finance.updatedDate),
    ipoDate: tdxDate(finance.ipoDate),
    annualFactor: factor,
    marketCap: measure(
      last !== null && total !== null ? last * total : null,
      "实时价或总股本不可得",
    ),
    floatMarketCap: measure(
      last !== null && floating !== null ? last * floating : null,
      "实时价或流通股本不可得",
    ),
    floatRatio: measure(
      floating !== null ? over(floating, total) : null,
      "流通股本或总股本不可得",
    ),
    bookValuePerShare: measure(perShare, "每股净资产不可得"),
    priceToBook: measure(
      last !== null && perShare !== null ? last / perShare : null,
      "实时价或每股净资产不可得",
    ),
    sharesPerHolder: measure(
      floating !== null ? over(floating, holders) : null,
      "流通股本或股东户数不可得",
    ),
    reportedEps: measure(eps, "净利润或总股本不可得"),
    annualizedEps: measure(annualEps, "报告期未确定或每股收益不可得"),
    annualizedPe: measure(
      last !== null && annualEps !== null && annualEps > 0
        ? last / annualEps
        : null,
      "实时价不可得、报告期未确定或年化每股收益非正",
    ),
    priceToSales: measure(
      last !== null && total !== null && annualRevenue !== null
        ? (last * total) / annualRevenue
        : null,
      "实时价、总股本不可得或报告期未确定",
    ),
    reportedRoe: measure(
      over(finance.netProfit, equity),
      "净利润或净资产不可得",
    ),
    netMargin: measure(
      over(finance.netProfit, revenue),
      "净利润或主营收入不可得",
    ),
    debtRatio: measure(
      liabilities !== null ? over(liabilities, assets) : null,
      "协议未提供流动负债明细或总资产不可得",
    ),
    reservePerShare: measure(
      over(finance.capitalReserve, total),
      "资本公积或总股本不可得",
    ),
    undistributedPerShare: measure(
      over(finance.undistributedProfit, total),
      "未分配利润或总股本不可得",
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
