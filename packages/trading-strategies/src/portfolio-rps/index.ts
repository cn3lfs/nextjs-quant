/** The seven maintained RPS periods. Root integration tests verify parity with quant-rps. */
export const portfolioRpsPeriods = [1, 3, 5, 10, 20, 50, 120] as const;
export type PortfolioRpsPeriod = (typeof portfolioRpsPeriods)[number];
export type PortfolioRpsFactorId = `rpsReturn${PortfolioRpsPeriod}`;
export const portfolioRpsFactorMetadata = Object.fromEntries(
  portfolioRpsPeriods.map((period) => {
    const id = `rpsReturn${period}` as PortfolioRpsFactorId;
    return [id, { id, period, skip: 0, unit: "ratio" as const }];
  }),
) as Record<
  PortfolioRpsFactorId,
  {
    id: PortfolioRpsFactorId;
    period: PortfolioRpsPeriod;
    skip: 0;
    unit: "ratio";
  }
>;
/** These are seven period presets of one relative-strength family, not seven independent alphas. */
export const portfolioRpsDefinitions = portfolioRpsPeriods.map((period) => ({
  id: `portfolio-rps-${period}`,
  name: `本地候选池RPS${period}组合`,
  family: "动量",
  factors: [`rpsReturn${period}` as PortfolioRpsFactorId],
  descending: true,
  capabilities: ["ohlcv", "cross-section"] as const,
  sources: [] as readonly string[],
  rule: `以明确候选集合内已结束的${period}个交易日简单收益C[t]/C[t-${period}]-1降序、并列平均排名，前K只等权（默认10）；收益排名与同池RPS排名同序。收益端点必须有成交量，不前填。复用现有ROC取数及统一排名，不复制quant-rps算法；仅本地未复权候选池基线，不等同主RPS的后复权、上市年限、ST与停牌资格过滤，不代表全市场RPS。此入口是RPS家族周期预设。`,
}));
export type PortfolioRpsId = `portfolio-rps-${PortfolioRpsPeriod}`;
