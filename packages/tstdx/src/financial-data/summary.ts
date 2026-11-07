/** Named source summary used for snapshot comparison and single-company reading.
 * Full field validity and timing use projectFinancialFields instead. */
export const financialSummaryFieldSlots = {
  totalAssets: 39,
  currentAssets: 20,
  fixedAssets: 26,
  intangibleAssets: 32,
  currentLiabilities: 53,
  nonCurrentLiabilities: 61,
  totalLiabilities: 62,
  parentEquity: 270,
  mainRevenue: 73,
  operatingCost: 74,
  operatingProfit: 85,
  totalProfit: 91,
  afterTaxProfit: 94,
  netProfit: 95,
  undistributedProfit: 67,
  operatingCashFlow: 106,
  // 少数标的协议侧与财务包不一致，以财务包为准：它是带报告期的官方专业财务数据
  inventory: 16, // 23/24（银行等无存货的标的不计入样本）
  receivables: 10, // 23/24
  capitalReserve: 64, // 29/30
  investmentIncome: 82, // 28/30
  shareholders: 241, // 26/30
  // 每股净资产仍使用源值，不能由期末股本推断加权或特殊权益调整口径。
  bookValuePerShare: 3,
  // 报告期末总股本；24/30，差异来自报告期之后的增发与回购，由协议快照叠加最新值
  totalShares: 237,
  reportedEps: 0,
} as const;
export type FinancialSummaryFields = Record<
  keyof typeof financialSummaryFieldSlots,
  number
>;
export function projectFinancialSummary(
  values: readonly number[],
): FinancialSummaryFields {
  return Object.fromEntries(
    Object.entries(financialSummaryFieldSlots).map(([name, slot]) => [
      name,
      values[slot] ?? Number.NaN,
    ]),
  ) as FinancialSummaryFields;
}
