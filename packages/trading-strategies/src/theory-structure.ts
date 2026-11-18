import type { Bar } from "trading-strategy-core/bars";
import {
  atr,
  ma,
  confirmedExtrema,
  type ConfirmedExtremum,
} from "trading-strategy-core/indicators";

/** Mechanical local proxies. Every pivot is usable only after its right-hand confirmation. */
export const theoryStructureDefinitions = [
  {
    id: "theory-swing-breakout",
    theoryId: "F02.09",
    name: "确认HH/HL突破·结构代理",
    family: "突破",
    rule: "严格3/3摆点确认后，最近交替低高低高结构形成更高低点和更高高点，冻结末高与末低，10根内收盘突破末高。",
  },
  {
    id: "theory-trendline-close",
    theoryId: "F02.05",
    name: "下降趋势线突破·结构代理",
    family: "突破",
    rule: "两相继已确认下降高点间隔至少5根，以两点延长线为上界；确认后10根内收盘上穿动态线，保护为其后的已确认低点。",
  },
  {
    id: "theory-double-bottom",
    theoryId: "F05.05",
    name: "双底颈线突破·结构代理",
    family: "突破",
    rule: "交替低高低的两底相差不超过3%，间隔10至60根，中间反弹至少5%，冻结颈线与较低底，15根内收盘越颈线。",
  },
  {
    id: "theory-triangle-close",
    theoryId: "F05.06",
    name: "确认收敛三角·结构代理",
    family: "突破",
    rule: "四个已确认交替摆点中两高降低、两低抬高，投影上下界尚未相交；冻结两条线，10根内收盘越下降上界。",
  },
  {
    id: "theory-flag-close",
    theoryId: "F05.07",
    name: "旗杆整理突破·价格代理",
    family: "突破",
    rule: "此前10根收盘涨幅至少15%，随后10根回撤不超过旗杆一半且振幅不超过10%；冻结整理高低，5根内收盘突破。",
  },
  {
    id: "theory-fib-reclaim",
    theoryId: "F06.04",
    name: "确认段50%回撤收复·比例代理",
    family: "回调",
    rule: "已确认低高段涨幅至少10%；后续低点触及50%回撤±2%段长区域且收盘重回区域上方，冻结该确认根高点，5根内再越高入场。50%是惯例比例，非Fibonacci原数比。",
  },
  {
    id: "theory-darvas-close",
    theoryId: "F09.09",
    name: "逐步封顶封底箱·Darvas代理",
    family: "突破",
    rule: "20根新高后连续3根不创新高封顶，再连续3根不创新低封底；封顶前越顶重启，箱确认后10根内放量1.5倍且C>MA120突破。不是原书箱体精确复现。",
  },
  {
    id: "theory-vcp-close",
    theoryId: "F09.03",
    name: "双收缩枢轴突破·VCP代理",
    family: "突破",
    rule: "已确认交替高低高低的两次回撤，第二回撤≤第一的0.75且第二低点抬高；末回撤量≤此前20根均量0.8倍，末5根宽≤6%；冻结末高低，10根内放量1.5倍突破。",
  },
  {
    id: "theory-stage150",
    theoryId: "F02.08",
    name: "150日阶段转强·日线代理",
    family: "趋势",
    rule: "MA150较20根前上升超过1%，收盘在均线上，前根未同时满足时买；收盘跌破MA150退出。150日是日线代理，不等价已完成30周或完整Weinstein阶段。",
  },
  {
    id: "theory-flat-base",
    theoryId: "F05.10",
    name: "高位35根平底突破·价格代理",
    family: "突破",
    rule: "35根宽度≤12%，收盘≥此前120根最高收盘的90%，MA50>MA120；每5根观察冻结整理边界，5根内放量1.5倍突破。",
  },
] as const;
export type TheoryStructureId =
  (typeof theoryStructureDefinitions)[number]["id"];
export const theoryStructureIds = theoryStructureDefinitions.map((d) => d.id);
export const theoryStructureExitRule =
  "只做多不加仓；形态保护下移信号根0.1×SMA-ATR14并冻结，仅收盘确认退出，成交遵从下一合法机会。不假设保护价成交。结构突破跌破此前10根低点或持40根退出；比例回调在2倍初始风险目标或持20根退出。阶段代理跌MA150或持120根退出。";
type Position = { entry: number; entryIndex: number; signalIndex?: number };
type Setup = {
  upper: number;
  stop: number;
  created: number;
  expires: number;
  key: string;
  upperSlope?: number;
  lowerSlope?: number;
  lower?: number;
  volume?: number;
};

export function createTheoryStructureRule(
  strategy: string,
  bars: readonly Bar[],
) {
  const definition = theoryStructureDefinitions.find((d) => d.id === strategy);
  if (!definition) return null;
  const ranges = atr(bars, 14),
    average = ma(bars, 150),
    fast = ma(bars, 50),
    slow = ma(bars, 120);
  const extrema = confirmedExtrema(bars).extrema;
  const signals: (Setup | null)[] = bars.map(() => null);
  const seen = new Set<string>();
  let active: Setup | null = null;
  let darvas: {
    top: number;
    topAt: number;
    bottom: number;
    bottomAt: number;
    sealed: boolean;
  } | null = null;
  const high = (a: number, b: number) =>
    Math.max(...bars.slice(a, b + 1).map((v) => v.high));
  const low = (a: number, b: number) =>
    Math.min(...bars.slice(a, b + 1).map((v) => v.low));
  const meanVolume = (a: number, b: number) =>
    bars.slice(a, b + 1).reduce((sum, v) => sum + v.volume, 0) / (b - a + 1);
  const pivots = (i: number) => {
    const result: ConfirmedExtremum[] = [];
    for (const p of extrema) {
      if (p.index < i - 100 || p.confirmedAt > bars[i]!.date) continue;
      const previous = result.at(-1);
      if (previous?.kind === p.kind) {
        if (
          p.kind === "high"
            ? p.price > previous.price
            : p.price < previous.price
        )
          result[result.length - 1] = p;
      } else result.push(p);
    }
    return result;
  };
  for (let i = 70; i < bars.length; i++) {
    const b = bars[i]!,
      p = bars[i - 1]!;
    if (
      !bars
        .slice(Math.max(0, i - 170), i + 1)
        .every(
          (v) =>
            v.volume > 0 &&
            v.low > 0 &&
            [v.open, v.high, v.low, v.close, v.volume].every(Number.isFinite) &&
            v.high >= Math.max(v.open, v.close) &&
            v.low <= Math.min(v.open, v.close),
        )
    ) {
      active = null;
      darvas = null;
      continue;
    }
    if (active) {
      const upper =
        active.upper + (active.upperSlope ?? 0) * (i - active.created);
      const lower =
        (active.lower ?? active.stop) +
        (active.lowerSlope ?? 0) * (i - active.created);
      if (i > active.expires || b.close <= active.stop || lower >= upper)
        active = null;
      else if (
        b.close > upper &&
        p.close <= upper - (active.upperSlope ?? 0) &&
        (active.volume === undefined || b.volume >= active.volume)
      ) {
        signals[i] = { ...active, stop: active.stop - 0.1 * ranges[i]! };
        active = null;
      }
    }
    if (signals[i] || active) continue;
    const ps = pivots(i),
      last = ps.at(-1),
      a = ps.at(-4),
      c = ps.at(-2),
      d = ps.at(-3);
    let candidate: Setup | null = null;
    const setup = (
      upper: number,
      stop: number,
      age: number,
      key: string,
      extra: Partial<Setup> = {},
    ) => ({ upper, stop, created: i, expires: i + age, key, ...extra });
    switch (definition.id) {
      case "theory-swing-breakout":
        if (
          a?.kind === "low" &&
          d?.kind === "high" &&
          c?.kind === "low" &&
          last?.kind === "high" &&
          last.price > d.price &&
          c.price > a.price
        )
          candidate = setup(last.price, c.price, 10, `swing:${last.index}`);
        break;
      case "theory-trendline-close": {
        const highs = ps.filter((x) => x.kind === "high"),
          h2 = highs.at(-1),
          h1 = highs.at(-2);
        const l = [...ps]
          .reverse()
          .find((x) => x.kind === "low" && h2 && x.index > h2.index);
        if (h1 && h2 && l && h2.price < h1.price && h2.index - h1.index >= 5) {
          const slope = (h2.price - h1.price) / (h2.index - h1.index);
          candidate = setup(
            h2.price + slope * (i - h2.index),
            l.price,
            10,
            `line:${h2.index}:${l.index}`,
            { upperSlope: slope },
          );
        }
        break;
      }
      case "theory-double-bottom":
        if (
          d?.kind === "low" &&
          c?.kind === "high" &&
          last?.kind === "low" &&
          Math.abs(last.price / d.price - 1) <= 0.03 &&
          last.index - d.index >= 10 &&
          last.index - d.index <= 60 &&
          c.price / Math.max(d.price, last.price) >= 1.05
        )
          candidate = setup(
            c.price,
            Math.min(d.price, last.price),
            15,
            `double:${last.index}`,
          );
        break;
      case "theory-triangle-close": {
        if (!a || !d || !c || !last) break;
        const highs = ps.slice(-4).filter((x) => x.kind === "high"),
          lows = ps.slice(-4).filter((x) => x.kind === "low");
        if (
          highs.length === 2 &&
          lows.length === 2 &&
          highs[1]!.price < highs[0]!.price &&
          lows[1]!.price > lows[0]!.price
        ) {
          const hs =
              (highs[1]!.price - highs[0]!.price) /
              (highs[1]!.index - highs[0]!.index),
            ls =
              (lows[1]!.price - lows[0]!.price) /
              (lows[1]!.index - lows[0]!.index);
          candidate = setup(
            highs[1]!.price + hs * (i - highs[1]!.index),
            lows[1]!.price,
            10,
            `triangle:${last.index}`,
            {
              upperSlope: hs,
              lower: lows[1]!.price + ls * (i - lows[1]!.index),
              lowerSlope: ls,
            },
          );
        }
        break;
      }
      case "theory-flag-close":
        if (
          bars[i - 10]!.close / bars[i - 20]!.close >= 1.15 &&
          (high(i - 9, i) - low(i - 9, i)) / low(i - 9, i) <= 0.1 &&
          low(i - 9, i) >=
            bars[i - 10]!.close -
              0.5 * (bars[i - 10]!.close - bars[i - 20]!.close)
        )
          candidate = setup(high(i - 9, i), low(i - 9, i), 5, `flag:${i}`);
        break;
      case "theory-fib-reclaim": {
        const h = ps.at(-1),
          l = ps.at(-2);
        if (
          h?.kind === "high" &&
          l?.kind === "low" &&
          h.price / l.price >= 1.1 &&
          i > h.index + 3
        ) {
          const width = h.price - l.price,
            middle = h.price - 0.5 * width;
          if (
            b.low <= middle + 0.02 * width &&
            b.low >= middle - 0.02 * width &&
            b.close > middle + 0.02 * width
          )
            candidate = setup(b.high, l.price, 5, `fib:${h.index}`);
        }
        break;
      }
      case "theory-darvas-close": {
        if (darvas && b.high > darvas.top) darvas = null;
        if (!darvas && b.high > high(i - 20, i - 1))
          darvas = {
            top: b.high,
            topAt: i,
            bottom: b.low,
            bottomAt: i,
            sealed: false,
          };
        if (darvas && i - darvas.topAt >= 3) {
          if (!darvas.sealed) {
            darvas.sealed = true;
            darvas.bottom = low(darvas.topAt + 1, i);
            darvas.bottomAt = i;
          } else if (b.low < darvas.bottom) {
            darvas.bottom = b.low;
            darvas.bottomAt = i;
          } else if (
            i - darvas.bottomAt >= 3 &&
            slow[i] != null &&
            b.close > slow[i]!
          )
            candidate = setup(
              darvas.top,
              darvas.bottom,
              10,
              `darvas:${darvas.topAt}`,
              { volume: 1.5 * meanVolume(i - 19, i) },
            );
        }
        break;
      }
      case "theory-vcp-close":
        if (
          a?.kind === "high" &&
          d?.kind === "low" &&
          c?.kind === "high" &&
          last?.kind === "low"
        ) {
          const first = (a.price - d.price) / a.price,
            second = (c.price - last.price) / c.price;
          if (
            first > 0 &&
            second > 0 &&
            second <= first * 0.75 &&
            last.price > d.price &&
            meanVolume(c.index, last.index) <= 0.8 * meanVolume(i - 19, i) &&
            (high(i - 4, i) - low(i - 4, i)) / low(i - 4, i) <= 0.06
          )
            candidate = setup(c.price, last.price, 10, `vcp:${last.index}`, {
              volume: 1.5 * meanVolume(i - 19, i),
            });
        }
        break;
      case "theory-stage150": {
        const current =
          average[i] != null &&
          average[i - 20] != null &&
          b.close > average[i]! &&
          average[i]! / average[i - 20]! > 1.01;
        const previous =
          average[i - 1] != null &&
          average[i - 21] != null &&
          p.close > average[i - 1]! &&
          average[i - 1]! / average[i - 21]! > 1.01;
        if (current && !previous && ranges[i] != null)
          signals[i] = setup(b.close, average[i]!, 120, `stage:${i}`);
        break;
      }
      case "theory-flat-base":
        if (
          i >= 120 &&
          i % 5 === 0 &&
          (high(i - 34, i) - low(i - 34, i)) / low(i - 34, i) <= 0.12 &&
          b.close >=
            Math.max(...bars.slice(i - 119, i + 1).map((x) => x.close)) * 0.9 &&
          fast[i] != null &&
          slow[i] != null &&
          fast[i]! > slow[i]!
        )
          candidate = setup(high(i - 34, i), low(i - 34, i), 5, `flat:${i}`, {
            volume: 1.5 * meanVolume(i - 19, i),
          });
        break;
    }
    if (
      candidate &&
      !seen.has(candidate.key) &&
      candidate.stop > 0 &&
      candidate.upper > candidate.stop &&
      b.close <= candidate.upper
    ) {
      seen.add(candidate.key);
      active = candidate;
    }
  }
  return (i: number, position: Position) => {
    const b = bars[i];
    if (!b) return { enter: false, exit: false };
    const signalIndex = position.signalIndex ?? position.entryIndex - 1;
    const origin = signals[signalIndex];
    const held = position.entry > 0 && i >= position.entryIndex;
    const timed =
      held &&
      i - position.entryIndex >=
        (definition.id === "theory-stage150"
          ? 120
          : definition.id === "theory-fib-reclaim"
            ? 20
            : 40);
    const broken = held && origin != null && b.close <= origin.stop;
    const stageExit =
      definition.id === "theory-stage150" &&
      average[i] != null &&
      b.close < average[i]!;
    const trendExit = i >= 10 && b.close < low(i - 10, i - 1);
    const target =
      held &&
      definition.id === "theory-fib-reclaim" &&
      origin != null &&
      b.close >= position.entry + 2 * (position.entry - origin.stop);
    return {
      enter: !held && signals[i] != null,
      exit:
        held &&
        (timed ||
          broken ||
          target ||
          (definition.id === "theory-stage150" ? stageExit : trendExit)),
    };
  };
}
