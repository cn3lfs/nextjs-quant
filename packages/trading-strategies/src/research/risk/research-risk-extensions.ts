import { z } from "zod";

const positive = z.number().finite().positive();
const common = {
  provenance: z.literal("manual-scenario"),
  underlying: z.string().trim().min(1),
  entry: positive,
};
const option = {
  ...common,
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shares: z.number().int().positive(),
  contracts: z.number().int().positive(),
  multiplier: z.number().int().positive(),
  putStrike: positive,
  putPremium: z.number().finite().nonnegative(),
  fees: z.number().finite().nonnegative(),
  terminalSpots: z.array(z.number().finite().nonnegative()).min(1).max(100),
};
export const riskExtensionSchema = z
  .discriminatedUnion("kind", [
    z.object({ ...option, kind: z.literal("protective-put") }).strict(),
    z
      .object({
        ...option,
        kind: z.literal("collar"),
        callStrike: positive,
        callPremium: z.number().finite().nonnegative(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal("short-script"),
        equity: positive,
        riskFraction: z.number().finite().gt(0).max(0.1),
        maxWeight: z.number().finite().gt(0).max(1),
        lot: z.number().int().positive(),
        swingHigh: positive,
        atr: positive,
        buffer: z.union([z.literal(0.3), z.literal(0.5)]),
        slippagePerShare: z.number().finite().nonnegative(),
      })
      .strict(),
  ])
  .superRefine((v, c) => {
    if (v.kind !== "short-script") {
      if (v.shares !== v.contracts * v.multiplier)
        c.addIssue({
          code: "custom",
          message: "扩展只接受完整覆盖股份，不做裸卖call或部分未对冲",
        });
      if (
        !Number.isFinite(Date.parse(v.expiry)) ||
        new Date(v.expiry).toISOString().slice(0, 10) !== v.expiry
      )
        c.addIssue({ code: "custom", message: "到期日无效" });
      if (v.kind === "collar" && v.callStrike <= v.putStrike)
        c.addIssue({
          code: "custom",
          message: "领口call行权价须高于put行权价",
        });
    } else if (v.swingHigh + v.buffer * v.atr <= v.entry)
      c.addIssue({ code: "custom", message: "做空保护线必须在入场价上方" });
  });
export type RiskExtension = z.infer<typeof riskExtensionSchema>;
export const riskExtensionMethods = {
  "protective-put": "RK-F-put",
  collar: "RK-F-collar",
  "short-script": "RK-F-short-script",
} as const;
export const riskExtensionBoundary =
  "只供超出当前交易品种的扩展固定情景计算，不生成A股订单、不合入交易净值/收益。保护性put及领口同标的同到期、股份全覆盖，计算到期内在价值和已给权利金/费用；领口仅当收付权利金相等才称权利金净零，费用仍非零，不保证真实零成本。缺历史可成交期权链、合约调整、行权/指派、结算与资金约束，不能真实回测。做空只保留原脚本前高加0.3/0.5ATR、上方保护及下方1/2/3R，风险/市值/整手先定股数再报滑点，借券、保证金、回补和利息未提供，沪深现金账户不可执行。输入均为人工假设，不是报价或胜率。";
export function riskExtensionTemplate(
  kind: RiskExtension["kind"],
): RiskExtension {
  const common = {
    provenance: "manual-scenario" as const,
    underlying: "合成情景标的",
    entry: 100,
  };
  if (kind === "short-script")
    return {
      ...common,
      kind,
      equity: 1000000,
      riskFraction: 0.01,
      maxWeight: 0.2,
      lot: 100,
      swingHigh: 104,
      atr: 2,
      buffer: 0.5,
      slippagePerShare: 0.1,
    };
  return {
    ...common,
    kind,
    expiry: "2026-12-31",
    shares: 100,
    contracts: 1,
    multiplier: 100,
    putStrike: 95,
    putPremium: 2,
    fees: 10,
    terminalSpots: [0, 80, 95, 100, 110, 130],
    ...(kind === "collar" ? { callStrike: 110, callPremium: 2 } : {}),
  } as RiskExtension;
}
export function evaluateRiskExtension(input: RiskExtension) {
  const v = riskExtensionSchema.parse(input);
  const metadata = {
    version: "risk-extension-1",
    method: riskExtensionMethods[v.kind],
    extensionOnly: true,
    includedInSimulation: false,
    boundary: riskExtensionBoundary,
    input: v,
  };
  if (v.kind === "short-script") {
    const stop = v.swingHigh + v.buffer * v.atr,
      distance = stop - v.entry;
    const quantity = Math.min(
      Math.floor((v.equity * v.riskFraction) / distance / v.lot) * v.lot,
      Math.floor((v.equity * v.maxWeight) / v.entry / v.lot) * v.lot,
    );
    return {
      ...metadata,
      short: {
        stop,
        quantity,
        distance,
        budget: v.equity * v.riskFraction,
        riskWithoutSlippage: quantity * distance,
        riskWithSlippage: quantity * (distance + v.slippagePerShare),
        targets: [1, 2, 3].map((r) => ({
          r,
          price: v.entry - r * distance,
          reachable: v.entry - r * distance >= 0,
        })),
        breakeven: v.entry,
        after2R: { reduceFraction: 0.5, stop: v.entry - distance },
        feesIncluded: false,
      },
      option: null,
    };
  }
  const netPremium = v.putPremium - (v.kind === "collar" ? v.callPremium : 0);
  const outcomes = v.terminalSpots.map((spot) => ({
    spot,
    stockProfit: (spot - v.entry) * v.shares,
    putPayoff: Math.max(0, v.putStrike - spot) * v.shares,
    callPayoff:
      v.kind === "collar" ? -Math.max(0, spot - v.callStrike) * v.shares : 0,
    profit:
      (spot -
        v.entry +
        Math.max(0, v.putStrike - spot) -
        (v.kind === "collar" ? Math.max(0, spot - v.callStrike) : 0) -
        netPremium) *
        v.shares -
      v.fees,
  }));
  return {
    ...metadata,
    short: null,
    option: {
      netPremiumPerShare: netPremium,
      zeroNetPremium: netPremium === 0,
      fees: v.fees,
      floorProfit: (v.putStrike - v.entry - netPremium) * v.shares - v.fees,
      ceilingProfit:
        v.kind === "collar"
          ? (v.callStrike - v.entry - netPremium) * v.shares - v.fees
          : null,
      outcomes,
    },
  };
}
