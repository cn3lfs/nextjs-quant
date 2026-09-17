import type { Bar } from "./domain";
import type { VolumeEvidence } from "./research-volume-grid";
import { priorVolumeRange } from "./indicators";
import {
  researchVolumeSeries,
  volumeCommonExit,
  type VolumePoint,
} from "./research-volume";

export const volumeReversalIds = [
  "vp-panic-2",
  "vp-panic-3",
  "vp-dry-and",
  "vp-dry-or",
] as const;
export type VolumeReversalId = (typeof volumeReversalIds)[number];
export function isVolumeReversal(id: string): id is VolumeReversalId {
  return (volumeReversalIds as readonly string[]).includes(id);
}
const descriptions: Record<VolumeReversalId, [string, string]> = {
  "vp-panic-2": [
    "量价 · 恐慌后两根缩量回收",
    "距60根高点回落≥20%，跌幅>2%、R≥2.5，且下影≥全幅一半、收盘在全幅上半区；随后连续2根R<0.8且不破恐慌低点，再于候选10根内以R≥1.5收盘收复恐慌最高价。",
  ],
  "vp-panic-3": [
    "量价 · 恐慌后三根缩量回收",
    "距60根高点回落≥20%，跌幅>2%、R≥2.5，且下影≥全幅一半、收盘在全幅上半区；随后连续3根R<0.8且不破恐慌低点，再于候选10根内以R≥1.5收盘收复恐慌最高价。",
  ],
  "vp-dry-and": [
    "量价 · 地量三阶段（且）",
    "底部位置代理中R<0.5且低于前60个有效成交记录最小量；20根内先出现1.2≤R<1.5的温和放量，再于后续记录以R≥1.5收盘突破候选时近10根最高价。",
  ],
  "vp-dry-or": [
    "量价 · 地量三阶段（或）",
    "底部位置代理中R<0.5或低于前60个有效成交记录最小量；20根内先出现1.2≤R<1.5的温和放量，再于后续记录以R≥1.5收盘突破候选时近10根最高价。",
  ],
};
function definition(id: VolumeReversalId) {
  return {
    label: descriptions[id][0],
    family: "量价",
    signal: "technical" as const,
    version: `${id}-1`,
    description: `${descriptions[id][1]}R使用含当日的5个有效成交记录均量。数值化长下影、收复价位和等待期限为工程解释。破候选低点、无效输入或进入高位取消；确认前不买入。次日受约束开盘入场，候选低点冻结为入场后3根确认位，另保留MA20下穿、放量下跌/高位滞涨及最长持有期退出。历史换手与事件污染仍待核验。`,
    sources: [
      "volume-price-analysis/SKILL.md",
      "volume-price-analysis/references/vp-patterns.md",
      "volume-price-analysis/references/vp-indicators.md",
      "volume-price-analysis/references/vp-astock-caveats.md",
    ],
  };
}
export const volumeReversalStrategies = {
  "vp-panic-2": definition("vp-panic-2"),
  "vp-panic-3": definition("vp-panic-3"),
  "vp-dry-and": definition("vp-dry-and"),
  "vp-dry-or": definition("vp-dry-or"),
};
type Reversal = {
  date: string;
  high: number;
  low: number;
  close: number;
  wait: number;
  phase: "dry" | "mild" | "panic" | "recovery";
  contracted: number;
  mildDate: string | null;
};
export type VolumeReversalPoint = VolumePoint & {
  reversal: Reversal | null;
  volume60Prior: { low: number | null; high: number | null };
};
export function volumeReversalWarmupStart(bars: readonly Bar[], start: string) {
  const first = bars.findIndex((bar) => bar.date >= start);
  if (first < 0) return start;
  const candidate = Math.max(0, first - 21);
  const priceStart = bars[Math.max(0, candidate - 60)]?.date ?? start;
  const volumeStart =
    bars
      .slice(0, candidate)
      .filter((bar) => bar.volume !== 0)
      .slice(-60)[0]?.date ?? priceStart;
  return volumeStart < priceStart ? volumeStart : priceStart;
}
export function researchVolumeReversalSeries(
  id: VolumeReversalId,
  bars: readonly Bar[],
  evidence: VolumeEvidence = {},
): VolumeReversalPoint[] {
  // Reuse the established input, position and common-exit calculations. The
  // baseline VMA crossover itself is deliberately not inherited as a signal.
  const base = researchVolumeSeries("vp-volume-ma-cross", bars, evidence);
  const ranges = priorVolumeRange(
    bars.map((bar) =>
      bar.volume > 0 && bar.high === bar.low ? { ...bar, volume: NaN } : bar,
    ),
    60,
  );
  const panic = id.startsWith("vp-panic"),
    needed = id === "vp-panic-2" ? 2 : 3;
  let candidate: (Reversal & { index: number }) | null = null;
  let previousTrigger = false;
  return base.map((point, i) => {
    const v = point.values,
      previous = base[i - 1]?.values,
      range = ranges[i]!;
    const reason =
      point.reason ??
      (range.low == null ? "前60个有效量能记录不足/含无效输入" : null);
    const exit = !reason && volumeCommonExit(v, previous);
    let entry = false,
      decision = "等待",
      captured: Reversal | null = null;
    let ruleStop: VolumePoint["ruleStop"];
    if (reason) {
      candidate = null;
      previousTrigger = false;
      decision = "缺失不触发，候选取消";
    } else {
      const lowerWick = Math.min(v.open, v.close) - v.low;
      const trigger = panic
        ? v.dropFromHigh60! >= 0.2 &&
          v.grid?.price === "down" &&
          v.ratio5! >= 2.5 &&
          lowerWick >= (v.high - v.low) / 2 &&
          v.close >= (v.high + v.low) / 2
        : v.location === "bottom-proxy" &&
          (id === "vp-dry-and"
            ? v.ratio5! < 0.5 && v.volume < range.low!
            : v.ratio5! < 0.5 || v.volume < range.low!);
      if (candidate) {
        const age = i - candidate.index;
        if (
          age > candidate.wait ||
          v.low < candidate.low ||
          v.location === "high"
        ) {
          decision = "候选过期、破低或进入高位";
          captured = { ...candidate };
          candidate = null;
        } else if (panic && candidate.phase === "panic") {
          if (v.ratio5! < 0.8) {
            candidate.contracted++;
            if (candidate.contracted === needed) candidate.phase = "recovery";
            decision = "连续缩量守底，等待后续放量收复";
          } else {
            decision = "连续缩量条件中断，取消恐慌候选";
            captured = { ...candidate };
            candidate = null;
          }
        } else if (!panic && candidate.phase === "dry") {
          if (v.ratio5! >= 1.2 && v.ratio5! < 1.5) {
            candidate.phase = "mild";
            candidate.mildDate = point.date;
            decision = "温和放量完成，等待后续突破";
          }
        } else if (v.ratio5! >= 1.5 && v.close > candidate.high && !exit) {
          entry = true;
          decision = panic
            ? "缩量守底后放量收复恐慌高点"
            : "地量、温和放量、放量突破三阶段完成";
          ruleStop = {
            price: candidate.low,
            days: 3,
            reason: panic ? "恐慌候选低点" : "地量候选低点",
          };
          captured = { ...candidate };
          candidate = null;
        }
        if (candidate) {
          captured = { ...candidate };
          if (age >= candidate.wait) {
            decision = "候选等待期结束";
            candidate = null;
          }
        }
      }
      if (!candidate && !entry && trigger && !previousTrigger && !captured) {
        candidate = {
          date: point.date,
          index: i,
          close: v.close,
          high: panic ? v.high : v.high10!,
          low: v.low,
          wait: panic ? 10 : 20,
          phase: panic ? "panic" : "dry",
          contracted: 0,
          mildDate: null,
        };
        captured = { ...candidate };
        decision = panic ? "恐慌候选，尚未缩量确认" : "地量候选，尚未温和放量";
      }
      previousTrigger = trigger;
    }
    if (exit) decision += "；持仓按MA20失守、放量下跌或高位滞涨退出";
    // Index is internal state only; serialize stable, reviewable evidence.
    const reversal = captured
      ? {
          date: captured.date,
          high: captured.high,
          low: captured.low,
          close: captured.close,
          wait: captured.wait,
          phase: captured.phase,
          contracted: captured.contracted,
          mildDate: captured.mildDate,
        }
      : null;
    return {
      date: point.date,
      values: v,
      entry,
      exit,
      reason,
      decision,
      reversal,
      volume60Prior: range,
      candidate: reversal
        ? {
            date: reversal.date,
            high: reversal.high,
            low: reversal.low,
            close: reversal.close,
            wait: reversal.wait,
          }
        : null,
      ...(ruleStop ? { ruleStop } : {}),
    };
  });
}
