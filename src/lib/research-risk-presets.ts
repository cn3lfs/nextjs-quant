import type { ResearchManagement } from "./research-management";
import type { BacktestCosts } from "./backtest-costs";
import { plannedStopRisk } from "./research-risk";

type Profile = {
  method: string;
  label: string;
  fraction?: number;
  weight?: number;
  initial?: boolean;
  atr?: number;
  be?: number;
  structureBe?: boolean;
  days?: number;
  liquidity?: boolean;
  totalRisk?: number;
};
export const riskProfiles = {
  "rk-risk025": {
    method: "RK-C-risk-tiers",
    label: "风险0.25%",
    fraction: 0.0025,
  },
  "rk-risk05": {
    method: "RK-C-risk-tiers",
    label: "风险0.5%",
    fraction: 0.005,
  },
  "rk-risk1": { method: "RK-C-risk-tiers", label: "风险1%", fraction: 0.01 },
  "rk-risk15": {
    method: "RK-C-risk-tiers",
    label: "风险1.5%",
    fraction: 0.015,
  },
  "rk-risk2": { method: "RK-C-risk-tiers", label: "风险2%", fraction: 0.02 },
  "rk-hard2": { method: "RK-C-hard2", label: "风险2%硬上限", fraction: 0.02 },
  "rk-equity-current": {
    method: "RK-C-current-equity",
    label: "按当前权益1%预算",
  },
  "rk-equity-initial": {
    method: "RK-C-current-equity",
    label: "按初始权益1%预算",
    initial: true,
  },
  "rk-weight15": {
    method: "RK-C-weight15-20",
    label: "单股15%上限",
    weight: 0.15,
    liquidity: true,
  },
  "rk-weight20": {
    method: "RK-C-weight15-20",
    label: "单股20%上限",
    weight: 0.2,
    liquidity: true,
  },
  "rk-capacity15": {
    method: "RK-C-sizing-three",
    label: "1%风险/15%市值/1%成交额容量",
    weight: 0.15,
    liquidity: true,
  },
  "rk-capacity20": {
    method: "RK-C-sizing-three",
    label: "1%风险/20%市值/1%成交额容量",
    weight: 0.2,
    liquidity: true,
  },
  "rk-total4": {
    method: "RK-C-total-risk4-6",
    label: "组合在险4%上限",
    totalRisk: 0.04,
  },
  "rk-total6": {
    method: "RK-C-total-risk4-6",
    label: "组合在险6%上限",
    totalRisk: 0.06,
  },
  "rk-be-none": { method: "RK-D2-compare", label: "不保本对照" },
  "rk-be03": { method: "RK-D2-compare", label: "0.3R保本反例", be: 0.3 },
  "rk-be05": { method: "RK-D2-compare", label: "0.5R保本对照", be: 0.5 },
  "rk-be1": { method: "RK-D2-compare", label: "1R保本对照", be: 1 },
  "rk-be1-structure": {
    method: "RK-D2-compare",
    label: "1R且更高低点确认保本",
    be: 1,
    structureBe: true,
  },
  "rk-time10": {
    method: "RK-D5-time10",
    label: "10交易日不足0.5R退出",
    days: 10,
  },
  "rk-atr10": { method: "RK-A-atr10-20", label: "ATR10初始2倍止损", atr: 10 },
  "rk-atr20": { method: "RK-A-atr10-20", label: "ATR20初始2倍止损", atr: 20 },
} as const satisfies Record<string, Profile>;
export type RiskPresetId = keyof typeof riskProfiles;
export const riskPresetIds = Object.keys(riskProfiles) as [
  RiskPresetId,
  ...RiskPresetId[],
];
export const riskPresetBoundary =
  "B2规模/演化工程v1：均为固定双突破入场、60交易日上限的独立对照，默认初始5%止损、当前权益1%含费风险和20%单股上限。五档风险不代表已知胜率；硬2%版禁止更高输入。初始权益版仅冻结风险金额基数，市值和可用现金仍以开盘已知现金加其余持仓前收估值约束。组合在险为逐持仓max(0,原始入场价至当前有效止损的含费规划损失)之和，盈利保护不能抵消其他持仓风险；预算不足或持仓估值/止损缺失不新入。15%/20%市值与前20日均成交额1%容量统一换算为股数向下取整，实际跳空可超预算。保本0.3/0.5/1R只用当时收盘浮盈、下一交易日起生效；结构版另需因果确认更高低点。10日无进展工程冻结为未达到0.5R，价格止损并存。ATR10/20共享算术ATR、均为2倍，仅改变初始定位及其风险股数，不按未来业绩选参数。不保本及亏损反例完整保留，未真实回测。";
export function riskPresetParameters(id: RiskPresetId) {
  const p: Profile = riskProfiles[id];
  return {
    fraction: p.fraction ?? 0.01,
    maxWeight: p.weight ?? 0.2,
    initial: p.initial ?? false,
    totalRisk: p.totalRisk ?? null,
  };
}
export function riskPresetTemplate(id: RiskPresetId): ResearchManagement {
  const p: Profile = riskProfiles[id];
  return {
    riskPreset: id,
    stop: p.atr
      ? { kind: "atr", period: p.atr, multiple: 2 }
      : { kind: "percent", fraction: 0.05 },
    confirmations: 1,
    stressBuffer: 0,
    trail: { kind: "fixed" },
    timeExit: p.days ? { days: p.days, minR: 0.5 } : null,
    ...(p.liquidity ? { liquidityCap: true as const } : {}),
    ...(p.be != null
      ? {
          breakeven: {
            atR: p.be,
            ...(p.structureBe ? {} : { mode: "r-only" as const }),
          },
        }
      : {}),
  };
}

/** Market-value limits stay on current opening equity, even in the initial-budget control. */
export function riskPresetBudget(
  id: RiskPresetId,
  initialCapital: number,
  equity: number,
  held: readonly { quantity: number; entry: number; stop: number | null }[],
  costs: BacktestCosts,
) {
  const p = riskPresetParameters(id);
  if (![initialCapital, equity].every((v) => Number.isFinite(v) && v > 0))
    return null;
  let budget = (p.initial ? initialCapital : equity) * p.fraction;
  if (p.totalRisk != null) {
    let used = 0;
    for (const h of held) {
      if (
        h.stop == null ||
        ![h.quantity, h.entry, h.stop].every((v) => Number.isFinite(v) && v > 0)
      )
        return null;
      used += Math.max(0, plannedStopRisk(h.quantity, h.entry, h.stop, costs));
    }
    budget = Math.min(budget, Math.max(0, equity * p.totalRisk - used));
  }
  return Number.isFinite(budget) ? budget / equity : null;
}
