import type { Bar } from "../../../domain";
import type { VolumeEvidence } from "./research-volume-grid";
import { hasVolumePulses } from "./research-volume-sequence";
import { obv, priorVolumeRange } from "../../../indicators";
import {
  researchVolumeSeries,
  volumeCommonExit,
  type VolumePoint,
} from "./research-volume";

export const volumeContextIds = [
  "vp-obv-high",
  "vp-obv-top-exit",
  "vp-obv-bottom",
  "vp-obv-flat",
  "vp-stack-3",
  "vp-contract-3",
  "vp-huge-next-exit",
  "vp-huge-second-exit",
  "vp-interval-3",
  "vp-isolated-filter",
  "vp-stall-exit",
  "vp-high-low-volume-exit",
] as const;
export type VolumeContextId = (typeof volumeContextIds)[number];
export function isVolumeContext(id: string): id is VolumeContextId {
  return (volumeContextIds as readonly string[]).includes(id);
}
const labels: Record<VolumeContextId, [string, string]> = {
  "vp-interval-3": [
    "量价 · 三次间隔放量突破",
    "上涨/区间/底部代理中7根依次为放量、缩量、缩量、放量、缩量、缩量、放量，放量R≥1.5、缩量R<0.8；末根收盘突破前20根最高价才买入。固定隔两根是工程变体。",
  ],
  "vp-isolated-filter": [
    "放量突破 · 孤量过滤",
    "沿用前20有效均量1.5倍突破；若此前连续3根R<0.8且突破当根R≥2.5，先等待下一根R≥1.5、收盘不低于候选收盘且盘中不失守冻结突破位，再确认入场。否则取消；非该孤量风险形态保留基线入场。消息面与盘中成交未核验。",
  ],
  "vp-stall-exit": [
    "放量突破 · 量增涨幅收敛退出",
    "沿用前20有效均量1.5倍突破入场；上涨/高位代理中连续3根量递增、正涨幅严格递减，末根量创新60有效记录高点且最高价达到前20根最高价时退出。三根收敛是工程变体。",
  ],
  "vp-high-low-volume-exit": [
    "放量突破 · 缩量新高退出",
    "沿用前20有效均量1.5倍突破入场；当根最高价严格超过前20根最高价，但成交量低于前高所在记录的量时退出。前高相同时取最近一根；比较前高点的量，不用均量代替。",
  ],
  "vp-obv-high": [
    "OBV · 价格同步新高",
    "上涨位置收盘与OBV同时严格超过各自前20根最高值，首次满足买入；价创新高而OBV未创新高退出。",
  ],
  "vp-obv-top-exit": [
    "放量突破 · OBV顶背离退出",
    "沿用前20日均量1.5倍突破入场；收盘严格超过前20根最高收盘但OBV不超过前20根最高OBV时退出。",
  ],
  "vp-obv-bottom": [
    "OBV · 底背离后收复",
    "距60根高点回落≥20%，收盘创新20根低点但OBV不创新20根低点，建立候选；5根内R≥1.2且收盘超过候选最高价才买入，破候选最低价取消。",
  ],
  "vp-obv-flat": [
    "OBV · 横盘累积转强",
    "近10根价格振幅≤5%，OBV连续5根严格递增，处于上涨/区间/底部代理时首次买入；同一横盘条件下OBV连续5根严格递减退出。",
  ],
  "vp-stack-3": [
    "量价 · 三根温和递增",
    "上涨位置连续3根成交量严格递增，三根R均在[1.2,1.5)，收盘不下降，首次满足买入；不是单根放量。",
  ],
  "vp-contract-3": [
    "量价 · 三根递减后突破",
    "上涨/区间/底部代理中连续3根成交量严格递减且近5根价格振幅≤5%，建立候选；10根内R≥1.5收盘突破候选时近5根最高价才买入，跌破区间最低价取消。",
  ],
  "vp-huge-next-exit": [
    "放量突破 · 天量次日确认退出",
    "沿用前20日均量1.5倍突破入场；高位R≥2.5或成交量创新60个有效记录高点且最高价不低于前20根最高价，下一根R<0.8且未创新高时退出。",
  ],
  "vp-huge-second-exit": [
    "放量突破 · 天量后二顶退出",
    "沿用前20日均量1.5倍突破入场；高位巨量候选后10根内最高价超过候选以来最高价、成交量低于候选且R<0.8时退出；连续2根R≥1.5且接连创新高取消原顶部候选。",
  ],
};
function definition(id: VolumeContextId) {
  const baseline = id.endsWith("exit") || id === "vp-isolated-filter";
  return {
    label: labels[id][0],
    family: "量价",
    signal: "technical" as const,
    version: `${id}-1`,
    description: `${labels[id][1]}OBV从零起算，只比较同一连续有效窗口的相对高低，不代表真实资金流。20根比较、3/5根连续、5%区间及等待期限为工程参数；位置沿用公开代理。缺失、一字和复牌初期不触发。次日受约束开盘；MA20失守、放量下跌/高位滞涨及最长持有期退出继续有效。候选买入与基线突破保留原冻结位守卫，历史换手和量能污染未核验。`,
    sources: [
      "volume-price-analysis/SKILL.md",
      "volume-price-analysis/references/vp-patterns.md",
      "volume-price-analysis/references/vp-indicators.md",
      "volume-price-analysis/references/vp-astock-caveats.md",
      ...(baseline ? ["swing-trader/references/technical-indicators.md"] : []),
    ],
  };
}
export const volumeContextStrategies = {
  "vp-interval-3": definition("vp-interval-3"),
  "vp-isolated-filter": definition("vp-isolated-filter"),
  "vp-stall-exit": definition("vp-stall-exit"),
  "vp-high-low-volume-exit": definition("vp-high-low-volume-exit"),
  "vp-obv-high": definition("vp-obv-high"),
  "vp-obv-top-exit": definition("vp-obv-top-exit"),
  "vp-obv-bottom": definition("vp-obv-bottom"),
  "vp-obv-flat": definition("vp-obv-flat"),
  "vp-stack-3": definition("vp-stack-3"),
  "vp-contract-3": definition("vp-contract-3"),
  "vp-huge-next-exit": definition("vp-huge-next-exit"),
  "vp-huge-second-exit": definition("vp-huge-second-exit"),
};
type ContextCandidate = {
  highest: number;
  advances: number;
  date: string;
  high: number;
  low: number;
  close: number;
  volume: number;
  wait: number;
};
export type VolumeContextPoint = VolumePoint & {
  multiDay?: {
    volumes: number[];
    ratios: (number | null)[];
    changes: (number | null)[];
    previousHigh: { date: string; high: number; volume: number } | null;
    isolatedRisk: boolean;
  };
  context: {
    obv: number | null;
    obvHigh20: number | null;
    obvLow20: number | null;
    closeHigh20: number | null;
    closeLow20: number | null;
    volumeHigh60: number | null;
    range5: number | null;
    range10: number | null;
    obvUp5: boolean;
    obvDown5: boolean;
    stack3: boolean;
    contract3: boolean;
    topDivergence: boolean;
    bottomDivergence: boolean;
  };
  contextCandidate: ContextCandidate | null;
};
export function researchVolumeContextSeries(
  id: VolumeContextId,
  bars: readonly Bar[],
  evidence: VolumeEvidence = {},
): VolumeContextPoint[] {
  const base = researchVolumeSeries("vp-breakout-1-5", bars, evidence);
  const input = bars.map((bar) =>
    bar.volume > 0 && bar.high === bar.low ? { ...bar, volume: NaN } : bar,
  );
  const line = obv(input),
    volumeRange = priorVolumeRange(input, 60);
  let candidate: (ContextCandidate & { index: number }) | null = null;
  let previousTrigger = false;
  return base.map((point, i) => {
    const v = point.values,
      prior = bars.slice(Math.max(0, i - 20), i),
      priorObv = line.slice(Math.max(0, i - 20), i);
    const valid =
      prior.length === 20 &&
      priorObv.every((x) => x !== null) &&
      line[i] != null;
    const high = valid ? Math.max(...prior.map((b) => b.close)) : null,
      low = valid ? Math.min(...prior.map((b) => b.close)) : null;
    const obvHigh = valid ? Math.max(...(priorObv as number[])) : null,
      obvLow = valid ? Math.min(...(priorObv as number[])) : null;
    const last5 = bars.slice(Math.max(0, i - 4), i + 1),
      last10 = bars.slice(Math.max(0, i - 9), i + 1),
      last3 = base.slice(Math.max(0, i - 2), i + 1);
    const range5 =
      last5.length === 5
        ? Math.max(...last5.map((b) => b.high)) /
            Math.min(...last5.map((b) => b.low)) -
          1
        : null;
    const range10 =
      last10.length === 10
        ? Math.max(...last10.map((b) => b.high)) /
            Math.min(...last10.map((b) => b.low)) -
          1
        : null;
    const five = line.slice(Math.max(0, i - 4), i + 1);
    const obvUp5 =
      five.length === 5 &&
      five.every(
        (x, k) =>
          x !== null && (k === 0 || (five[k - 1] != null && x > five[k - 1]!)),
      );
    const obvDown5 =
      five.length === 5 &&
      five.every(
        (x, k) =>
          x !== null && (k === 0 || (five[k - 1] != null && x < five[k - 1]!)),
      );
    const stack3 =
      last3.length === 3 &&
      last3.every(
        (p, k) =>
          p.reason === null &&
          p.values.ratio5! >= 1.2 &&
          p.values.ratio5! < 1.5 &&
          (k === 0 ||
            (p.values.volume > last3[k - 1]!.values.volume &&
              p.values.close >= last3[k - 1]!.values.close)),
      );
    const contract3 =
      last3.length === 3 &&
      last3.every(
        (p, k) =>
          p.reason === null &&
          (k === 0 || p.values.volume < last3[k - 1]!.values.volume),
      );
    const topDivergence = valid && v.close > high! && line[i]! <= obvHigh!;
    const bottomDivergence = valid && v.close < low! && line[i]! >= obvLow!;
    const context = {
      obv: line[i] ?? null,
      obvHigh20: obvHigh,
      obvLow20: obvLow,
      closeHigh20: high,
      closeLow20: low,
      volumeHigh60: volumeRange[i]!.high,
      range5,
      range10,
      obvUp5,
      obvDown5,
      stack3,
      contract3,
      topDivergence,
      bottomDivergence,
    };
    const reason =
      point.reason ??
      (!valid || context.volumeHigh60 === null
        ? "连续20根OBV或前60有效量能窗口不足/含无效输入"
        : null);
    let entry = false,
      exit = !reason && volumeCommonExit(v, base[i - 1]?.values),
      decision = "等待";
    const commonExit = exit;
    const multi = [
      "vp-interval-3",
      "vp-isolated-filter",
      "vp-stall-exit",
      "vp-high-low-volume-exit",
    ].includes(id);
    const seven = base.slice(Math.max(0, i - 6), i + 1);
    const previousThree = base.slice(Math.max(0, i - 3), i);
    const isolatedRisk =
      previousThree.length === 3 &&
      previousThree.every((p) => p.reason === null && p.values.ratio5! < 0.8) &&
      v.ratio5! >= 2.5;
    const previousHigh =
      prior.length === 20
        ? prior.reduce((best, bar) => (bar.high >= best.high ? bar : best))
        : null;
    const multiDay = multi
      ? {
          volumes: seven.map((p) => p.values.volume),
          ratios: seven.map((p) => p.values.ratio5),
          changes: seven.map((p) => p.values.change),
          previousHigh: previousHigh
            ? {
                date: previousHigh.date,
                high: previousHigh.high,
                volume: previousHigh.volume,
              }
            : null,
          isolatedRisk,
        }
      : undefined;
    let captured: ContextCandidate | null = null,
      ruleStop: VolumePoint["ruleStop"];
    if (reason) {
      candidate = null;
      previousTrigger = false;
      decision = "缺失不触发，候选取消";
    } else {
      const eligible = ["up-ma-proxy", "range-proxy", "bottom-proxy"].includes(
        v.location,
      );
      const baseline = id.endsWith("exit");
      if (baseline && point.entry) {
        entry = true;
        ruleStop = point.ruleStop;
        decision = "基线放量突破入场";
      }
      let trigger = false;
      if (id === "vp-interval-3") {
        trigger =
          eligible &&
          hasVolumePulses(
            seven.map((p) => (p.reason === null ? p.values.ratio5 : null)),
            2,
            3,
          ) &&
          v.close > v.high20Prior!;
        entry = trigger && !previousTrigger;
        if (entry) {
          decision = "三次间隔放量后收盘突破";
          ruleStop = {
            price: v.high20Prior!,
            days: 3,
            reason: "间隔放量突破位",
          };
        }
      } else if (id === "vp-isolated-filter") {
        if (candidate) {
          captured = { ...candidate };
          if (
            i - candidate.index === 1 &&
            v.ratio5! >= 1.5 &&
            v.close >= candidate.close &&
            v.low >= candidate.low &&
            !exit
          ) {
            entry = true;
            decision = "孤量风险候选获次根量价延续确认";
            ruleStop = {
              price: candidate.low,
              days: 3,
              reason: "孤量过滤冻结突破位",
            };
          } else
            decision =
              v.ratio5! < 0.8
                ? "前后缩量形成孤量，取消买入"
                : "次根量价延续未确认，取消买入";
          candidate = null;
        }
        if (!captured && point.entry && !exit) {
          if (isolatedRisk) {
            candidate = {
              date: point.date,
              index: i,
              high: v.high,
              highest: v.high,
              advances: 0,
              low: point.ruleStop!.price,
              close: v.close,
              volume: v.volume,
              wait: 1,
            };
            captured = { ...candidate };
            decision = "孤量风险候选，等待次根确认";
          } else {
            entry = true;
            ruleStop = point.ruleStop;
            decision = "非孤量风险形态，保留基线突破";
          }
        }
      } else if (id === "vp-stall-exit") {
        if (
          ["up-ma-proxy", "high"].includes(v.location) &&
          last3.length === 3 &&
          last3.every(
            (p, k) =>
              p.reason === null &&
              p.values.change! > 0 &&
              (k === 0 ||
                (p.values.change! < last3[k - 1]!.values.change! &&
                  p.values.volume > last3[k - 1]!.values.volume)),
          ) &&
          v.volume > context.volumeHigh60! &&
          v.high >= v.high20Prior!
        ) {
          exit = true;
          decision = "连续三根量增但正涨幅收敛，放量滞涨退出";
        }
      } else if (id === "vp-high-low-volume-exit") {
        if (
          previousHigh &&
          v.high > previousHigh.high &&
          v.volume < previousHigh.volume
        ) {
          exit = true;
          decision = "价格新高但量低于前高点，缩量新高退出";
        }
      } else if (id === "vp-obv-high") {
        trigger =
          v.location === "up-ma-proxy" &&
          v.close > high! &&
          line[i]! > obvHigh!;
        entry = trigger && !previousTrigger;
        if (entry) decision = "价格与OBV同步创新20根高点";
        if (topDivergence) {
          exit = true;
          decision = "价格新高而OBV未新高，顶背离退出";
        }
      } else if (id === "vp-obv-top-exit") {
        if (topDivergence) {
          exit = true;
          decision = "价格新高而OBV未新高，顶背离退出";
        }
      } else if (id === "vp-obv-flat") {
        trigger = eligible && range10! <= 0.05 && obvUp5;
        entry = trigger && !previousTrigger;
        if (entry) decision = "横盘区间OBV连续5根上行";
        if (range10! <= 0.05 && obvDown5) {
          exit = true;
          decision = "横盘区间OBV连续5根下行";
        }
      } else if (id === "vp-stack-3") {
        trigger = v.location === "up-ma-proxy" && stack3;
        entry = trigger && !previousTrigger;
        if (entry) decision = "连续3根温和递增量与不下降收盘";
      } else {
        const huge = id.startsWith("vp-huge"),
          next = id === "vp-huge-next-exit";
        trigger = huge
          ? v.location === "high" &&
            (v.ratio5! >= 2.5 || v.volume > context.volumeHigh60!) &&
            v.high >= v.high20Prior!
          : id === "vp-obv-bottom"
            ? v.dropFromHigh60! >= 0.2 && bottomDivergence
            : eligible && contract3 && range5! <= 0.05;
        if (candidate) {
          captured = { ...candidate };
          const age = i - candidate.index;
          if (
            age > candidate.wait ||
            (!huge && (v.low < candidate.low || v.location === "high" || exit))
          ) {
            candidate = null;
            decision = "候选过期或失效";
          } else if (huge) {
            const newHigh = v.high > candidate.highest;
            const confirmed = next
              ? age === 1 && v.ratio5! < 0.8 && v.high <= candidate.high
              : newHigh && v.ratio5! < 0.8 && v.volume < candidate.volume;
            if (confirmed) {
              exit = true;
              decision = next
                ? "天量后次根缩量且未创新高"
                : "天量后缩量新高，二顶退出";
              candidate = null;
            } else {
              candidate.advances =
                newHigh && v.ratio5! >= 1.5 ? candidate.advances + 1 : 0;
              candidate.highest = Math.max(candidate.highest, v.high);
              captured = { ...candidate };
              if (candidate.advances >= 2) {
                candidate = null;
                decision = "连续2根放量创新高，原顶部候选证伪";
              }
            }
          } else if (
            v.close > candidate.high &&
            v.ratio5! >= (id === "vp-obv-bottom" ? 1.2 : 1.5)
          ) {
            entry = true;
            decision =
              id === "vp-obv-bottom"
                ? "OBV底背离后收复候选高点"
                : "递减量整理后放量突破";
            ruleStop = {
              price: candidate.low,
              days: 3,
              reason: "量能形态候选低点",
            };
            candidate = null;
          }
          if (candidate && age >= candidate.wait) {
            candidate = null;
            decision = "候选等待期结束";
          }
        }
        if (!candidate && !captured && trigger && !previousTrigger) {
          candidate = {
            highest: v.high,
            advances: 0,
            date: point.date,
            index: i,
            high:
              id === "vp-contract-3"
                ? Math.max(...last5.map((b) => b.high))
                : v.high,
            low:
              id === "vp-contract-3"
                ? Math.min(...last5.map((b) => b.low))
                : v.low,
            close: v.close,
            volume: v.volume,
            wait: next ? 1 : id === "vp-obv-bottom" ? 5 : 10,
          };
          captured = { ...candidate };
          decision = huge
            ? "天量候选，等待后续证实或证伪"
            : "量能形态候选，尚未确认";
        }
      }
      previousTrigger = trigger;
    }
    if (commonExit) decision += "；MA20失守、放量下跌或高位滞涨退出";
    if (exit) {
      entry = false;
      ruleStop = undefined;
    }
    const contextCandidate = captured
      ? {
          highest: captured.highest,
          advances: captured.advances,
          date: captured.date,
          high: captured.high,
          low: captured.low,
          close: captured.close,
          volume: captured.volume,
          wait: captured.wait,
        }
      : null;
    return {
      date: point.date,
      entry,
      exit,
      reason,
      values: v,
      context,
      contextCandidate,
      decision,
      candidate: contextCandidate
        ? {
            date: contextCandidate.date,
            high: contextCandidate.high,
            low: contextCandidate.low,
            close: contextCandidate.close,
            wait: contextCandidate.wait,
          }
        : null,
      ...(ruleStop ? { ruleStop } : {}),
      ...(multiDay ? { multiDay } : {}),
    };
  });
}
