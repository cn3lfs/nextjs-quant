import type { Bar } from "trading-strategy-core/bars";
import {
  atr,
  confirmedExtrema,
  ma,
  obv,
  type ConfirmedExtremum,
} from "trading-strategy-core/indicators";

/** Causal local research hypotheses. OHLCV price averages never claim real tick VWAP. */
export const theoryAdvancedDefinitions = [
  {
    id: "theory-head-shoulders-bottom",
    theoryId: "F05.04",
    name: "确认头肩底颈线·几何代理",
    family: "突破",
    rule: "3/3确认交替低高低高低，头低于两肩、肩差≤3%，左肩前10根下跌；冻结双高颈线，15根内收盘上穿。",
  },
  {
    id: "theory-falling-wedge",
    theoryId: "F05.08",
    name: "确认下降楔突破·几何代理",
    family: "突破",
    rule: "最近四交替确认摆点的上下线均下降且上界下降更快，全部形成期OHLC在两线±1%内；冻结后10根内收盘上穿，交点后无效。",
  },
  {
    id: "theory-cup-handle",
    theoryId: "F05.09",
    name: "圆底浅柄突破·几何代理",
    family: "突破",
    rule: "3/3确认高低高低，左右沿差≤3%、杯深10%至35%、杯长≥20根；至少20%杯内收盘位于底部30%价格带；首沿前10根上涨，柄回撤≤杯深30%；冻结右沿，15根内上穿。非O'Neil完整法。",
  },
  {
    id: "theory-obv-divergence",
    theoryId: "F08.14",
    name: "确认低点OBV背离突破代理",
    family: "突破",
    rule: "3/3确认低高低且后低价格更低、同端点OBV更高，冻结两低间高点为颈线；15根内收盘突破。成交量背离不等同真实净资金。",
  },
  {
    id: "theory-month-anchor-reclaim",
    theoryId: "F08.18",
    name: "月初日线典型价锚均价回踩代理",
    family: "回调",
    rule: "每月首根重置，从该根累计(H+L+C)/3×V除以累计V；至少5根且MA60较10根前上升，价格从下向上收复锚均价入场。月初是预定机械锚，非事后最低点；日线近似非逐笔AVWAP。",
  },
  {
    id: "theory-rolling-vwap-reclaim",
    theoryId: "F08.17",
    name: "20日典型价量加权均价回踩代理",
    family: "回调",
    rule: "20根sum(((H+L+C)/3)×V)/sum(V)，MA60较10根前上升，收盘从下向上收复均价入场；跨日滚动本地代理，不等同会话重置的VWAP，也不是执行算法。",
  },
] as const;
export type TheoryAdvancedId = (typeof theoryAdvancedDefinitions)[number]["id"];
export const theoryAdvancedIds = theoryAdvancedDefinitions.map((d) => d.id);
export const theoryAdvancedExitRule =
  "只做多不加仓，形态失效低点或回踩两根低点下移信号根0.1×SMA-ATR14后冻结。仅收盘触保护、跌破此前10根低点或持仓40根退出，下一合法机会成交；不假设保护价可成交。";
type Position = { entry: number; entryIndex: number; signalIndex?: number };
type Setup = {
  upper: number;
  stop: number;
  created: number;
  expires: number;
  key: string;
  slope?: number;
  lower?: number;
  lowerSlope?: number;
};
export function createTheoryAdvancedRule(
  strategy: string,
  bars: readonly Bar[],
) {
  const definition = theoryAdvancedDefinitions.find((d) => d.id === strategy);
  if (!definition) return null;
  const pivots = confirmedExtrema(bars).extrema,
    ranges = atr(bars, 14),
    trend = ma(bars, 60),
    volumeLine = obv(bars);
  const signals: (Setup | null)[] = bars.map(() => null),
    seen = new Set<string>(),
    weighted: (number | null)[] = bars.map(() => null);
  const valid = (start: number, end: number) =>
    start >= 0 &&
    bars
      .slice(start, end + 1)
      .every(
        (b) =>
          b.volume > 0 &&
          b.low > 0 &&
          [b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) &&
          b.high >= Math.max(b.open, b.close) &&
          b.low <= Math.min(b.open, b.close),
      );
  let active: Setup | null = null,
    month = "",
    monthStart = 0;
  const line = (a: ConfirmedExtremum, b: ConfirmedExtremum, i: number) =>
    b.price + ((b.price - a.price) / (b.index - a.index)) * (i - b.index);
  const points = (i: number) => {
    const output: ConfirmedExtremum[] = [];
    for (const p of pivots) {
      if (p.index < i - 100 || p.confirmedAt > bars[i]!.date) continue;
      const last = output.at(-1);
      if (last?.kind === p.kind) {
        if (p.kind === "high" ? p.price > last.price : p.price < last.price)
          output[output.length - 1] = p;
      } else output.push(p);
    }
    return output;
  };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.date.slice(0, 7) !== month) {
      month = b.date.slice(0, 7);
      monthStart = i;
    }
    const start =
      definition.id === "theory-month-anchor-reclaim"
        ? monthStart
        : Math.max(0, i - 19);
    if (valid(start, i)) {
      let sum = 0,
        volume = 0;
      for (const row of bars.slice(start, i + 1)) {
        sum += ((row.high + row.low + row.close) / 3) * row.volume;
        volume += row.volume;
      }
      weighted[i] = sum / volume;
    }
    if (i < 70) continue;
    if (!valid(Math.max(0, i - 100), i) || ranges[i] === null) {
      active = null;
      continue;
    }
    if (active) {
      const upper = active.upper + (active.slope ?? 0) * (i - active.created),
        lower =
          (active.lower ?? active.stop) +
          (active.lowerSlope ?? 0) * (i - active.created);
      if (i > active.expires || b.close < active.stop || lower >= upper)
        active = null;
      else if (
        b.close > upper &&
        bars[i - 1]!.close <= upper - (active.slope ?? 0)
      ) {
        signals[i] = { ...active, stop: active.stop - 0.1 * ranges[i]! };
        active = null;
      }
    }
    if (signals[i] || active) continue;
    const ps = points(i),
      last = ps.at(-1);
    let candidate: Setup | null = null;
    const setup = (
      upper: number,
      stop: number,
      key: string,
      age = 15,
      extra: Partial<Setup> = {},
    ): Setup => ({ upper, stop, key, created: i, expires: i + age, ...extra });
    switch (definition.id) {
      case "theory-head-shoulders-bottom": {
        const [a, h1, head, h2, c] = ps.slice(-5);
        if (
          a?.kind === "low" &&
          h1?.kind === "high" &&
          head?.kind === "low" &&
          h2?.kind === "high" &&
          c?.kind === "low" &&
          head.price < Math.min(a.price, c.price) &&
          Math.abs(a.price / c.price - 1) <= 0.03 &&
          a.index >= 10 &&
          bars[a.index]!.close < bars[a.index - 10]!.close
        ) {
          const slope = (h2.price - h1.price) / (h2.index - h1.index);
          candidate = setup(line(h1, h2, i), c.price, `hs:${c.index}`, 15, {
            slope,
          });
        }
        break;
      }
      case "theory-falling-wedge": {
        const shape = ps.slice(-4),
          highs = shape.filter((p) => p.kind === "high"),
          lows = shape.filter((p) => p.kind === "low");
        if (highs.length === 2 && lows.length === 2) {
          const [a, c] = highs as [ConfirmedExtremum, ConfirmedExtremum],
            [d, e] = lows as [ConfirmedExtremum, ConfirmedExtremum],
            hs = (c.price - a.price) / (c.index - a.index),
            ls = (e.price - d.price) / (e.index - d.index),
            upper = line(a, c, i),
            lower = line(d, e, i);
          if (
            hs < ls &&
            ls < 0 &&
            upper > lower &&
            bars
              .slice(shape[0]!.index, i + 1)
              .every(
                (row, j) =>
                  row.high <= line(a, c, shape[0]!.index + j) * 1.01 &&
                  row.low >= line(d, e, shape[0]!.index + j) * 0.99,
              )
          )
            candidate = setup(upper, e.price, `wedge:${last!.index}`, 10, {
              slope: hs,
              lower,
              lowerSlope: ls,
            });
        }
        break;
      }
      case "theory-cup-handle": {
        const [a, bottom, c, handle] = ps.slice(-4);
        if (
          a?.kind === "high" &&
          bottom?.kind === "low" &&
          c?.kind === "high" &&
          handle?.kind === "low" &&
          a.index >= 10 &&
          c.index - a.index >= 20 &&
          bars[a.index]!.close > bars[a.index - 10]!.close
        ) {
          const depth = Math.min(a.price, c.price) - bottom.price,
            window = bars.slice(a.index, c.index + 1);
          if (
            depth / a.price >= 0.1 &&
            depth / a.price <= 0.35 &&
            Math.abs(a.price / c.price - 1) <= 0.03 &&
            handle.price > bottom.price &&
            c.price - handle.price <= depth * 0.3 &&
            window.filter((row) => row.close <= bottom.price + 0.3 * depth)
              .length /
              window.length >=
              0.2
          )
            candidate = setup(c.price, handle.price, `cup:${handle.index}`);
        }
        break;
      }
      case "theory-obv-divergence": {
        const [a, h, c] = ps.slice(-3);
        if (
          a?.kind === "low" &&
          h?.kind === "high" &&
          c?.kind === "low" &&
          c.price < a.price &&
          volumeLine[c.index] !== null &&
          volumeLine[a.index] !== null &&
          volumeLine[c.index]! > volumeLine[a.index]!
        )
          candidate = setup(h.price, c.price, `obv:${c.index}`);
        break;
      }
      case "theory-month-anchor-reclaim":
      case "theory-rolling-vwap-reclaim": {
        const enough =
          definition.id === "theory-month-anchor-reclaim"
            ? i - monthStart >= 4 && bars[i - 1]!.date.slice(0, 7) === month
            : i >= 20;
        if (
          enough &&
          weighted[i] !== null &&
          weighted[i - 1] !== null &&
          trend[i] !== null &&
          trend[i - 10] !== null &&
          trend[i]! > trend[i - 10]! &&
          bars[i - 1]!.close <= weighted[i - 1]! &&
          b.close > weighted[i]!
        ) {
          signals[i] = setup(
            b.close,
            Math.min(b.low, bars[i - 1]!.low) - 0.1 * ranges[i]!,
            `average:${i}`,
          );
        }
        break;
      }
    }
    if (
      candidate &&
      !seen.has(candidate.key) &&
      candidate.stop > 0 &&
      candidate.stop < candidate.upper &&
      b.close <= candidate.upper
    ) {
      seen.add(candidate.key);
      active = candidate;
    }
  }
  return (i: number, position: Position) => {
    const b = bars[i];
    if (!b) return { enter: false, exit: false };
    const held = position.entry > 0 && i >= position.entryIndex,
      origin = signals[position.signalIndex ?? position.entryIndex - 1];
    return {
      enter: !held && signals[i] !== null,
      exit:
        held &&
        ((origin != null && b.close <= origin.stop) ||
          i - position.entryIndex >= 40 ||
          (i >= 10 &&
            b.close <
              Math.min(...bars.slice(i - 10, i).map((row) => row.low)))),
    };
  };
}
