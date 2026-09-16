import type { Bar } from "./domain";
import { ma, volumeMa } from "./indicators";

export const volumeStrategyIds = [
  "vp-up-expanded-confirm",
  "vp-flat-expanded-break",
  "vp-up-contracted-confirm",
  "vp-down-contracted-confirm",
  "vp-up-normal-confirm",
  "vp-flat-contracted-break",
  "vp-breakout-1-5",
  "vp-breakout-2",
  "vp-volume-ma-cross",
] as const;
export type VolumeStrategyId = (typeof volumeStrategyIds)[number];
export function isVolumeStrategy(id: string): id is VolumeStrategyId {
  return (volumeStrategyIds as readonly string[]).includes(id);
}
const descriptions: Record<VolumeStrategyId, [string, string]> = {
  "vp-up-expanded-confirm": [
    "量价 · 趋势放量后确认",
    "均线上涨位置价涨量增后，下一根收盘不低于候选收盘且R≥1确认。",
  ],
  "vp-flat-expanded-break": [
    "量价 · 横盘放量后突破",
    "非高位/下跌位置价平量增后，10根内放量突破候选时近10根高点。",
  ],
  "vp-up-contracted-confirm": [
    "量价 · 缩量上涨后确认",
    "非高位/下跌位置价涨量缩后，5根内温和放量突破候选高点，温和R为1.2至2.5（不含2.5）。不猜测缺失换手率下的控盘。",
  ],
  "vp-down-contracted-confirm": [
    "量价 · 缩量回调后需求回归",
    "均线上涨位置缩量下跌且收盘守住MA20，5根内放量阳线收盘超过候选收盘且不破候选低点。",
  ],
  "vp-up-normal-confirm": [
    "量价 · 价涨量平后走强",
    "均线上涨位置价涨量平后，只等下一根价涨量增并超过候选收盘；原状态不直接买入。",
  ],
  "vp-flat-contracted-break": [
    "量价 · 缩量横盘后突破",
    "非高位/下跌位置价平量缩后，10根内放量突破候选时近10根高点。",
  ],
  "vp-breakout-1-5": [
    "放量突破 · 前20日均量1.5倍",
    "均线上涨位置，首次收盘越过前20根最高价且成交量≥前20个有效成交记录均量1.5倍。",
  ],
  "vp-breakout-2": [
    "放量突破 · 前20日均量2倍",
    "均线上涨位置，首次收盘越过前20根最高价且成交量≥前20个有效成交记录均量2倍。",
  ],
  "vp-volume-ma-cross": [
    "量均线5/10 · 趋势内转强",
    "均线上涨位置VMA5上穿VMA10买入，下穿退出。",
  ],
};
function definition(id: VolumeStrategyId) {
  return {
    label: descriptions[id][0],
    family: "量价",
    signal: "technical" as const,
    version: `${id}-1`,
    description: `${descriptions[id][1]}主板阈值对照：涨跌严格超过±2%，价平在±1%且实体≤1%；R用含当日的5个有效成交记录均量，扩量≥1.5、缩量<0.8。位置为明确的均线/区间代理；未知位置不开仓。收盘失守MA20、放量下跌或高位放量滞涨退出。${id === "vp-volume-ma-cross" ? "" : "确认位入场后3根内失守也退出。"}次日开盘，独立卖出约束及最长持有期有效。`,
    sources: [
      "volume-price-analysis/SKILL.md",
      "volume-price-analysis/references/vp-patterns.md",
      "volume-price-analysis/references/vp-indicators.md",
      "volume-price-analysis/references/vp-astock-caveats.md",
      ...(id.startsWith("vp-breakout")
        ? ["swing-trader/references/technical-indicators.md"]
        : []),
    ],
  };
}
export const volumeStrategies = {
  "vp-up-expanded-confirm": definition("vp-up-expanded-confirm"),
  "vp-flat-expanded-break": definition("vp-flat-expanded-break"),
  "vp-up-contracted-confirm": definition("vp-up-contracted-confirm"),
  "vp-down-contracted-confirm": definition("vp-down-contracted-confirm"),
  "vp-up-normal-confirm": definition("vp-up-normal-confirm"),
  "vp-flat-contracted-break": definition("vp-flat-contracted-break"),
  "vp-breakout-1-5": definition("vp-breakout-1-5"),
  "vp-breakout-2": definition("vp-breakout-2"),
  "vp-volume-ma-cross": definition("vp-volume-ma-cross"),
} satisfies Record<VolumeStrategyId, ReturnType<typeof definition>>;

export function classifyVolumePrice(
  change: number,
  body: number,
  ratio: number,
) {
  if (![change, body, ratio].every(Number.isFinite) || body < 0 || ratio <= 0)
    return null;
  // Preserve unrounded values; ignore only machine-scale cancellation noise
  // at exact percentage boundaries (e.g. 102 / 100 - 1).
  const above = (value: number, boundary: number) =>
    value - boundary >
    Number.EPSILON * 8 * Math.max(1, Math.abs(value), Math.abs(boundary));
  const below = (value: number, boundary: number) => above(boundary, value);
  const atLeast = (boundary: number) => !below(ratio, boundary);
  return {
    price: above(change, 0.02)
      ? "up"
      : below(change, -0.02)
        ? "down"
        : !above(Math.abs(change), 0.01) && !above(body, 0.01)
          ? "flat"
          : "grey",
    volume: atLeast(1.5)
      ? "expanded"
      : below(ratio, 0.8)
        ? "contracted"
        : "normal",
    mainBand: atLeast(2)
      ? "huge"
      : atLeast(1.5)
        ? "expanded"
        : atLeast(0.8)
          ? "normal"
          : atLeast(0.5)
            ? "contracted"
            : "extremely-low",
    detailBand: atLeast(2.5)
      ? "huge"
      : atLeast(1.5)
        ? "expanded"
        : atLeast(1.2)
          ? "mild"
          : atLeast(0.8)
            ? "normal"
            : atLeast(0.5)
              ? "contracted"
              : "extremely-low",
  } as const;
}
export type VolumeLocation =
  | "high"
  | "bottom-proxy"
  | "up-ma-proxy"
  | "down-ma-proxy"
  | "range-proxy"
  | "unknown";
export type VolumeValues = {
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  change: number | null;
  body: number | null;
  vma5: number | null;
  vma10: number | null;
  vma5Prior: number | null;
  vma20Prior: number | null;
  ratio5: number | null;
  ratio20Prior: number | null;
  ma20: number | null;
  ma60: number | null;
  high20Prior: number | null;
  high10: number | null;
  low10: number | null;
  riseFromLow60: number | null;
  dropFromHigh60: number | null;
  range10: number | null;
  location: VolumeLocation;
  grid: ReturnType<typeof classifyVolumePrice>;
  resumptionHold: boolean;
};
// Zero days retains the entry-open guard only. Such profiles implement their
// completed-close invalidation clock in their own causal rule series.
export type RuleStop = { price: number; days: number; reason: string };
export function volumeCommonExit(
  v: VolumeValues,
  previous: VolumeValues | undefined,
) {
  return (
    !!previous &&
    ((v.ma20 != null &&
      previous.ma20 != null &&
      v.close < v.ma20 &&
      previous.close >= previous.ma20) ||
      (v.grid?.price === "down" && v.grid.volume === "expanded") ||
      (v.location === "high" &&
        v.grid?.price === "flat" &&
        v.grid.volume === "expanded"))
  );
}
type Candidate = {
  date: string;
  index: number;
  close: number;
  high: number;
  low: number;
  wait: number;
};
export type VolumePoint = {
  date: string;
  entry: boolean;
  exit: boolean;
  reason: string | null;
  values: VolumeValues;
  candidate: Omit<Candidate, "index"> | null;
  decision: string;
  ruleStop?: RuleStop;
};

export function volumeWarmupStart(bars: readonly Bar[], start: string) {
  const first = bars.findIndex((bar) => bar.date >= start);
  if (first < 0) return start;
  // Include the longest candidate wait (10 bars) and its previous trigger.
  const candidateStart = Math.max(0, first - 11);
  const priceStart = bars[Math.max(0, candidateStart - 60)]?.date ?? start;
  const volumeStart =
    bars
      .slice(0, candidateStart)
      .filter((bar) => bar.volume !== 0)
      .slice(-20)[0]?.date ?? priceStart;
  return volumeStart < priceStart ? volumeStart : priceStart;
}

export function volumeIndicatorInput(bars: readonly Bar[]): Bar[] {
  return bars.map((bar) =>
    bar.volume > 0 && bar.high === bar.low ? { ...bar, volume: NaN } : bar,
  );
}

export function researchVolumeSeries(
  id: VolumeStrategyId,
  bars: readonly Bar[],
): VolumePoint[] {
  if (
    bars.some(
      (bar, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(bar.date) ||
        (i > 0 && bar.date <= bars[i - 1]!.date),
    )
  )
    throw new Error("量价日线日期无效或未递增");
  const priceValid = (bar: Bar | undefined) =>
    !!bar &&
    [bar.open, bar.high, bar.low, bar.close].every(
      (v) => Number.isFinite(v) && v > 0,
    ) &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= Math.min(bar.open, bar.close);
  // A one-price bar has no interpretable supply/demand volume; do not let
  // that sample silently dilute a later volume denominator.
  const volumeInput = volumeIndicatorInput(bars);
  const v5 = volumeMa(volumeInput, 5),
    v10 = volumeMa(volumeInput, 10),
    v5prior = volumeMa(volumeInput, 5, true),
    v20prior = volumeMa(volumeInput, 20, true);
  const m20 = ma(bars, 20),
    m60 = ma(bars, 60);
  let suspensionAge: number | null = null;
  const facts = bars.map((bar, i): VolumeValues => {
    if (bar.volume === 0) suspensionAge = 0;
    else if (suspensionAge !== null && bar.volume > 0) suspensionAge++;
    const previous = bars[i - 1];
    const change =
      priceValid(bar) && priceValid(previous)
        ? bar.close / previous!.close - 1
        : null;
    const body = priceValid(bar) ? Math.abs(bar.close / bar.open - 1) : null;
    const ratio5 =
      v5[i] != null && v5[i]! > 0 && bar.volume > 0
        ? bar.volume / v5[i]!
        : null;
    const ratio20Prior =
      v20prior[i] != null && v20prior[i]! > 0 && bar.volume > 0
        ? bar.volume / v20prior[i]!
        : null;
    const history = bars.slice(Math.max(0, i - 59), i + 1),
      ten = history.slice(-10),
      twenty = bars.slice(Math.max(0, i - 20), i);
    const ready = history.length === 60 && history.every(priceValid);
    const high = ready ? Math.max(...history.map((b) => b.high)) : null,
      low = ready ? Math.min(...history.map((b) => b.low)) : null;
    const high10 = ready ? Math.max(...ten.map((b) => b.high)) : null,
      low10 = ready ? Math.min(...ten.map((b) => b.low)) : null;
    const rise = low != null ? bar.close / low - 1 : null,
      drop = high != null ? 1 - bar.close / high : null;
    const range10 = high10 != null && low10 != null ? high10 / low10 - 1 : null;
    let location: VolumeLocation = "unknown";
    if (ready && m20[i] != null && m60[i] != null && m20[i - 5] != null) {
      if (rise! >= 0.5) location = "high";
      else if (
        drop! >= 0.2 &&
        range10! <= 0.1 &&
        Math.abs(m20[i]! / m20[i - 5]! - 1) <= 0.01
      )
        location = "bottom-proxy";
      else if (
        m20[i]! > m60[i]! &&
        m20[i]! > m20[i - 5]! &&
        bar.close >= m20[i]!
      )
        location = "up-ma-proxy";
      else if (
        m20[i]! < m60[i]! &&
        m20[i]! < m20[i - 5]! &&
        bar.close < m20[i]!
      )
        location = "down-ma-proxy";
      else if (
        high! / low! - 1 <= 0.2 &&
        Math.abs(m20[i]! / m60[i]! - 1) <= 0.03
      )
        location = "range-proxy";
    }
    return {
      close: bar.close,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      volume: bar.volume,
      change,
      body,
      vma5: v5[i] ?? null,
      vma10: v10[i] ?? null,
      vma5Prior: v5prior[i] ?? null,
      vma20Prior: v20prior[i] ?? null,
      ratio5,
      ratio20Prior,
      ma20: m20[i] ?? null,
      ma60: m60[i] ?? null,
      high20Prior:
        twenty.length === 20 && twenty.every(priceValid)
          ? Math.max(...twenty.map((b) => b.high))
          : null,
      high10,
      low10,
      riseFromLow60: rise,
      dropFromHigh60: drop,
      range10,
      location,
      grid:
        change != null && body != null && ratio5 != null
          ? classifyVolumePrice(change, body, ratio5)
          : null,
      resumptionHold: suspensionAge !== null && suspensionAge <= 5,
    };
  });
  let candidate: Candidate | null = null,
    priorTrigger = false;
  return facts.map((v, i) => {
    const bar = bars[i]!,
      p = facts[i - 1];
    const reason =
      !priceValid(bar) ||
      bar.volume <= 0 ||
      !Number.isFinite(bar.volume) ||
      bar.high === bar.low
        ? "当日价格/成交量无效、停牌或一字行情"
        : v.resumptionHold
          ? "复牌后前5个有效成交记录不套常规量价阈值"
          : !p ||
              v.ma60 == null ||
              v.ratio5 == null ||
              v.vma10 == null ||
              v.ratio20Prior == null ||
              v.high10 == null ||
              !v.grid
            ? "量价或位置窗口不足/含无效输入"
            : null;
    if (reason || !p) {
      candidate = null;
      priorTrigger = false;
      return {
        date: bar.date,
        entry: false,
        exit: false,
        reason: reason ?? "缺少前值",
        values: v,
        candidate: null,
        decision: "缺失不触发",
      };
    }
    const up = v.location === "up-ma-proxy",
      eligible = ["up-ma-proxy", "bottom-proxy", "range-proxy"].includes(
        v.location,
      );
    let exit = volumeCommonExit(v, p);
    const commonExit = exit;
    let entry = false,
      decision = "等待",
      ruleStop: RuleStop | undefined;
    let captured: Candidate | null = candidate;
    if (id.startsWith("vp-breakout")) {
      const multiple = id === "vp-breakout-2" ? 2 : 1.5;
      entry =
        up &&
        v.high20Prior != null &&
        p.high20Prior != null &&
        v.close > v.high20Prior &&
        p.close <= p.high20Prior &&
        v.ratio20Prior! >= multiple;
      if (entry) {
        decision = "前20根新高与前20有效成交均量共同确认";
        ruleStop = { price: v.high20Prior!, days: 3, reason: "放量突破位" };
      }
    } else if (id === "vp-volume-ma-cross") {
      entry =
        up &&
        p.vma5 != null &&
        p.vma10 != null &&
        p.vma5 <= p.vma10 &&
        v.vma5! > v.vma10!;
      exit =
        exit ||
        (p.vma5 != null &&
          p.vma10 != null &&
          p.vma5 >= p.vma10 &&
          v.vma5! < v.vma10!);
      if (entry) decision = "有效成交记录VMA5上穿VMA10";
    } else {
      const flat =
        id === "vp-flat-expanded-break" || id === "vp-flat-contracted-break";
      const wait = flat
        ? 10
        : id === "vp-up-contracted-confirm" ||
            id === "vp-down-contracted-confirm"
          ? 5
          : 1;
      const trigger =
        id === "vp-up-expanded-confirm"
          ? up && v.grid!.price === "up" && v.grid!.volume === "expanded"
          : id === "vp-up-normal-confirm"
            ? up && v.grid!.price === "up" && v.grid!.volume === "normal"
            : id === "vp-up-contracted-confirm"
              ? eligible &&
                v.grid!.price === "up" &&
                v.grid!.volume === "contracted"
              : id === "vp-down-contracted-confirm"
                ? up &&
                  v.grid!.price === "down" &&
                  v.grid!.volume === "contracted"
                : eligible &&
                  v.grid!.price === "flat" &&
                  v.grid!.volume ===
                    (id === "vp-flat-expanded-break"
                      ? "expanded"
                      : "contracted");
      if (candidate) {
        const age = i - candidate.index;
        if (
          age > candidate.wait ||
          v.low < candidate.low ||
          !eligible ||
          exit
        ) {
          decision = "候选过期、破位或位置失效";
          candidate = null;
        } else {
          entry =
            id === "vp-up-expanded-confirm"
              ? v.close >= candidate.close && v.ratio5! >= 1
              : id === "vp-up-normal-confirm"
                ? v.grid!.price === "up" &&
                  v.grid!.volume === "expanded" &&
                  v.close > candidate.close
                : id === "vp-up-contracted-confirm"
                  ? v.ratio5! >= 1.2 &&
                    v.ratio5! < 2.5 &&
                    v.close > candidate.high
                  : id === "vp-down-contracted-confirm"
                    ? up &&
                      v.close > v.open &&
                      v.ratio5! >= 1.5 &&
                      v.close > candidate.close
                    : v.ratio5! >= 1.5 && v.close > candidate.high;
          if (entry) {
            decision = "候选后续收盘确认";
            ruleStop = {
              price:
                flat || id === "vp-up-contracted-confirm"
                  ? candidate.high
                  : candidate.low,
              days: 3,
              reason: "量价候选确认位",
            };
            candidate = null;
          } else if (age >= candidate.wait) {
            decision = "候选等待期结束";
            candidate = null;
          }
        }
      }
      if (!candidate && !entry && trigger && !priorTrigger && !exit) {
        candidate = {
          date: bar.date,
          index: i,
          close: v.close,
          high: flat ? v.high10! : v.high,
          low: flat ? v.low10! : v.low,
          wait,
        };
        captured = candidate;
        decision = "候选，尚未确认";
      }
      priorTrigger = trigger;
    }
    if (exit) {
      entry = false;
      ruleStop = undefined;
      decision = commonExit
        ? "MA20失守、放量下跌或高位放量滞涨"
        : "有效成交记录VMA5下穿VMA10";
    }
    return {
      date: bar.date,
      entry,
      exit,
      reason: null,
      values: v,
      candidate: captured
        ? {
            date: captured.date,
            close: captured.close,
            high: captured.high,
            low: captured.low,
            wait: captured.wait,
          }
        : null,
      decision,
      ...(ruleStop ? { ruleStop } : {}),
    };
  });
}
