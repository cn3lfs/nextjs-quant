import { z } from "zod";

const amount = z.number().finite().nonnegative();
const common = {
  currency: z.literal("CNY"),
  amountUnit: z.literal("yuan"),
  sharesUnit: z.literal("shares"),
  totalShares: z.number().finite().positive(),
  growthRate: z.number().finite().gt(-1),
  discountRate: z.number().finite().positive(),
  terminalGrowthRate: z.number().finite().gt(-1),
  assumptionNote: z.string().trim().min(1).max(4000),
};
const fcffSchema = z
  .object({
    ...common,
    method: z.literal("fcff-wacc"),
    cashFlowBasis: z.literal("fcff"),
    forecastYears: z.literal(5),
    baseFcff: z.number().finite().positive(),
    cashAndNonOperatingAssets: amount,
    debtValue: amount,
    minorityInterestValue: amount,
    otherClaimsValue: amount,
  })
  .strict();
const guoSchema = z
  .object({
    ...common,
    method: z.literal("guo-operating-equity"),
    cashFlowBasis: z.literal("operating-cash-flow-less-maintenance"),
    forecastYears: z.number().int().min(3).max(5),
    discountRate: z.number().finite().min(0.08).max(0.1),
    terminalGrowthRate: z.number().finite().gt(-1).max(0.04),
    operatingCashFlow: z.number().finite(),
    maintenanceCapex: amount,
    financialAssetsValue: amount,
    longTermInvestmentsValue: amount,
    interestBearingDebt: amount,
    minorityEquity: amount,
    totalEquity: z.number().finite().positive(),
  })
  .strict();
export const valuationInputSchema = z.discriminatedUnion("method", [
  fcffSchema,
  guoSchema,
]);
export type ValuationInput = z.infer<typeof valuationInputSchema>;

function finite(value: number) {
  if (!Number.isFinite(value)) throw new Error("估值计算超出有限数值范围");
  return value;
}

/** Arithmetic on explicit assumptions. This does not certify financial facts or a trade. */
export function calculateValuation(value: unknown) {
  const input = valuationInputSchema.parse(value);
  if (input.discountRate <= input.terminalGrowthRate)
    throw new Error("折现率必须严格高于永续增长率，不能替换分母继续估值");
  const baseCashFlow =
    input.method === "fcff-wacc"
      ? input.baseFcff
      : finite(input.operatingCashFlow - input.maintenanceCapex);
  if (baseCashFlow <= 0)
    throw new Error("本模型需要正的基期自由现金流；不能将非正值强行归零");
  if (
    input.method === "guo-operating-equity" &&
    input.minorityEquity > input.totalEquity
  )
    throw new Error("少数股东权益不能超过股东权益合计");
  const schedule = Array.from({ length: input.forecastYears }, (_, index) => {
    const year = index + 1;
    const cashFlow = finite(baseCashFlow * (1 + input.growthRate) ** year);
    const discountFactor = finite((1 + input.discountRate) ** year);
    return {
      year,
      cashFlow,
      discountFactor,
      presentValue: finite(cashFlow / discountFactor),
    };
  });
  const terminalCashFlow = finite(
    schedule.at(-1)!.cashFlow * (1 + input.terminalGrowthRate),
  );
  const terminalValue = finite(
    terminalCashFlow / (input.discountRate - input.terminalGrowthRate),
  );
  const terminalPresentValue = finite(
    terminalValue / schedule.at(-1)!.discountFactor,
  );
  const explicitPresentValue = finite(
    schedule.reduce((sum, row) => sum + row.presentValue, 0),
  );
  const operatingPresentValue = finite(
    explicitPresentValue + terminalPresentValue,
  );
  const bridge =
    input.method === "fcff-wacc"
      ? {
          cashAndNonOperatingAssets: input.cashAndNonOperatingAssets,
          debtValue: input.debtValue,
          minorityInterestValue: input.minorityInterestValue,
          otherClaimsValue: input.otherClaimsValue,
          parentEquityValue: finite(
            operatingPresentValue +
              input.cashAndNonOperatingAssets -
              input.debtValue -
              input.minorityInterestValue -
              input.otherClaimsValue,
          ),
        }
      : (() => {
          const companyValue = finite(
            operatingPresentValue +
              input.financialAssetsValue +
              input.longTermInvestmentsValue,
          );
          const equityValue = finite(companyValue - input.interestBearingDebt);
          const parentShare = 1 - input.minorityEquity / input.totalEquity;
          return {
            financialAssetsValue: input.financialAssetsValue,
            longTermInvestmentsValue: input.longTermInvestmentsValue,
            interestBearingDebt: input.interestBearingDebt,
            companyValue,
            equityValue,
            parentShare,
            parentEquityValue: finite(equityValue * parentShare),
          };
        })();
  return {
    version: "valuation-arithmetic-1",
    mode: "assumption-scenario",
    automaticSignals: false,
    input,
    baseCashFlow,
    schedule,
    terminalCashFlow,
    terminalValue,
    terminalPresentValue,
    explicitPresentValue,
    operatingPresentValue,
    bridge,
    perShareValue: finite(bridge.parentEquityValue / input.totalShares),
    terminalSharePercent:
      operatingPresentValue > 0
        ? finite((terminalPresentValue / operatingPresentValue) * 100)
        : null,
    warnings: [
      "金额统一为人民币元，股数为股，利率使用小数；本结果只核验算术，不证明输入财务资料及假设可靠",
      "未将方法中的默认利率、增长率或示例资金当作事实；情景之间分别计算，不自动合成买卖信号",
      "负的归母价值保留为模型缺口，不裁剪为零；不等于可交易的负股价或清算价值",
      ...(input.method === "fcff-wacc"
        ? [
            "基期必须为已统一口径的FCFF，按WACC折现；不能直接把报表经营现金流减资本支出当作已验证FCFF",
            "企业经营价值与归母每股价值分开；债务、非经营资产及其他索取权需防止重复计入",
          ]
        : [
            "郭永清法独立使用经营现金流减保全性支出及股权资本成本，不与WACC或综合评分混用",
            "本计算不替代排雷、现金流五状态和资产资本表核验；少数股东简化比例及特殊行业适用性需另行确认",
          ]),
    ],
  };
}
