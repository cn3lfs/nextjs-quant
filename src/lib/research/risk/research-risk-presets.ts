import { riskScenarioBoundary } from "./research-risk-scenarios";
import { stopCalibrationBoundary } from "./research-stop-calibration";
import type { VolatilityStopId } from "./research-volatility-stops";
import type { Bar } from "../../domain";
import {
  riskAdmissionBoundary,
  type RiskAdmissionRule,
} from "./research-risk-admission";
import {
  accountRiskBoundary,
  type AccountRiskRule,
} from "./research-account-risk";
import type { ResearchManagement } from "../workflow/research-management";
import type { BacktestCosts } from "../../backtest/backtest-costs";
import { plannedStopRisk } from "./research-risk";

type Profile = {
  noSingleStop?: boolean;
  meanReversion?: boolean;
  chop?: "pause" | "spacing";
  slipReport?: boolean;
  crowded?: {
    anchor: "round" | "swing-low" | "trend";
    multiple: 0 | 0.3 | 0.5;
  };
  rebalance?: boolean;
  line?: VolatilityStopId;
  respect?: boolean;
  mae?: boolean;
  chan?: boolean;
  location?: "atr-bands" | "farther";
  structureTrail?: boolean;
  disaster?: "2r" | "3pct";
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
  "rk-mean-stop": {
    method: "RK-F-no-single-stop",
    label: "布林回归有单笔5%止损对照",
    meanReversion: true,
    weight: 0.1,
    totalWeight: 0.3,
    account: "drawdown10",
  },
  "rk-mean-no-stop": {
    method: "RK-F-no-single-stop",
    label: "布林回归无单笔止损/账户仓位约束",
    meanReversion: true,
    noSingleStop: true,
    weight: 0.1,
    totalWeight: 0.3,
    account: "drawdown10",
  },
  "rk-chop-pause": {
    method: "RK-E-chop-frequency",
    label: "频繁止损与震荡后暂停5日",
    chop: "pause",
  },
  "rk-chop-spacing": {
    method: "RK-E-chop-frequency",
    label: "频繁止损与震荡后间隔5日",
    chop: "spacing",
  },
  "rk-slip-report": {
    method: "RK-C-slip-report",
    label: "原脚本不缩股滑点诊断对照",
    slipReport: true,
  },
  "rk-crowded-round-0": {
    method: "RK-A-crowded-buffer",
    label: "round 0ATR缓冲对照",
    atr: 14,
    crowded: { anchor: "round", multiple: 0 },
  },
  "rk-crowded-round-3": {
    method: "RK-A-crowded-buffer",
    label: "round 0.3ATR缓冲对照",
    atr: 14,
    crowded: { anchor: "round", multiple: 0.3 },
  },
  "rk-crowded-round-5": {
    method: "RK-A-crowded-buffer",
    label: "round 0.5ATR缓冲对照",
    atr: 14,
    crowded: { anchor: "round", multiple: 0.5 },
  },
  "rk-crowded-swing-low-0": {
    method: "RK-A-crowded-buffer",
    label: "swing-low 0ATR缓冲对照",
    atr: 14,
    crowded: { anchor: "swing-low", multiple: 0 },
  },
  "rk-crowded-swing-low-3": {
    method: "RK-A-crowded-buffer",
    label: "swing-low 0.3ATR缓冲对照",
    atr: 14,
    crowded: { anchor: "swing-low", multiple: 0.3 },
  },
  "rk-crowded-swing-low-5": {
    method: "RK-A-crowded-buffer",
    label: "swing-low 0.5ATR缓冲对照",
    atr: 14,
    crowded: { anchor: "swing-low", multiple: 0.5 },
  },
  "rk-crowded-trend-0": {
    method: "RK-A-crowded-buffer",
    label: "trend 0ATR缓冲对照",
    atr: 14,
    crowded: { anchor: "trend", multiple: 0 },
  },
  "rk-crowded-trend-3": {
    method: "RK-A-crowded-buffer",
    label: "trend 0.3ATR缓冲对照",
    atr: 14,
    crowded: { anchor: "trend", multiple: 0.3 },
  },
  "rk-crowded-trend-5": {
    method: "RK-A-crowded-buffer",
    label: "trend 0.5ATR缓冲对照",
    atr: 14,
    crowded: { anchor: "trend", multiple: 0.5 },
  },

  "rk-rebalance": {
    method: "RK-F-rebalance",
    label: "月初收盘20%上限再平衡减仓",
    rebalance: true,
    totalWeight: 0.6,
  },
  "rk-indicator-ema20": {
    method: "RK-A4-indicator",
    label: "EMA20初始指标线止损",
    line: "rk-ema20",
    respect: false,
  },
  "rk-respect-ema20": {
    method: "RK-A4-respect",
    label: "EMA20历史沿线准入",
    line: "rk-ema20",
    respect: true,
  },
  "rk-indicator-ma60": {
    method: "RK-A4-indicator",
    label: "MA60初始指标线止损",
    line: "rk-ma60",
    respect: false,
  },
  "rk-respect-ma60": {
    method: "RK-A4-respect",
    label: "MA60历史沿线准入",
    line: "rk-ma60",
    respect: true,
  },
  "rk-indicator-ma120": {
    method: "RK-A4-indicator",
    label: "MA120初始指标线止损",
    line: "rk-ma120",
    respect: false,
  },
  "rk-respect-ma120": {
    method: "RK-A4-respect",
    label: "MA120历史沿线准入",
    line: "rk-ma120",
    respect: true,
  },
  "rk-indicator-boll-mid": {
    method: "RK-A4-indicator",
    label: "布林中轨初始指标线止损",
    line: "rk-boll-mid",
    respect: false,
  },
  "rk-respect-boll-mid": {
    method: "RK-A4-respect",
    label: "布林中轨历史沿线准入",
    line: "rk-boll-mid",
    respect: true,
  },
  "rk-indicator-keltner-mid": {
    method: "RK-A4-indicator",
    label: "Keltner中线初始指标线止损",
    line: "rk-keltner-mid",
    respect: false,
  },
  "rk-respect-keltner-mid": {
    method: "RK-A4-respect",
    label: "Keltner中线历史沿线准入",
    line: "rk-keltner-mid",
    respect: true,
  },
  "rk-indicator-sar": {
    method: "RK-A4-indicator",
    label: "SAR初始指标线止损",
    line: "rk-sar",
    respect: false,
  },
  "rk-respect-sar": {
    method: "RK-A4-respect",
    label: "SAR历史沿线准入",
    line: "rk-sar",
    respect: true,
  },
  "rk-chan-line": {
    method: "RK-A4-chan-line",
    label: "原生已确认三买中枢ZG止损",
    chan: true,
  },
  "rk-mae": {
    method: "RK-A5-mae",
    label: "开发段百笔MAE百分比Q90止损",
    mae: true,
  },

  "rk-atr-bands": {
    method: "RK-A1-atr-bands",
    label: "ATR14价格比分档3/5/8%",
    atr: 14,
    location: "atr-bands",
  },
  "rk-structure-farther": {
    method: "RK-V-structure-farther",
    label: "结构与2ATR取更远并缩股",
    location: "farther",
  },
  "rk-structure-trail": {
    method: "RK-D3-structure",
    label: "确认更高低点结构跟随",
    structureTrail: true,
  },
  "rk-disaster2r": {
    method: "RK-C-disaster",
    label: "独立-2R灾难确认",
    disaster: "2r",
  },
  "rk-disaster3pct": {
    method: "RK-C-disaster",
    label: "独立-3%灾难确认",
    disaster: "3pct",
  },
  "sw-riskcap3": {
    method: "SW11-risk-cap3",
    label: "3%含费规划与实际超限记录",
    fraction: 0.03,
  },
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
  "新增定位v1：ATR14/实际入场价>3%用8%、<1.5%用3%，两等号及中间档5%为显式工程版本。结构更远初始取min(结构减0.3ATR14,入场减2ATR14)，每条候选均有效才采用，风险股数按最终距离计算。结构跟随沿用60根3左3右因果更高低点确认，须入场后且高于入场价，只升不降、次日生效。灾难-2R/-3%两个对照均独立于初始5%技术止损和1%预算，日线最低价确认后次日可成交开盘，不冒充瞬时盘中备份或保证成交。3%风险版记录入场权益、计划含费风险及结算实际损失/超限，跳空不保证3%封顶。" +
  riskScenarioBoundary +
  stopCalibrationBoundary +
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
    stop:
      p.location === "farther"
        ? { kind: "structure-atr", period: 14, multiple: 0.3 }
        : p.atr
          ? { kind: "atr", period: p.atr, multiple: 2 }
          : { kind: "percent", fraction: 0.05 },
    confirmations: 1,
    stressBuffer: 0,
    trail: p.line ? { kind: "volatility", profile: p.line } : { kind: "fixed" },
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

export function riskPresetInitialStop(
  id: RiskPresetId,
  entry: number,
  evidence: { initialStop?: number | null; stopAtr?: number | null },
): number | null | undefined {
  const p: Profile = riskProfiles[id];
  if (!p.location) return undefined;
  const a = evidence.stopAtr;
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    a == null ||
    !Number.isFinite(a) ||
    a <= 0
  )
    return null;
  if (p.location === "atr-bands")
    return (
      entry * (1 - (a / entry > 0.03 ? 0.08 : a / entry < 0.015 ? 0.03 : 0.05))
    );
  const structure = evidence.initialStop;
  if (
    structure == null ||
    !Number.isFinite(structure) ||
    structure <= 0 ||
    structure >= entry
  )
    return null;
  const stop = Math.min(structure - 0.3 * a, entry - 2 * a);
  return stop > 0 && stop < entry ? stop : null;
}
export function riskPresetEvolution(id: RiskPresetId | undefined) {
  return id ? (riskProfiles[id] as Profile) : null;
}

export function riskDisasterTriggered(
  bar: Bar | undefined,
  entry: number,
  initialStop: number,
  kind: "2r" | "3pct",
): boolean | null {
  if (
    !bar ||
    ![
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      bar.volume,
      entry,
      initialStop,
    ].every((v) => Number.isFinite(v) && v > 0) ||
    bar.high < Math.max(bar.open, bar.close) ||
    bar.low > Math.min(bar.open, bar.close) ||
    initialStop >= entry
  )
    return null;
  return (
    bar.low <=
    (kind === "2r" ? entry - 2 * (entry - initialStop) : entry * 0.97)
  );
}

export function riskPresetBase(id: RiskPresetId) {
  return (riskProfiles[id] as Profile).meanReversion
    ? ("boll-band-recovery" as const)
    : ("dual-breakout" as const);
}
