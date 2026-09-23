import type { Bar } from "../../../domain";
import { boll, macd, stdSeries } from "../../../indicators";
import { evaluateFormula } from "../../../formula/tdx-formula";

export const swingMarketProfiles = {
  "sw-market-holiday": ["SW11-calendar", "节前两交易日等待", "holiday"],
  "sw-market-breadth": ["SW11-breadth", "市场涨跌比方向", "breadth"],
  "sw-market-volatility": ["SW11-volatility", "指数波动突增暂停", "volatility"],
  "sw-market-boll": ["SW11-market-boll", "指数布林收口后选择", "boll"],
  "sw-market-neutral3": [
    "SW11-breadth-neutral",
    "三日中性涨跌比等待",
    "neutral",
  ],
  "sw-market-macd": ["SW11-market-macd", "指数MACD方向", "macd"],
  "sw-market-volume": ["SW11-market-volume", "指数放量涨跌方向", "volume"],
  "sw-market-event": ["SW11-event-window", "预告事件前两交易日等待", "event"],
} as const;
export type SwingMarketId = keyof typeof swingMarketProfiles;
export const swingMarketIds = Object.keys(
  swingMarketProfiles,
) as SwingMarketId[];
export function isSwingMarket(id: string): id is SwingMarketId {
  return Object.hasOwn(swingMarketProfiles, id);
}
export const swingMarketBoundary =
  "波段市场组件工程v1：股票MA5/10金叉是统一入场对照，指数或日历仅过滤；MA死叉退出，明确偏空/恐慌退出，缺失和中性不新入但不伪造偏空。广度只用完整历史沪深股票池，平盘停牌从涨跌分子分母排除但保留总数配平；跌家数0为不可定义，>1.5偏多、<0.7偏空，相等为中性；连续3日[0.8,1.2]等待。已知交易所节日/预告重大事件距离1或2交易日禁入，距离必须来自当时已知日历；事件distance=null仅在检索覆盖完整且无预告时有效。指数MACD12/26/9柱正负判向，零为中性；布林20/2前3宽度递减且末宽≤10%，突破上轨偏多/下轨偏空，否则等待，不外推过去方向。指数放量为当日≥前20根均量1.5倍，涨跌严格±2%，其余中性。恐慌工程定义：指数20日收益率样本波动率≥截至前一日60日波动率两倍，历史为零或不足则不可用；正常波动放行。指数同日完整OHLC/量/来源和可得日严格对齐研究日历；不拿单股指标或当前池替代市场。信号收盘确认后下一可成交开盘，最长持有期和T+1有效。";
export function swingMarketDefinition(id: SwingMarketId) {
  return {
    label: swingMarketProfiles[id][1],
    family: "波段市场过滤",
    signal: "technical" as const,
    version: `${id}-engineering-1`,
    sources: ["swing-trader/references/trading-system.md"],
    description: swingMarketBoundary,
  };
}
export type SwingMarketEvidence = {
  date: string;
  availableDate: string;
  source: string;
  index?: Bar;
  breadth?: {
    advancing: number;
    declining: number;
    unchanged: number;
    suspended: number;
    total: number;
    complete: boolean;
    universeDate: string;
    universeSource: string;
  };
  holiday?: {
    distance: number | null;
    complete: boolean;
    calendarSource: string;
  };
  event?: {
    distance: number | null;
    complete: boolean;
    calendarSource: string;
  };
};
type Verdict = {
  allow: boolean;
  exit: boolean;
  reason: string | null;
  state: "bull" | "bear" | "neutral" | "unknown" | "blocked";
};
const unknown = (reason: string): Verdict => ({
  allow: false,
  exit: false,
  reason: `待数据：${reason}`,
  state: "unknown",
});
const state = (s: "bull" | "bear" | "neutral"): Verdict => ({
  allow: s === "bull",
  exit: s === "bear",
  reason: null,
  state: s,
});
export function swingBreadthRatio(
  e: NonNullable<SwingMarketEvidence["breadth"]>,
  date: string,
) {
  const parts = [e.advancing, e.declining, e.unchanged, e.suspended];
  return e.complete &&
    e.universeDate === date &&
    !!e.universeSource.trim() &&
    Number.isSafeInteger(e.total) &&
    e.total > 0 &&
    parts.every((n) => Number.isSafeInteger(n) && n >= 0) &&
    parts.reduce((s, n) => s + n, 0) === e.total &&
    e.declining > 0
    ? e.advancing / e.declining
    : null;
}
export function swingMarketDecision(
  id: SwingMarketId,
  facts: {
    ratio?: number | null;
    ratios?: readonly (number | null)[];
    distance?: number | null;
    calendarComplete?: boolean;
    histogram?: number | null;
    upper?: number | null;
    lower?: number | null;
    close?: number;
    previousClose?: number;
    priorWidths?: readonly (number | null)[];
    volume?: number;
    priorVolume?: number | null;
    volatility20?: number | null;
    volatility60?: number | null;
  },
): Verdict {
  const profile = swingMarketProfiles[id][2],
    f = facts,
    finite = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v);
  if (profile === "holiday" || profile === "event") {
    if (
      !f.calendarComplete ||
      f.distance === undefined ||
      (f.distance !== null &&
        (!Number.isSafeInteger(f.distance) || f.distance < 0))
    )
      return unknown("当时已知完整事件/交易所日历");
    return f.distance === 1 || f.distance === 2
      ? { allow: false, exit: false, reason: null, state: "blocked" }
      : state("bull");
  }
  if (profile === "breadth")
    return !finite(f.ratio)
      ? unknown("历史广度")
      : state(f.ratio > 1.5 ? "bull" : f.ratio < 0.7 ? "bear" : "neutral");
  if (profile === "neutral") {
    if (f.ratios?.length !== 3 || !f.ratios.every(finite))
      return unknown("连续三日历史广度");
    return f.ratios.every((r) => r! >= 0.8 && r! <= 1.2)
      ? { allow: false, exit: false, reason: null, state: "blocked" }
      : state("bull");
  }
  if (profile === "macd")
    return !finite(f.histogram)
      ? unknown("指数MACD")
      : state(f.histogram > 0 ? "bull" : f.histogram < 0 ? "bear" : "neutral");
  if (profile === "volume") {
    if (
      !finite(f.close) ||
      !finite(f.previousClose) ||
      f.previousClose <= 0 ||
      !finite(f.volume) ||
      !finite(f.priorVolume) ||
      f.priorVolume <= 0
    )
      return unknown("指数21根价量");
    const expanded = f.volume >= 1.5 * f.priorVolume;
    return state(
      expanded && f.close > f.previousClose * 1.02
        ? "bull"
        : expanded && f.close < f.previousClose * 0.98
          ? "bear"
          : "neutral",
    );
  }
  if (profile === "volatility") {
    if (
      !finite(f.volatility20) ||
      !finite(f.volatility60) ||
      f.volatility20 < 0 ||
      f.volatility60 <= 0
    )
      return unknown("指数61根收益率及非零历史波动");
    return f.volatility20 >= 2 * f.volatility60 ? state("bear") : state("bull");
  }
  if (
    !finite(f.close) ||
    !finite(f.upper) ||
    !finite(f.lower) ||
    f.priorWidths?.length !== 3 ||
    !f.priorWidths.every(finite)
  )
    return unknown("指数布林收口窗口");
  const [a, b, c] = f.priorWidths as [number, number, number];
  return state(
    a > b && b > c && c <= 0.1
      ? f.close > f.upper
        ? "bull"
        : f.close < f.lower
          ? "bear"
          : "neutral"
      : "neutral",
  );
}
export function researchSwingMarketSeries(
  id: SwingMarketId,
  bars: readonly Bar[],
  evidence: readonly SwingMarketEvidence[] = [],
) {
  const known = (i: number) => {
    const date = bars[i]?.date;
    const rows = evidence.filter((e) => e.date === date);
    const r = rows.length === 1 ? rows[0] : undefined;
    return r &&
      /^\d{4}-\d{2}-\d{2}$/.test(r.availableDate) &&
      r.availableDate <= r.date &&
      r.source.trim()
      ? r
      : undefined;
  };
  const valid = (b: Bar) =>
    Number.isFinite(b.volume) &&
    b.volume > 0 &&
    [b.open, b.high, b.low, b.close].every(
      (v) => Number.isFinite(v) && v > 0,
    ) &&
    b.high >= Math.max(b.open, b.close) &&
    b.low <= Math.min(b.open, b.close);
  const indices = bars.map((b, i) => {
    const v = known(i)?.index;
    return v && v.date === b.date && valid(v)
      ? v
      : { ...b, open: NaN, close: NaN, high: NaN, low: NaN, volume: NaN };
  });
  const baseline = evaluateFormula(
    "ENTRY:CROSS(MA(C,5),MA(C,10));EXIT:CROSS(MA(C,10),MA(C,5));",
    bars.map((b) =>
      valid(b)
        ? b
        : { ...b, open: NaN, close: NaN, high: NaN, low: NaN, volume: NaN },
    ),
  ).outputs;
  const bands = boll(indices),
    momentum = macd(indices),
    returns = indices.map((b, i) =>
      i > 0 &&
      Number.isFinite(b.close) &&
      Number.isFinite(indices[i - 1]!.close)
        ? b.close / indices[i - 1]!.close - 1
        : null,
    );
  const vol20 = stdSeries(returns, 20),
    vol60 = stdSeries(returns, 60);
  const ratio = (i: number) => {
    const e = known(i)?.breadth;
    return e ? swingBreadthRatio(e, bars[i]!.date) : null;
  };
  return bars.map((bar, i) => {
    const row = known(i),
      calendar =
        swingMarketProfiles[id][2] === "holiday" ? row?.holiday : row?.event;
    const prior = indices.slice(Math.max(0, i - 20), i);
    const priorVolume =
      prior.length === 20 && prior.every(valid)
        ? prior.reduce((s, b) => s + b.volume, 0) / 20
        : null;
    const facts = {
      ratio: ratio(i),
      ratios: i >= 2 ? [ratio(i - 2), ratio(i - 1), ratio(i)] : [],
      distance: calendar?.distance,
      calendarComplete: calendar?.complete && !!calendar.calendarSource.trim(),
      histogram: momentum[i]!.macd,
      upper: bands[i]!.upper,
      lower: bands[i]!.lower,
      close: indices[i]!.close,
      previousClose: indices[i - 1]?.close,
      priorWidths: bands
        .slice(Math.max(0, i - 3), i)
        .map((b) =>
          b.upper !== null && b.lower !== null && b.mid !== null && b.mid > 0
            ? (b.upper - b.lower) / b.mid
            : null,
        ),
      volume: indices[i]!.volume,
      priorVolume,
      volatility20: vol20[i] ?? null,
      volatility60: vol60[i - 1] ?? null,
    };
    const profile = swingMarketProfiles[id][2];
    const windowLength =
      profile === "macd"
        ? 26
        : profile === "boll"
          ? 23
          : profile === "volume"
            ? 21
            : profile === "volatility"
              ? 62
              : 0;
    const indexWindow = indices.slice(
      profile === "macd" ? 0 : Math.max(0, i - windowLength + 1),
      i + 1,
    );
    const indexReady =
      !windowLength || (i + 1 >= windowLength && indexWindow.every(valid));
    const decision =
      row && indexReady
        ? swingMarketDecision(id, facts)
        : unknown(
            `${swingMarketProfiles[id][1]}：date/availableDate/source、历史池广度/当时已知日历或连续指数窗口`,
          );
    const exit = valid(bar) && (decision.exit || baseline[1]!.values[i] === 1),
      entry =
        valid(bar) && !exit && decision.allow && baseline[0]!.values[i] === 1;
    const values: Record<string, number | null> = {
      close: Number.isFinite(bar.close) ? bar.close : null,
      marketRatio: facts.ratio,
    };
    return {
      date: bar.date,
      entry,
      exit,
      reason: decision.reason,
      values,
      market: { id, state: decision.state, facts, evidence: row ?? null },
    };
  });
}
