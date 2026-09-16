import {
  riskAdmissionBoundary,
  type RiskAdmissionRule,
} from "./research-risk-admission";
import {
  accountRiskBoundary,
  type AccountRiskRule,
} from "./research-account-risk";
import type { ResearchManagement } from "./research-management";
import type { BacktestCosts } from "./backtest-costs";
import { plannedStopRisk } from "./research-risk";

type Profile = {
  account?: AccountRiskRule;
  admission?: RiskAdmissionRule;
  totalWeight?: number;
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
  "rk-admit-win45": {
    method: "SW-P-win45",
    label: "开发段胜率至少45%",
    admission: "win45",
  },
  "rk-admit-positive": {
    method: "SW-P-expect-positive",
    label: "开发段净期望正值",
    admission: "positive",
  },
  "rk-admit-quality3": {
    method: "SW-P-quality3",
    label: "冻结信号质量3/5",
    admission: "quality3",
  },
  "rk-admit-expect-size": {
    method: "SW-P-expect-size",
    label: "开发段期望分档仓位",
    admission: "expect-size",
  },
  "rk-admit-example50": {
    method: "SW-P-example-50-2",
    label: "假设胜率50%回报2R",
    admission: "example50",
  },
  "rk-admit-example40": {
    method: "SW-P-example-40-3",
    label: "假设胜率40%回报3R",
    admission: "example40",
  },
  "rk-admit-example60": {
    method: "SW-P-example-60-1",
    label: "假设胜率60%回报1R",
    admission: "example60",
  },
  "rk-admit-kelly30": {
    method: "SW-P-kelly30",
    label: "2%风险/半凯利/30%组合",
    admission: "kelly30",
    fraction: 0.02,
    weight: 0.3,
    totalWeight: 0.3,
  },
  "rk-admit-expect02": {
    method: "RK-C-expect02",
    label: "净期望至少0.2R",
    admission: "expect02",
  },
  "rk-admit-rr2": {
    method: "RK-C-rr2",
    label: "实际开盘费用后2R",
    admission: "rr2",
  },
  "rk-admit-quarter-kelly": {
    method: "RK-C-kelly-uncertain",
    label: "不确定参数四分之一凯利",
    admission: "quarter-kelly",
  },
  "sw-time5": { method: "SW-P-time5", label: "5交易日未达0.5R退出", days: 5 },
  "rk-reduce-half": {
    method: "RK-F-reduce",
    label: "风险与市值预算直接减半",
    fraction: 0.005,
    weight: 0.1,
  },
  "rk-account-day2": {
    method: "RK-E-daily",
    label: "日亏2%次日暂停",
    account: "day2",
  },
  "rk-account-week6": {
    method: "RK-E-weekly",
    label: "周亏6%本周暂停",
    account: "week6",
  },
  "rk-account-month6": {
    method: "RK-E-monthly",
    label: "月亏6%本月暂停",
    account: "month6",
  },
  "rk-account-streak5-half": {
    method: "RK-E-streak",
    label: "连亏5笔减半至正R",
    account: "streak5-half",
  },
  "rk-account-drawdown10": {
    method: "RK-E-drawdown",
    label: "回撤10%休息5交易日",
    account: "drawdown10",
  },
  "rk-account-equity20": {
    method: "RK-E-equity",
    label: "权益MA20开关",
    account: "equity20",
  },
  "rk-account-week3r": {
    method: "RK-E-week3r",
    label: "周亏3R暂停",
    account: "week3r",
  },
  "rk-account-elder6": {
    method: "RK-E-elder2-6",
    label: "Elder单笔2%月回撤6%",
    account: "elder6",
    fraction: 0.02,
  },
  "rk-account-month-win35": {
    method: "SW-P-month-win",
    label: "月胜率低于35%连续两月",
    account: "month-win35",
  },
  "rk-account-month-rr15": {
    method: "SW-P-month-rr",
    label: "月净盈亏比低于1.5连续两月",
    account: "month-rr15",
  },
  "rk-account-month-negative3": {
    method: "SW-P-month-negative3",
    label: "连续三完整月亏损",
    account: "month-negative3",
  },
  "rk-account-day5-week": {
    method: "SW-P-day5-week",
    label: "日亏超过5%休息一周",
    account: "day5-week",
  },
  "rk-account-loss5-week": {
    method: "SW-P-loss5-week",
    label: "连亏5笔休息一周",
    account: "loss5-week",
  },
  "rk-account-drawdown15-week": {
    method: "SW-P-dd15-week",
    label: "回撤超过15%休息一周",
    account: "drawdown15-week",
  },
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
  "B2规模/演化工程v1：均为固定双突破入场、60交易日上限的独立对照，默认初始5%止损、当前权益1%含费风险和20%单股上限。五档风险不代表已知胜率；硬2%版禁止更高输入。初始权益版仅冻结风险金额基数，市值和可用现金仍以开盘已知现金加其余持仓前收估值约束。组合在险为逐持仓max(0,原始入场价至当前有效止损的含费规划损失)之和，盈利保护不能抵消其他持仓风险；预算不足或持仓估值/止损缺失不新入。15%/20%市值与前20日均成交额1%容量统一换算为股数向下取整，实际跳空可超预算。保本0.3/0.5/1R只用当时收盘浮盈、下一交易日起生效；结构版另需因果确认更高低点。10日无进展工程冻结为未达到0.5R，价格止损并存。ATR10/20共享算术ATR、均为2倍，仅改变初始定位及其风险股数，不按未来业绩选参数。不保本及亏损反例完整保留，未真实回测。" +
  accountRiskBoundary +
  riskAdmissionBoundary;
export function riskPresetAdmission(id: RiskPresetId) {
  return (riskProfiles[id] as Profile).admission;
}
export function riskPresetAccount(id: RiskPresetId) {
  return (riskProfiles[id] as Profile).account;
}
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
    ...(p.totalWeight != null ? { maxTotalWeight: p.totalWeight } : {}),
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
