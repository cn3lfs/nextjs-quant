import type { Bar } from "trading-strategy-core/bars";
import {
  atr,
  confirmedExtrema,
  ema,
  ma,
  type ConfirmedExtremum,
} from "trading-strategy-core/indicators";
import {
  causalAlternatingPivots,
  computeRewardMultiple,
  isValidOhlcvBar,
  makeGeometryLine,
  priorVolumeRatio,
} from "./helpers.js";
import type {
  TheoryFamilyScreenerFactory,
  TheoryGeometryLine,
  TheoryScreenMatch,
  TheoryScreenerMethodSpec,
} from "./types.js";

function spec(
  id: string,
  theoryId: string,
  label: string,
  warmupBars: number,
  description: string,
): TheoryScreenerMethodSpec {
  return {
    id,
    theoryId,
    label,
    warmupBars,
    description,
    direction: "long",
    family: "wave-harmonic-smc",
  };
}
const reversal = spec(
  "f05-key-candlestick-reversal",
  "F05.01",
  "关键支撑位 K 线反转组合",
  30,
  "回踩支撑后收盘确认反转。",
);
const continuation = spec(
  "f05-rising-three-continuation",
  "F05.11",
  "上升三法与突破缺口延续",
  30,
  "上涨趋势中突破母线或延续跳空。",
);
const brooks = spec(
  "f05-brooks-h1-h2",
  "F05.12",
  "Al Brooks H1/H2 趋势回调买点",
  35,
  "一段或两段回调后突破前高。",
);
const pnf = spec(
  "f05-pnf-column-break",
  "F05.13",
  "点数图 X 列双顶突破",
  40,
  "三格转向后首次超越前一上升列。",
);
const wave = spec(
  "f06-elliott-wave3-abc",
  "F06.01",
  "波浪三浪主升与 ABC 回调转折",
  50,
  "二浪回撤后收盘突破一浪高点。",
);
const fib = spec(
  "f06-fibonacci-golden-pocket",
  "F06.04",
  "斐波那契黄金分割回撤收复",
  40,
  "主升段回撤后收复分割位。",
);
const harmonic = spec(
  "f06-harmonic-prz",
  "F06.08",
  "五点谐波形态 PRZ 反转",
  55,
  "五点比例结构完成后向上反转。",
);
const smc = spec(
  "f06-smc-ict-ob-fvg",
  "F06.09",
  "SMC/ICT 订单块与 FVG 失衡回踩",
  40,
  "向上突破结构后回踩缺口或订单块。",
);

export const waveHarmonicSmcSpecs: readonly TheoryScreenerMethodSpec[] = [
  reversal,
  continuation,
  brooks,
  pnf,
  wave,
  fib,
  harmonic,
  smc,
];
type Bars = readonly Bar[];
type Point = { index: number; price: number };
const within = (v: number, lo: number, hi: number) => v >= lo && v <= hi;
const high = (bars: Bars) => Math.max(...bars.map((b) => b.high));

function reversalPattern(bars: Bars, i: number) {
  const b = bars[i]!,
    p = bars[i - 1]!,
    a = bars[i - 2]!;
  if (b.close <= p.high) return;
  const body = Math.abs(p.close - p.open);
  if (
    Math.min(p.close, p.open) - p.low >= 2 * Math.max(body, p.close * 0.002) &&
    p.high - Math.max(p.close, p.open) <= 0.25 * (p.high - p.low) &&
    b.low >= p.low
  )
    return { low: p.low, name: "锤头线" };
  const low = Math.min(a.low, p.low, b.low);
  if (
    bars[i - 4]!.close > bars[i - 3]!.close &&
    bars[i - 3]!.close > a.close &&
    a.close < a.open &&
    p.open <= a.close &&
    p.close >= a.open &&
    b.close > a.high
  )
    return { low, name: "看涨吞没" };
  if (
    a.open - a.close >= 0.02 * a.open &&
    body <= 0.01 * p.open &&
    b.close > b.open &&
    b.close > (a.close + a.open) / 2
  )
    return { low, name: "启明星" };
}

function continuationPattern(bars: Bars, i: number) {
  const b = bars[i]!,
    p = bars[i - 1]!,
    a = bars[i - 2]!;
  for (let m = i - 5; m <= i - 3; m++) {
    const mother = bars[m]!;
    if (
      (mother.close - mother.open) / mother.open >= 0.035 &&
      b.close > mother.high &&
      bars
        .slice(m + 1, i)
        .every((r) => r.high <= mother.high * 1.005 && r.low > mother.low)
    )
      return {
        start: m,
        pivot: mother.high,
        stop: mother.low,
        name: "上升三法",
      };
  }
  if (
    p.low > a.high * 1.005 &&
    p.low > high(bars.slice(i - 11, i - 1)) &&
    b.low > a.high &&
    b.close > p.high
  )
    return { start: i - 2, pivot: p.high, stop: a.high, name: "突破缺口" };
}

function pullbackLegs(bars: Bars, i: number, floor: number) {
  let k = i - 1;
  while (k > 0 && bars[k]!.high < bars[k - 1]!.high && bars[k]!.low > floor)
    k--;
  if (k === i - 1) return 0;
  // The last bounce can span several rising highs before the second leg.
  for (let j = k; j >= i - 6; j--) {
    if (bars[j]!.low <= floor || bars[j]!.high <= bars[j - 1]!.high) break;
    if (
      j <= i - 3 &&
      bars[j - 1]!.high < bars[j - 2]!.high &&
      bars[j - 1]!.low > floor
    )
      return 2;
  }
  return within(i - 1 - k, 2, 4) ? 1 : 0;
}

// High/low convention: extend the active column first. A daily bar can reverse
// once only. Integer box coordinates keep exact one-box crossings stable.
function columnBreak(bars: Bars, i: number) {
  const box = Math.max(
    0.01,
    Number((bars[Math.max(0, i - 40)]!.close * 0.015).toFixed(4)),
  );
  const origin = bars[0]!.close;
  let dir = 0,
    top = 0,
    bottom = 0,
    start = 0,
    previousTop: number | undefined;
  for (let j = 1; j <= i; j++) {
    const hi = Math.floor((bars[j]!.high - origin) / box + 1e-9);
    const lo = Math.ceil((bars[j]!.low - origin) / box - 1e-9);
    const oldTop = top,
      oldDir = dir;
    if (dir === 0) {
      if (hi >= 1) {
        dir = 1;
        top = hi;
      } else if (lo <= -1) {
        dir = -1;
        bottom = lo;
      }
    } else if (dir === 1) {
      if (hi > top) top = hi;
      else if (lo <= top - 3) {
        previousTop = top;
        dir = -1;
        bottom = lo;
      }
    } else if (lo < bottom) bottom = lo;
    else if (hi >= bottom + 3) {
      dir = 1;
      bottom++;
      top = hi;
      start = j;
    }
    if (
      j === i &&
      dir === 1 &&
      previousTop !== undefined &&
      top >= previousTop + 1 &&
      (oldDir !== 1 || oldTop <= previousTop)
    )
      return {
        pivot: origin + previousTop * box,
        stop: origin + bottom * box,
        start,
      };
  }
}

function harmonicPoints(pivots: ConfirmedExtremum[], bars: Bars, i: number) {
  const p = bars[i - 1]!;
  const points = [...pivots];
  if (
    points.at(-1)?.kind === "high" &&
    p.low < bars[i - 2]!.low &&
    p.low < bars[i]!.low
  )
    points.push({
      kind: "low",
      index: i - 1,
      price: p.low,
      date: p.date,
      confirmedAt: bars[i]!.date,
    });
  const [x, a, b, c, d] = points.slice(-5);
  if (
    !x ||
    !a ||
    !b ||
    !c ||
    !d ||
    x.kind !== "low" ||
    i - d.index > 5 ||
    a.price <= x.price * 1.08 ||
    c.price <= b.price ||
    c.price > a.price * 1.02 ||
    d.price >= b.price
  )
    return;
  const br = (a.price - b.price) / (a.price - x.price),
    dr = (a.price - d.price) / (a.price - x.price);
  const name =
    within(br, 0.55, 0.68) && within(dr, 0.72, 0.84)
      ? "Gartley"
      : within(br, 0.35, 0.55) && within(dr, 0.83, 0.94)
        ? "Bat"
        : within(br, 0.35, 0.85) && within(dr, 1.2, 1.68)
          ? "蝶形或螃蟹"
          : within(br, 0.35, 0.78) &&
              Math.abs((c.price - d.price) / (a.price - b.price) - 1) <= 0.15
            ? "ABCD"
            : null;
  if (name) return { points: [x, a, b, c, d], c, d, name };
}

function mitigation(bars: Bars, i: number) {
  const p = bars[i - 1]!,
    b = bars[i]!;
  if (b.close <= b.open || b.close <= p.high) return;
  for (let k = i - 3; k >= i - 25; k--) {
    const impulse = bars[k]!;
    if (
      impulse.close <= impulse.open ||
      impulse.close <= high(bars.slice(k - 10, k))
    )
      continue;
    const zones = [];
    if (bars[k - 2]!.high < impulse.low)
      zones.push({
        bottom: bars[k - 2]!.high,
        top: impulse.low,
        name: "公允价值缺口",
      });
    for (let j = k - 1; j >= k - 3; j--) {
      const ob = bars[j]!;
      if (ob.close < ob.open) {
        zones.push({ bottom: ob.low, top: ob.open, name: "看涨订单块" });
        break;
      }
    }
    for (const z of zones)
      if (
        within(p.low, z.bottom * 0.995, z.top * 1.01) &&
        b.close > z.top &&
        bars.slice(k + 1, i + 1).every((r) => r.low >= z.bottom * 0.99)
      )
        return { ...z, k };
  }
}

export const createWaveHarmonicSmcFamilyScreener: TheoryFamilyScreenerFactory =
  ({ bars }) => {
    const specs = waveHarmonicSmcSpecs;
    if (!bars.length) return { specs, at: () => [] };
    const fast = ma(bars, 20),
      slow = ma(bars, 60),
      trend = ema(bars, 20),
      ranges = atr(bars, 14);
    const { extrema } = confirmedExtrema(bars);
    let lastInvalid = -1;
    const validBars = bars.map((bar, index) => {
      if (!isValidOhlcvBar(bar)) lastInvalid = index;
      return index - lastInvalid;
    });
    return {
      specs,
      at(i) {
        const matches: TheoryScreenMatch[] = [];
        if (
          !Number.isInteger(i) ||
          i < 29 ||
          i >= bars.length ||
          validBars[i]! < 21
        )
          return matches;
        const b = bars[i]!,
          p = bars[i - 1]!,
          volumeRatio = priorVolumeRatio(bars, i);
        const end = { index: i, price: b.close };
        const level = (
          kind: TheoryGeometryLine["kind"],
          label: string,
          price: number,
          start: number,
        ) =>
          makeGeometryLine(bars, label, kind, "dashed", [
            { index: start, price },
            { index: i, price },
          ]);
        const outline = (points: Point[]) =>
          makeGeometryLine(bars, "形态轨迹", "outline", "solid", [
            ...points,
            end,
          ]);
        function add(
          method: TheoryScreenerMethodSpec,
          pivot: number,
          stop: number,
          target: number,
          start: number,
          summary: string,
          score = 3,
          lines = [level("neckline", "突破位", pivot, start)],
        ) {
          const rewardMultiple = computeRewardMultiple(
            "long",
            b.close,
            stop,
            target,
          );
          if (
            i + 1 < method.warmupBars ||
            !rewardMultiple ||
            !Number.isFinite(rewardMultiple) ||
            volumeRatio === null ||
            !Number.isFinite(volumeRatio)
          )
            return;
          matches.push({
            family: method.family,
            methodId: method.id,
            theoryId: method.theoryId,
            label: method.label,
            direction: "long",
            index: i,
            date: b.date,
            close: b.close,
            pivotPrice: pivot,
            stopPrice: stop,
            targetPrice: target,
            rewardMultiple,
            volumeRatio,
            score,
            summary,
            geometry: { lines },
          });
        }
        const slowNow = slow[i],
          slowBefore = slow[i - 10];
        if (
          validBars[i]! >= 70 &&
          slowNow != null &&
          slowBefore != null &&
          slowNow >= slowBefore * 0.98
        ) {
          const pattern = reversalPattern(bars, i);
          if (
            pattern &&
            bars.slice(i - 5, i).some((r, offset) => {
              const k = i - 5 + offset;
              const low20 = Math.min(
                ...bars.slice(k - 19, k + 1).map((v) => v.low),
              );
              return [low20, fast[k], slow[k]].some(
                (v) => v != null && within(r.low, v * 0.98, v * 1.02),
              );
            })
          ) {
            const stop = pattern.low * 0.99;
            add(
              reversal,
              p.high,
              stop,
              b.close + 2.5 * (b.close - stop),
              i - 1,
              pattern.name + "在支撑附近获收盘确认",
            );
          }
        }
        if (validBars[i]! >= 60 && slowNow != null && b.close > slowNow) {
          if (fast[i] != null && fast[i]! > slowNow) {
            const setup = continuationPattern(bars, i);
            if (setup)
              add(
                continuation,
                setup.pivot,
                setup.stop,
                b.close + 2 * (b.close - setup.stop),
                setup.start,
                setup.name + "向上延续",
              );
          }
          if (
            trend[i]! > slowNow &&
            trend[i]! > trend[i - 5]! &&
            slow[i - 1] != null &&
            b.close > b.open &&
            b.close > p.high
          ) {
            const legs = pullbackLegs(bars, i, slow[i - 1]!);
            const stop = Math.min(b.low, p.low) - 0.1 * (ranges[i] ?? 0);
            if (legs)
              add(
                brooks,
                p.high,
                stop,
                b.close + 2.5 * (b.close - stop),
                i - 1,
                `H${legs} 回调后突破前高`,
                legs === 2 ? 5 : 3,
              );
          }
        }
        if (validBars[i] === i + 1 && i + 1 >= pnf.warmupBars) {
          const col = columnBreak(bars, i);
          if (col)
            add(
              pnf,
              col.pivot,
              col.stop,
              b.close + 2.5 * (b.close - col.stop),
              col.start,
              "上升列首次高出前顶一格",
            );
        }
        const pivots = causalAlternatingPivots(extrema, bars, i, 110);
        const [l, h, r] = causalAlternatingPivots(extrema, bars, i, 100).slice(
          -3,
        );
        if (
          l &&
          h &&
          r &&
          validBars[i]! > i - l.index &&
          l.kind === "low" &&
          h.price - l.price >= 0.1 * l.price &&
          r.price > l.price &&
          within((h.price - r.price) / (h.price - l.price), 0.3, 0.786) &&
          i - (r.index + 3) <= 20 &&
          b.close > h.price &&
          p.close <= h.price
        ) {
          const target = r.price + 1.618 * (h.price - l.price);
          add(
            wave,
            h.price,
            r.price,
            target,
            l.index,
            "二浪回撤后向上突破一浪高点",
            4,
            [
              outline([l, h, r]),
              level("neckline", "一浪高点", h.price, h.index),
              level("upper", "扩展目标", target, r.index),
            ],
          );
        }
        const fibPivots = causalAlternatingPivots(extrema, bars, i, 80);
        for (let j = fibPivots.length - 1; j > 0; j--) {
          const H = fibPivots[j]!,
            L = fibPivots[j - 1]!,
            D = H.price - L.price;
          if (
            L.index < i - 80 ||
            H.kind !== "high" ||
            H.index >= i - 2 ||
            D < 0.12 * L.price
          )
            continue;
          let idx = H.index + 1;
          for (let k = idx + 1; k <= i; k++)
            if (bars[k]!.low < bars[idx]!.low) idx = k;
          const low = bars[idx]!.low,
            f382 = H.price - 0.382 * D,
            f500 = H.price - 0.5 * D,
            f618 = H.price - 0.618 * D;
          const reclaim = low <= f500 ? f500 : f382,
            target = H.price + 0.272 * D;
          if (
            validBars[i]! > i - L.index &&
            within(low, f618 * 0.99, f382 * 1.01) &&
            low >= H.price - 0.786 * D &&
            p.close <= reclaim &&
            b.close > reclaim &&
            b.close > p.high
          )
            add(
              fib,
              reclaim,
              Math.min(low, f618) * 0.99,
              target,
              L.index,
              "黄金分割回撤后收复关键价位",
              4,
              [
                outline(
                  idx === i ? [L, H] : [L, H, { index: idx, price: low }],
                ),
                level("neckline", "收复位", reclaim, H.index),
                level("lower", "六一八回撤", f618, H.index),
                level("upper", "扩展目标", target, H.index),
              ],
            );
          break;
        }
        if (b.close > b.open && b.close > p.high) {
          const setup = harmonicPoints(pivots, bars, i);
          if (
            setup &&
            validBars[i]! > i - setup.points[0]!.index &&
            b.low >= setup.d.price
          ) {
            const stop = setup.d.price * 0.98;
            add(
              harmonic,
              p.high,
              stop,
              Math.max(
                b.close + 1.5 * (b.close - stop),
                setup.d.price + 0.618 * (setup.c.price - setup.d.price),
              ),
              i - 1,
              setup.name + " 潜在反转区向上确认",
              4,
              [outline(setup.points)],
            );
          }
        }
        if (validBars[i]! >= 36 && i + 1 >= smc.warmupBars) {
          const z = mitigation(bars, i);
          if (z) {
            const stop = z.bottom * 0.985;
            add(
              smc,
              Math.max(p.high, z.top),
              stop,
              Math.max(
                high(bars.slice(z.k, i + 1)),
                b.close + 2 * (b.close - stop),
              ),
              z.k,
              z.name + "回踩后向上确认",
              4,
              [
                level("upper", "区域上沿", z.top, z.k - 2),
                level("lower", "区域下沿", z.bottom, z.k - 2),
              ],
            );
          }
        }
        return matches;
      },
    };
  };
