import type { Bar } from "../../../domain";
import type { VolumeEvidence } from "./research-volume-grid";
import { confirmedExtrema, ma, type ConfirmedExtremum } from "../../../indicators";
import {
  researchVolumeSeries,
  volumeCommonExit,
  type VolumePoint,
} from "./research-volume";

export const volumeStructureIds = [
  "vp-structure-up",
  "vp-structure-range",
  "vp-retest-1",
  "vp-retest-5",
] as const;
export type VolumeStructureId = (typeof volumeStructureIds)[number];
export function isVolumeStructure(id: string): id is VolumeStructureId {
  return (volumeStructureIds as readonly string[]).includes(id);
}
const definitions: Record<VolumeStructureId, [string, string]> = {
  "vp-structure-up": [
    "量价 · 高低点递升突破",
    "此前60根已确认极值的最后4点交替，两个高点和两个低点均抬高、两次低点不破各自当时MA20；当前MA20>MA60、收盘≥MA20，以前20有效均量至少1.5倍收盘突破最近已确认高点。",
  ],
  "vp-structure-range": [
    "量价 · 两次触边区间突破",
    "此前60根最后4个已确认极值交替，两次高点相差≤1%、两次低点相差≤1%、区间高低振幅≤20%；含当日R≥1.5收盘突破两次高点较高者。",
  ],
  "vp-retest-1": [
    "量价 · 结构突破次根回踩",
    "高低点递升、低点守各自当时MA20、MA20>MA60且收盘≥MA20；含当日R≥1.5突破已确认高点后，只等下一根缩量回踩。",
  ],
  "vp-retest-5": [
    "量价 · 结构突破五根内回踩",
    "高低点递升、低点守各自当时MA20、MA20>MA60且收盘≥MA20；含当日R≥1.5突破已确认高点后，最多等待5根缩量回踩。",
  ],
};
function definition(id: VolumeStructureId) {
  const retest = id.startsWith("vp-retest");
  return {
    label: definitions[id][0],
    family: "量价",
    signal: "technical" as const,
    version: `${id}-1`,
    description: `${definitions[id][1]}${retest ? "回踩最低价在冻结突破位至其上0.5%之间、收盘守位、量低于突破日且R≥1才确认，触及当根不提前成交；盘中破位、输入失效或等待超时取消。" : ""}极值需后续3根确认，突破只用前一根已知结构；停牌及高低同时极值隔离，不跨段拼接。次日受约束开盘，保留3根冻结位守卫、共享量价退出与最长持有期。1%触边、0.5%回踩容差和等待期为工程参数，不代表完整五类位置或CZSC买点。`,
    sources: [
      "volume-price-analysis/SKILL.md",
      "volume-price-analysis/references/vp-patterns.md",
      "volume-price-analysis/references/vp-indicators.md",
      "volume-price-analysis/references/vp-astock-caveats.md",
    ],
  };
}
export const volumeStructureStrategies = {
  "vp-structure-up": definition("vp-structure-up"),
  "vp-structure-range": definition("vp-structure-range"),
  "vp-retest-1": definition("vp-retest-1"),
  "vp-retest-5": definition("vp-retest-5"),
};
type Retest = {
  date: string;
  level: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  wait: number;
};
export type VolumeStructurePoint = VolumePoint & {
  structure: {
    asOf: string | null;
    barrier: string | null;
    extrema: ConfirmedExtremum[];
    alternating: boolean;
    higherHighs: boolean;
    higherLows: boolean;
    lowsHoldMa20: boolean;
    up: boolean;
    range: boolean;
    resistance: number | null;
    support: number | null;
  };
  retest: Retest | null;
};
export function volumeStructureWarmupStart(
  bars: readonly Bar[],
  start: string,
) {
  const first = bars.findIndex((b) => b.date >= start);
  if (first < 0) return start;
  // 60-bar structure, endpoint MA20 and a 5-bar waiting candidate. A 90-bar
  // price bound includes the previous trigger too; volume omits suspension.
  const price = bars[Math.max(0, first - 90)]?.date ?? start;
  const volume =
    bars
      .slice(0, Math.max(0, first - 6))
      .filter((b) => b.volume !== 0)
      .slice(-60)[0]?.date ?? price;
  return volume < price ? volume : price;
}
export function researchVolumeStructureSeries(
  id: VolumeStructureId,
  bars: readonly Bar[],
  evidence: VolumeEvidence = {},
): VolumeStructurePoint[] {
  const base = researchVolumeSeries("vp-breakout-1-5", bars, evidence),
    ma20 = ma(bars, 20);
  let candidate: (Retest & { index: number }) | null = null;
  return base.map((point, i) => {
    const v = point.values,
      previous = base[i - 1]?.values,
      start = Math.max(0, i - 60),
      prior = bars.slice(start, i);
    const facts = confirmedExtrema(prior);
    const barrier =
      [
        ...facts.ambiguousDates,
        ...prior.filter((b) => b.volume === 0).map((b) => b.date),
      ]
        .sort()
        .at(-1) ?? null;
    const extrema = facts.extrema
      .filter((p) => !barrier || prior[p.index - 3]!.date > barrier)
      .map((p) => ({ ...p, index: p.index + start }));
    const four = extrema.slice(-4),
      highs = four.filter((p) => p.kind === "high"),
      lows = four.filter((p) => p.kind === "low");
    const alternating =
      four.length === 4 &&
      four.every((p, k) => k === 0 || p.kind !== four[k - 1]!.kind);
    const higherHighs = highs.length === 2 && highs[1]!.price > highs[0]!.price,
      higherLows = lows.length === 2 && lows[1]!.price > lows[0]!.price;
    const lowsHoldMa20 =
      lows.length === 2 &&
      lows.every((p) => ma20[p.index] != null && p.price >= ma20[p.index]!);
    const up =
      alternating &&
      higherHighs &&
      higherLows &&
      lowsHoldMa20 &&
      v.ma20 != null &&
      v.ma60 != null &&
      v.ma20 > v.ma60 &&
      v.close >= v.ma20;
    const ceiling =
        highs.length === 2 ? Math.max(...highs.map((p) => p.price)) : null,
      floor = lows.length === 2 ? Math.min(...lows.map((p) => p.price)) : null;
    const range =
      alternating &&
      ceiling !== null &&
      floor !== null &&
      ceiling / floor - 1 <= 0.2 &&
      Math.abs(highs[1]!.price / highs[0]!.price - 1) <= 0.01 &&
      Math.abs(lows[1]!.price / lows[0]!.price - 1) <= 0.01;
    const resistance =
        id === "vp-structure-range" ? ceiling : (highs.at(-1)?.price ?? null),
      support =
        id === "vp-structure-range" ? floor : (lows.at(-1)?.price ?? null);
    const structure = {
      asOf: prior.at(-1)?.date ?? null,
      barrier,
      extrema,
      alternating,
      higherHighs,
      higherLows,
      lowsHoldMa20,
      up,
      range,
      resistance,
      support,
    };
    const reason =
      point.reason ?? (prior.length < 60 ? "需要突破前60根结构记录" : null);
    let entry = false,
      exit = !reason && volumeCommonExit(v, previous),
      decision = "等待已确认结构";
    let captured: Retest | null = null,
      ruleStop: VolumePoint["ruleStop"];
    if (reason) {
      candidate = null;
      decision = "输入不可用，回踩候选取消";
    } else if (id.startsWith("vp-retest")) {
      if (candidate) {
        captured = { ...candidate };
        const age = i - candidate.index;
        if (age > candidate.wait || v.low < candidate.level || exit) {
          candidate = null;
          decision = "回踩超时或破冻结位，取消";
        } else if (
          v.low <= candidate.level * 1.005 &&
          v.close >= candidate.level &&
          v.volume < candidate.volume &&
          v.ratio5! >= 1
        ) {
          entry = true;
          ruleStop = {
            price: candidate.level,
            days: 3,
            reason: "结构回踩冻结位",
          };
          candidate = null;
          decision = "缩量触及冻结位并守住，回踩确认";
        } else if (age >= candidate.wait) {
          candidate = null;
          decision = "回踩等待期结束";
        }
      }
      if (
        !captured &&
        up &&
        resistance !== null &&
        previous &&
        previous.close <= resistance &&
        v.close > resistance &&
        v.ratio5! >= 1.5 &&
        !exit
      ) {
        candidate = {
          date: point.date,
          index: i,
          level: resistance,
          high: v.high,
          low: v.low,
          close: v.close,
          volume: v.volume,
          wait: id === "vp-retest-1" ? 1 : 5,
        };
        captured = { ...candidate };
        decision = "结构放量突破候选，等待缩量回踩";
      }
    } else {
      entry =
        (id === "vp-structure-range" ? range : up) &&
        resistance !== null &&
        !!previous &&
        previous.close <= resistance &&
        v.close > resistance &&
        (id === "vp-structure-range" ? v.ratio5! : v.ratio20Prior!) >= 1.5;
      if (entry) {
        ruleStop = { price: resistance!, days: 3, reason: "已确认结构突破位" };
        decision =
          id === "vp-structure-range"
            ? "两次触边区间放量上破"
            : "高低点递升结构放量上破";
      }
    }
    if (exit) {
      entry = false;
      ruleStop = undefined;
      decision += "；MA20失守、放量下跌或高位滞涨退出";
    }
    const retest = captured
      ? {
          date: captured.date,
          level: captured.level,
          high: captured.high,
          low: captured.low,
          close: captured.close,
          volume: captured.volume,
          wait: captured.wait,
        }
      : null;
    return {
      date: point.date,
      values: v,
      reason,
      entry,
      exit,
      decision,
      structure,
      retest,
      candidate: retest
        ? {
            date: retest.date,
            high: retest.high,
            low: retest.low,
            close: retest.close,
            wait: retest.wait,
          }
        : null,
      ...(ruleStop ? { ruleStop } : {}),
    };
  });
}
