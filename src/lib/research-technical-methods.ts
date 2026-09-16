import type { Bar } from "./domain";
import { ma, macd, kdj, rsi, boll, volumeMa } from "./indicators";
import { pivotDivergenceSeries } from "./research-pivot-divergence";

// One table per source-named method, not a Cartesian product of parameters.
export const technicalMethodProfiles = {
  "sw-macd-negative": ["SW06-negative-dead", "零轴下死叉退出", "negative", 0],
  "sw-macd-red": ["SW06-red-grow", "红柱连续放大", "growth", 1],
  "sw-macd-green": ["SW06-green-grow", "绿柱连续放大退出", "growth", -1],
  "sw-macd-top": ["SW06-top-divergence", "MACD顶背离+RSI确认", "macd-div", 1],
  "sw-macd-bottom": [
    "SW06-bottom-divergence",
    "MACD底背离+RSI确认",
    "macd-div",
    -1,
  ],
  "sw-macd-double-top": [
    "SW06-double-top-divergence",
    "连续两次MACD顶背离+RSI确认",
    "macd-div",
    2,
  ],
  "sw-macd-double-bottom": [
    "SW06-double-bottom-divergence",
    "连续两次MACD底背离+RSI确认",
    "macd-div",
    -2,
  ],
  "sw-kdj-zone": ["SW07-zone-filter", "KDJ极端区不追价", "kdj-zone", 0],
  "sw-kdj-range": ["SW07-regime-filter", "震荡环境KDJ", "kdj-range", 0],
  "sw-rsi-state": ["SW08-zone-state", "RSI区间状态", "rsi-state", 0],
  "sw-rsi-neutral": ["SW08-neutral-filter", "RSI40至60过滤", "rsi-neutral", 0],
  "sw-rsi-top": ["SW08-top-divergence", "RSI枢轴顶背离", "rsi-div", 1],
  "sw-rsi-bottom": ["SW08-bottom-divergence", "RSI枢轴底背离", "rsi-div", -1],
  "sw-boll-squeeze": [
    "SW09-squeeze-breakout",
    "布林收口放量突破",
    "squeeze",
    0,
  ],
  "sw-boll-expand": ["SW09-expansion", "布林开口顺势", "expand", 0],
  "sw-boll-upper": ["SW09-upper-ride", "连续三根沿上轨", "ride", 1],
  "sw-boll-lower": ["SW09-lower-ride", "连续三根沿下轨退出", "ride", -1],
  "sw-support-20": ["SW10-support-20", "MA20支撑压力互换", "support", 20],
  "sw-support-60": ["SW10-support-60", "MA60支撑压力互换", "support", 60],
  "sw-support-120": ["SW10-support-120", "MA120支撑压力互换", "support", 120],
  "sw-support-250": ["SW10-support-250", "MA250支撑压力互换", "support", 250],
  "sw-volume-up-up": ["SW11-volume-up-up", "放量上涨", "volume", 1],
  "sw-volume-up-down": ["SW11-volume-up-down", "缩量上涨风险", "volume", 2],
  "sw-volume-down-up": ["SW11-volume-down-up", "放量下跌退出", "volume", 3],
  "sw-volume-down-down": [
    "SW11-volume-down-down",
    "缩量下跌后收复",
    "volume",
    4,
  ],
  "sw-volume-top": [
    "SW11-volume-high-volume-divergence",
    "前高点缩量背离",
    "volume-div",
    1,
  ],
  "sw-volume-bottom": [
    "SW11-volume-low-volume-divergence",
    "前低点缩量背离",
    "volume-div",
    -1,
  ],
  "sw-volume-breakout": [
    "SW11-volume-breakout",
    "前20日均量突破分档",
    "breakout",
    0,
  ],
  "sw-intraday-ratio": [
    "SW11-volume-ratio",
    "盘中每分钟量比四档待数据",
    "intraday",
    0,
  ],
  "sw-confluence": ["SW11-confluence-count", "五辅助确认计数", "confluence", 0],
  "sw-direction": [
    "SW11-direction-conflict",
    "MACD均线矛盾等待",
    "direction",
    0,
  ],
  "sw-kdj-size": [
    "SW11-kdj-overbought-size",
    "KDJ超买MACD金叉半仓",
    "kdj-size",
    0,
  ],
  "sw-bear-order": ["SW10-bear-alignment", "四均线空头排列退出", "bear", 0],
  "sw-tangle": ["SW10-tangle-filter", "均线交织观望", "tangle", 0],
} as const;
export type TechnicalMethodId = keyof typeof technicalMethodProfiles;
export const technicalMethodIds = Object.keys(
  technicalMethodProfiles,
) as TechnicalMethodId[];
export function isTechnicalMethod(id: string): id is TechnicalMethodId {
  return Object.hasOwn(technicalMethodProfiles, id);
}
export const technicalEngineeringBoundary =
  "工程v1：日线12/26/9 MACD、9/3/3 KDJ、RSI6、BOLL20/2；背离采严格3/3价格枢轴及对应指标端点，确认日输出，MACD另需同日RSI<50/>50独立确认。红绿柱需连续两次放大；震荡为10根高低幅≤10%且MA20五根变化≤1%；沿轨三根距离≤带宽10%；收口前3根宽度递减且≤10%，放量上穿上轨。均线回踩以前日站上、当日最低触线并收回为确认，反向压力拒绝退出；不加隐含容差。交织为10根内MA5/10至少3次交叉且当前四线距离≤3%，完整空头不归交织。量用前20有效日均量，涨跌严格±2%；底部缩量需次根收复，前高低价量比较不以均量替代。综合为前20根最高价突破的工程基线（不是完整趋势线双突破），放量必须，MACD DIF>DEA、KDJ当日金叉、RSI>50、价>中轨、四均线多头五票，3票全额、2票半额；矛盾禁入，超买金叉半额。空头规则仅退出；信号只在首次成立输出，下一可成交开盘执行，最长持有期有效。";
export function technicalMethodDefinition(id: TechnicalMethodId) {
  return {
    label: technicalMethodProfiles[id][1],
    family: "技术指标",
    signal: "technical" as const,
    version: `${id}-engineering-1`,
    description: technicalEngineeringBoundary,
    sources: ["swing-trader/references/technical-indicators.md"],
  };
}
export type TechnicalMethodFacts = {
  close: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  dif: number;
  dea: number;
  histogram: number;
  k: number;
  d: number;
  strength: number;
  ma5: number;
  ma10: number;
  ma20: number;
  ma60: number;
  support: number;
  middle: number;
  upper: number;
  lower: number;
  ratio: number;
  high20: number;
  low20: number;
  highVolume: number;
  lowVolume: number;
  volume: number;
  range10: number;
  ma20Change: number;
  crossings: number;
  top: boolean;
  bottom: boolean;
  doubleTop: boolean;
  doubleBottom: boolean;
  rsiTop: boolean;
  rsiBottom: boolean;
};
export function technicalRsiState(value: number) {
  return !Number.isFinite(value)
    ? "unknown"
    : value > 70
      ? "overbought"
      : value < 30
        ? "oversold"
        : value > 50 && value < 70
          ? "strong"
          : value > 30 && value < 50
            ? "weak"
            : "boundary";
}
/** An explicit intraday rate, never the daily R ratio. No local historical coverage assumed. */
export function technicalIntradayRatio(
  input:
    | {
        date: string;
        availableDate: string;
        source: string;
        volume: number;
        elapsedMinutes: number;
        prior5DailyVolumes: readonly number[];
        sessionMinutes: number;
        volumeUnit: "share" | "lot100";
      }
    | undefined,
  date: string,
) {
  if (
    date < "2000-01-04" ||
    date > "2022-11-30" ||
    !input ||
    input.date !== date ||
    input.availableDate > date ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.availableDate) ||
    !input.source.trim() ||
    !["share", "lot100"].includes(input.volumeUnit) ||
    !Number.isFinite(input.volume) ||
    input.volume < 0 ||
    !Number.isFinite(input.elapsedMinutes) ||
    input.elapsedMinutes <= 0 ||
    !Number.isFinite(input.sessionMinutes) ||
    input.sessionMinutes <= 0 ||
    input.elapsedMinutes > input.sessionMinutes ||
    input.prior5DailyVolumes.length !== 5 ||
    input.prior5DailyVolumes.some((v) => !Number.isFinite(v) || v <= 0)
  )
    return null;
  const ratio =
    (input.volume * 5 * input.sessionMinutes) /
    (input.elapsedMinutes *
      input.prior5DailyVolumes.reduce((a, b) => a + b, 0));
  if (!Number.isFinite(ratio)) return null;
  return {
    ratio,
    band:
      ratio > 3
        ? "abnormal"
        : ratio >= 1.5
          ? "expanded"
          : ratio >= 0.8
            ? "normal"
            : "contracted",
    projectedVolume:
      (input.volume / input.elapsedMinutes) * input.sessionMinutes,
  };
}
export function technicalConfluence(
  v: TechnicalMethodFacts,
  p: TechnicalMethodFacts,
) {
  const bullish = v.ma5 > v.ma10 && v.ma10 > v.ma20 && v.ma20 > v.ma60;
  const bearish = v.ma5 < v.ma10 && v.ma10 < v.ma20 && v.ma20 < v.ma60;
  const votes = [
    v.dif > v.dea,
    p.k <= p.d && v.k > v.d,
    v.strength > 50,
    v.close > v.middle,
    bullish,
  ];
  const count = votes.filter(Boolean).length;
  const conflict = (v.dif > v.dea && bearish) || (v.dif < v.dea && bullish);
  return {
    votes,
    count,
    conflict,
    fraction:
      v.ratio < 1.5 || conflict || count <= 1 ? 0 : count === 2 ? 0.5 : 1,
  };
}
export function technicalMethodDecision(
  id: TechnicalMethodId,
  rows: readonly TechnicalMethodFacts[],
) {
  const [, , mode, param] = technicalMethodProfiles[id];
  const v = rows.at(-1),
    p = rows.at(-2),
    q = rows.at(-3),
    t = rows.at(-4);
  let entry = false,
    exit = false,
    entryFraction = 1;
  if (!v || !p)
    return { entry, exit, entryFraction, reason: "所需指标尚未可用" };
  const needs: Record<string, (keyof TechnicalMethodFacts)[]> = {
    intraday: ["close", "high20"],
    negative: ["dif", "dea"],
    growth: ["histogram"],
    "macd-div": ["strength"],
    "rsi-div": ["strength"],
    "kdj-zone": ["k", "d"],
    "kdj-range": ["k", "d", "range10", "ma20Change"],
    "rsi-state": ["strength"],
    "rsi-neutral": ["strength"],
    squeeze: ["close", "upper", "lower", "middle", "ratio"],
    expand: ["close", "upper", "lower", "middle"],
    ride: ["close", "upper", "lower"],
    support: ["close", "low", "high", "support"],
    volume: ["close", "previousClose", "ratio"],
    "volume-div": [
      "high",
      "low",
      "high20",
      "low20",
      "volume",
      "highVolume",
      "lowVolume",
    ],
    breakout: ["close", "high20", "ratio"],
    confluence: [
      "close",
      "high20",
      "ratio",
      "dif",
      "dea",
      "k",
      "d",
      "strength",
      "middle",
      "ma5",
      "ma10",
      "ma20",
      "ma60",
    ],
    direction: [
      "dif",
      "dea",
      "ma5",
      "ma10",
      "ma20",
      "ma60",
      "close",
      "high20",
      "ratio",
    ],
    "kdj-size": ["dif", "dea", "k", "ratio"],
    bear: ["ma5", "ma10", "ma20", "ma60"],
    tangle: [
      "ma5",
      "ma10",
      "ma20",
      "ma60",
      "crossings",
      "close",
      "high20",
      "ratio",
    ],
  };
  const neededRows =
    mode === "squeeze" ? 4 : mode === "growth" || mode === "ride" ? 3 : 2;
  if (
    rows.length < neededRows ||
    rows
      .slice(-neededRows)
      .some((r) =>
        needs[mode]!.some(
          (k) => typeof r[k] !== "number" || !Number.isFinite(r[k]),
        ),
      )
  )
    return {
      entry: false,
      exit: false,
      entryFraction,
      reason: "所需指标尚未可用",
    };
  const up = (a: number, b: number, c: number, d: number) => a <= b && c > d;
  const gold = up(p.dif, p.dea, v.dif, v.dea),
    dead = up(p.dea, p.dif, v.dea, v.dif);
  const kg = up(p.k, p.d, v.k, v.d),
    kd = up(p.d, p.k, v.d, v.k);
  const bull = v.ma5 > v.ma10 && v.ma10 > v.ma20 && v.ma20 > v.ma60;
  const bear = v.ma5 < v.ma10 && v.ma10 < v.ma20 && v.ma20 < v.ma60;
  const breakout = v.close > v.high20 && v.ratio >= 1.5;
  const width = (x: TechnicalMethodFacts) => (x.upper - x.lower) / x.middle;
  switch (mode) {
    case "intraday":
      return {
        entry: false,
        exit: false,
        entryFraction,
        reason: "待数据：逐日同分钟累计量、已过交易分钟与前五日全天量",
      };
    case "negative":
      entry = gold;
      exit = dead && v.dif < 0 && v.dea < 0;
      break;
    case "growth":
      entry =
        param === 1
          ? v.histogram > p.histogram &&
            p.histogram > q!.histogram &&
            q!.histogram > 0
          : gold;
      exit =
        param === -1
          ? v.histogram < p.histogram &&
            p.histogram < q!.histogram &&
            q!.histogram < 0
          : dead;
      break;
    case "macd-div":
      entry =
        param < 0 &&
        (param === -2 ? v.doubleBottom : v.bottom) &&
        v.strength > 50;
      exit =
        param > 0 && (param === 2 ? v.doubleTop : v.top) && v.strength < 50;
      if (param > 0) entry = gold;
      break;
    case "rsi-div":
      entry = param < 0 && v.rsiBottom;
      exit = param > 0 && v.rsiTop;
      if (param > 0) entry = up(p.strength, 50, v.strength, 50);
      break;
    case "kdj-zone":
      entry = kg && v.k <= 80;
      exit = kd;
      break;
    case "kdj-range":
      entry = kg && v.range10 <= 0.1 && Math.abs(v.ma20Change) <= 0.01;
      exit = kd;
      break;
    case "rsi-state":
      entry = v.strength < 30;
      exit = v.strength > 70;
      break;
    case "rsi-neutral":
      entry = p.strength <= 60 && v.strength > 60;
      exit = p.strength >= 40 && v.strength < 40;
      break;
    case "squeeze":
      entry =
        width(p) < width(q!) &&
        width(q!) < width(t!) &&
        width(p) <= 0.1 &&
        p.close <= p.upper &&
        v.close > v.upper &&
        v.ratio >= 1.5;
      exit = v.close < v.middle;
      break;
    case "expand":
      entry = width(v) > width(p) && v.close > v.middle && v.middle > p.middle;
      exit = width(v) > width(p) && v.close < v.middle && v.middle < p.middle;
      break;
    case "ride": {
      const along = rows
        .slice(-3)
        .every(
          (x) =>
            x.upper > x.lower &&
            (param === 1
              ? x.close >= x.upper - 0.1 * (x.upper - x.lower)
              : x.close <= x.lower + 0.1 * (x.upper - x.lower)),
        );
      entry = param === 1 ? along : up(p.close, p.middle, v.close, v.middle);
      exit = param === -1 ? along : v.close < v.middle;
      break;
    }
    case "support":
      entry = p.close > p.support && v.low <= v.support && v.close > v.support;
      exit =
        (p.close >= p.support && v.close < v.support) ||
        (p.close < p.support && v.high >= v.support && v.close < v.support);
      break;
    case "volume": {
      entry =
        param === 1
          ? v.close > v.previousClose * 1.02 && v.ratio >= 1.5
          : param === 4
            ? p.close < p.previousClose * 0.98 &&
              p.ratio < 0.8 &&
              v.close > p.high
            : breakout;
      exit =
        param === 2
          ? v.close > v.previousClose * 1.02 && v.ratio < 0.8
          : param === 3
            ? v.close < v.previousClose * 0.98 && v.ratio >= 1.5
            : v.close < v.ma20;
      break;
    }
    case "volume-div":
      entry = param < 0 ? v.low < v.low20 && v.volume < v.lowVolume : breakout;
      exit =
        param > 0
          ? v.high > v.high20 && v.volume < v.highVolume
          : v.close < v.ma20;
      break;
    case "breakout":
      entry = breakout;
      exit = v.close < v.ma20;
      break;
    case "confluence": {
      const c = technicalConfluence(v, p);
      entry = breakout && c.fraction > 0;
      entryFraction = c.fraction;
      exit = v.close < v.ma20;
      break;
    }
    case "direction":
      entry = breakout && !technicalConfluence(v, p).conflict;
      exit = dead;
      break;
    case "kdj-size":
      entry = gold && v.ratio >= 1.5;
      entryFraction = v.k > 80 ? 0.5 : 1;
      exit = dead;
      break;
    case "bear":
      entry = bull;
      exit = bear;
      break;
    case "tangle": {
      const tangled =
        !bear &&
        !bull &&
        v.crossings >= 3 &&
        Math.max(v.ma5, v.ma10, v.ma20, v.ma60) /
          Math.min(v.ma5, v.ma10, v.ma20, v.ma60) -
          1 <=
          0.03;
      entry = breakout && !tangled;
      exit = bear;
      break;
    }
  }
  return { entry, exit, entryFraction, reason: null };
}
export function researchTechnicalMethodSeries(
  id: TechnicalMethodId,
  bars: readonly Bar[],
  intraday: Readonly<
    Record<string, Parameters<typeof technicalIntradayRatio>[0]>
  > = {},
) {
  if (
    bars.some(
      (b, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(b.date) ||
        (i > 0 && b.date <= bars[i - 1]!.date),
    )
  )
    throw new Error("技术方法日期无效或未递增");
  const averages = [5, 10, 20, 60, 120, 250].map((n) => ma(bars, n));
  const momentum = macd(bars),
    stoch = kdj(bars),
    strength = rsi(bars),
    bands = boll(bars),
    volume = volumeMa(bars, 20, true);
  const md = pivotDivergenceSeries(
      bars,
      momentum.map((v) => v.dif),
    ),
    rd = pivotDivergenceSeries(
      bars,
      strength.map((v) => v.rsi6),
    );
  const period =
    technicalMethodProfiles[id][2] === "support"
      ? technicalMethodProfiles[id][3]
      : 20;
  const support = averages[[5, 10, 20, 60, 120, 250].indexOf(period)]!;
  const n = (x: number | null | undefined) => x ?? NaN;
  const facts: TechnicalMethodFacts[] = bars.map((b, i) => {
    const prior = bars.slice(Math.max(0, i - 20), i),
      last10 = bars.slice(Math.max(0, i - 9), i + 1);
    const high =
        prior.length === 20
          ? prior.reduce((a, c) => (c.high >= a.high ? c : a))
          : null,
      low =
        prior.length === 20
          ? prior.reduce((a, c) => (c.low <= a.low ? c : a))
          : null;
    let crossings = 0;
    for (let j = Math.max(1, i - 9); j <= i; j++) {
      const a = averages[0]![j - 1],
        bb = averages[1]![j - 1],
        c = averages[0]![j],
        d = averages[1]![j];
      if (
        a != null &&
        bb != null &&
        c != null &&
        d != null &&
        ((a <= bb && c > d) || (a >= bb && c < d))
      )
        crossings++;
    }
    return {
      close: b.close,
      open: b.open,
      high: b.high,
      low: b.low,
      previousClose: n(bars[i - 1]?.close),
      dif: n(momentum[i]!.dif),
      dea: n(momentum[i]!.dea),
      histogram: n(momentum[i]!.macd),
      k: n(stoch[i]!.k),
      d: n(stoch[i]!.d),
      strength: n(strength[i]!.rsi6),
      ma5: n(averages[0]![i]),
      ma10: n(averages[1]![i]),
      ma20: n(averages[2]![i]),
      ma60: n(averages[3]![i]),
      support: n(support[i]),
      middle: n(bands[i]!.mid),
      upper: n(bands[i]!.upper),
      lower: n(bands[i]!.lower),
      ratio: b.volume / n(volume[i]),
      high20: n(high?.high),
      low20: n(low?.low),
      highVolume: n(high?.volume),
      lowVolume: n(low?.volume),
      volume: b.volume,
      range10:
        last10.length === 10
          ? Math.max(...last10.map((x) => x.high)) /
              Math.min(...last10.map((x) => x.low)) -
            1
          : NaN,
      ma20Change: n(averages[2]![i]) / n(averages[2]![i - 5]) - 1,
      crossings,
      top: md[i]!.top.single,
      bottom: md[i]!.bottom.single,
      doubleTop: md[i]!.top.double,
      doubleBottom: md[i]!.bottom.double,
      rsiTop: rd[i]!.top.single,
      rsiBottom: rd[i]!.bottom.single,
    };
  });
  let previousEntry = false,
    previousExit = false;
  return bars.map((b, i) => {
    const valid = bars
      .slice(Math.max(0, i - 3), i + 1)
      .every(
        (x) =>
          x.volume > 0 &&
          [x.open, x.high, x.low, x.close].every(
            (v) => Number.isFinite(v) && v > 0,
          ) &&
          x.high >= Math.max(x.open, x.close) &&
          x.low <= Math.min(x.open, x.close),
      );
    let decision = valid
      ? technicalMethodDecision(id, facts.slice(Math.max(0, i - 3), i + 1))
      : { entry: false, exit: false, entryFraction: 1, reason: "相邻日线无效" };
    const intradayRatio =
      id === "sw-intraday-ratio"
        ? technicalIntradayRatio(intraday[b.date], b.date)
        : null;
    if (
      id === "sw-intraday-ratio" &&
      valid &&
      intradayRatio &&
      Number.isFinite(facts[i]!.high20)
    )
      decision = {
        entry:
          facts[i]!.close > facts[i]!.high20 &&
          intradayRatio.ratio >= 1.5 &&
          intradayRatio.ratio <= 3,
        exit: intradayRatio.ratio > 3,
        entryFraction: 1,
        reason: null,
      };
    const entry = decision.entry && !previousEntry,
      exit = decision.exit && !previousExit;
    previousEntry = decision.entry;
    previousExit = decision.exit;
    // Evidence is JSON-safe and captures the engineering variant and raw vote count.
    const values = Object.fromEntries(
      Object.entries(facts[i]!).map(([k, v]) => [
        k,
        typeof v === "number" && !Number.isFinite(v) ? null : v,
      ]),
    );
    return {
      date: b.date,
      intradayRatio,
      ...decision,
      entry: entry && !exit,
      exit,
      values,
      method: technicalMethodProfiles[id][0],
      rsiState: technicalRsiState(facts[i]!.strength),
      volumeTier:
        facts[i]!.ratio >= 2
          ? "strong"
          : facts[i]!.ratio >= 1.5
            ? "valid"
            : facts[i]!.ratio < 1
              ? "insufficient"
              : "waiting",
      confluence: technicalConfluence(facts[i]!, facts[i - 1] ?? facts[i]!),
    };
  });
}
