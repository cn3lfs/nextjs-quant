import type { Bar } from "./domain";
import { ma, macd, rsi, volumeMa } from "./indicators";
import {
  researchTechnicalMethodSeries,
  type TechnicalMethodId,
} from "./research-technical-methods";
import type { LegacyTechnicalStrategyId } from "./research-technical";
export const indicatorCombinationProfiles = {
  "sw-macd-combined": {
    method: "SW06",
    label: "MACD交叉柱形背离组合",
    legacy: ["macd-golden", "macd-golden-positive", "macd-histogram-turn"],
    methods: [
      "sw-macd-negative",
      "sw-macd-red",
      "sw-macd-green",
      "sw-macd-top",
      "sw-macd-bottom",
      "sw-macd-double-top",
      "sw-macd-double-bottom",
    ],
  },
  "sw-kdj-combined": {
    method: "SW07",
    label: "KDJ区间与MACD方向组合",
    legacy: ["kdj-golden", "kdj-extreme", "kdj-macd-confirmed"],
    methods: ["sw-kdj-zone", "sw-kdj-range"],
  },
  "sw-rsi-combined": {
    method: "SW08",
    label: "RSI恢复背离与方向组合",
    legacy: ["rsi-recovery", "rsi-50-cross"],
    methods: ["sw-rsi-state", "sw-rsi-neutral", "sw-rsi-top", "sw-rsi-bottom"],
  },
  "sw-boll-combined": {
    method: "SW09",
    label: "布林收口开口沿轨组合",
    legacy: ["boll-middle-cross", "boll-band-recovery"],
    methods: [
      "sw-boll-squeeze",
      "sw-boll-expand",
      "sw-boll-upper",
      "sw-boll-lower",
    ],
  },
  "sw-ma-combined": {
    method: "SW10",
    label: "均线交叉排列回踩组合",
    legacy: [
      "ma-golden-5-10",
      "ma-golden-10-20",
      "ma-golden-20-60",
      "ma-alignment",
    ],
    methods: [
      "sw-support-20",
      "sw-support-60",
      "sw-support-120",
      "sw-support-250",
      "sw-bear-order",
      "sw-tangle",
    ],
  },
} as const;
export type IndicatorCombinationId = keyof typeof indicatorCombinationProfiles;
export const indicatorCombinationIds = Object.keys(
  indicatorCombinationProfiles,
) as IndicatorCombinationId[];
export function isIndicatorCombination(
  id: string,
): id is IndicatorCombinationId {
  return Object.hasOwn(indicatorCombinationProfiles, id);
}
export const indicatorCombinationBoundary =
  "工程父组合v1：复用全部对应具名子方法，保留每个子方法证据；任一买触发需前20日均量1.5倍确认，任一卖触发优先退出。MACD入场另需RSI6>50；KDJ入场需DIF>DEA且K≤80；RSI入场需DIF>DEA且不在[40,60]，超卖恢复因此等待趋势确认；布林需收盘>MA20；均线需MA5>MA10>MA20>MA60且非交织，MA120/250子规则尚未预热不伪造对应信号，其他已可用分支可交易。子规则均为既有工程定义，组合是独立假设，不把原文并列表当唯一逻辑。只有从未满足转满足才新入，同日退出优先，不做空；收盘确认下一可成交开盘，最长持有期有效，全部历史公司行动证据必需。";
export function indicatorCombinationDefinition(id: IndicatorCombinationId) {
  return {
    label: `波段 · ${indicatorCombinationProfiles[id].label}`,
    family: "波段指标组合",
    signal: "technical" as const,
    version: `${id}-engineering-1`,
    sources: ["swing-trader/references/technical-indicators.md"],
    description: indicatorCombinationBoundary,
  };
}
type Member = {
  id: string;
  entry: boolean;
  exit: boolean;
  reason: string | null;
};
export function indicatorCombinationDecision(
  id: IndicatorCombinationId,
  members: readonly Member[],
  facts: {
    ratio: number;
    strength: number;
    dif: number;
    dea: number;
    k: number;
    close: number;
    ma5: number;
    ma10: number;
    ma20: number;
    ma60: number;
  },
) {
  const v = facts,
    available = members.filter((m) => m.reason === null);
  const keys: (keyof typeof facts)[] =
    id === "sw-macd-combined"
      ? ["ratio", "strength"]
      : id === "sw-kdj-combined"
        ? ["ratio", "dif", "dea", "k"]
        : id === "sw-rsi-combined"
          ? ["ratio", "dif", "dea", "strength"]
          : id === "sw-boll-combined"
            ? ["ratio", "close", "ma20"]
            : ["ratio", "ma5", "ma10", "ma20", "ma60"];
  if (!available.length || !keys.every((k) => Number.isFinite(v[k])))
    return { entry: false, exit: false, reason: "组合所需指标未可用" };
  const direction =
    id === "sw-macd-combined"
      ? v.strength > 50
      : id === "sw-kdj-combined"
        ? v.dif > v.dea && v.k <= 80
        : id === "sw-rsi-combined"
          ? v.dif > v.dea && (v.strength < 40 || v.strength > 60)
          : id === "sw-boll-combined"
            ? v.close > v.ma20
            : v.ma5 > v.ma10 &&
              v.ma10 > v.ma20 &&
              v.ma20 > v.ma60 &&
              !available.some((m) => m.id === "sw-tangle" && m.exit);
  const exit = available.some((m) => m.exit);
  return {
    entry:
      !exit && v.ratio >= 1.5 && direction && available.some((m) => m.entry),
    exit,
    reason: null,
  };
}
export function researchIndicatorCombinationSeries(
  id: IndicatorCombinationId,
  bars: readonly Bar[],
  legacy: (
    id: LegacyTechnicalStrategyId,
    bars: readonly Bar[],
  ) => { date: string; entry: boolean; exit: boolean; reason: string | null }[],
) {
  const profile = indicatorCombinationProfiles[id];
  const members = [
    ...profile.legacy.map((key) => ({ id: key, points: legacy(key, bars) })),
    ...profile.methods.map((key) => ({
      id: key,
      points: researchTechnicalMethodSeries(key as TechnicalMethodId, bars),
    })),
  ];
  const averages = [5, 10, 20, 60].map((n) => ma(bars, n)),
    momentum = macd(bars),
    strength = rsi(bars),
    volume = volumeMa(bars, 20, true);
  let active = false;
  return bars.map((bar, i) => {
    const evidence = members.map((m) => ({
      id: m.id,
      entry: m.points[i]!.entry,
      exit: m.points[i]!.exit,
      reason: m.points[i]!.reason,
    }));
    const kPoint = members.find((m) => m.id === "sw-kdj-zone")?.points[i];
    const k =
      kPoint && "values" in kPoint
        ? (kPoint.values as Record<string, number>).k!
        : NaN;
    const decision = indicatorCombinationDecision(id, evidence, {
      ratio: bar.volume / (volume[i] ?? NaN),
      strength: strength[i]!.rsi6 ?? NaN,
      dif: momentum[i]!.dif ?? NaN,
      dea: momentum[i]!.dea ?? NaN,
      k,
      close: bar.close,
      ma5: averages[0]![i] ?? NaN,
      ma10: averages[1]![i] ?? NaN,
      ma20: averages[2]![i] ?? NaN,
      ma60: averages[3]![i] ?? NaN,
    });
    const valid =
      [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
        (v) => Number.isFinite(v) && v > 0,
      ) &&
      bar.high >= Math.max(bar.open, bar.close) &&
      bar.low <= Math.min(bar.open, bar.close);
    const entry = valid && decision.entry && !active;
    active = valid && decision.entry;
    return {
      date: bar.date,
      entry,
      exit: valid && decision.exit,
      reason: valid ? decision.reason : "当日量价无效",
      values: { close: bar.close } as Record<string, number | null>,
      members: evidence,
      historyStart: bars[0]!.date,
    };
  });
}
