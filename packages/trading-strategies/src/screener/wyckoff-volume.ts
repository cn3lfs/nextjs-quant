import type { Bar } from "trading-strategy-core/bars";
import {
  atr,
  confirmedExtrema,
  ma,
  mfi,
  obv,
} from "trading-strategy-core/indicators";
import {
  causalAlternatingPivots,
  clampScore,
  computeRewardMultiple,
  isValidBarRange,
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
  slug: string,
  theoryId: string,
  label: string,
  warmupBars: number,
  description: string,
  direction: "long" | "short" = "long",
): TheoryScreenerMethodSpec {
  return {
    id: "f08-" + slug,
    theoryId,
    label,
    warmupBars,
    description,
    family: "wyckoff-volume",
    direction,
  };
}
const spring = spec(
  "wyckoff-spring-test",
  "F08.06",
  "威科夫 Spring 震仓与测试",
  30,
  "跌破箱底后收复支撑并突破前高",
);
const sos = spec(
  "wyckoff-sos-jac",
  "F08.08",
  "威科夫 SOS 强势跃过小溪",
  35,
  "放量突破吸筹区间上沿",
);
const lps = spec(
  "wyckoff-lps",
  "F08.09",
  "威科夫 LPS 缩量回踩支撑",
  40,
  "突破后缩量回踩原阻力并转强",
);
const utad = spec(
  "wyckoff-utad-sow",
  "F08.07",
  "威科夫 UTAD 上冲失败破位",
  35,
  "上冲失败后跌破支撑",
  "short",
);
const vsa = spec(
  "vsa-no-supply-test",
  "F08.10",
  "VSA 无供给测试与停止量",
  35,
  "确认缩量测试或急跌后的停止量",
);
const divergence = spec(
  "volume-price-divergence",
  "F08.14",
  "OBV/CMF 量价底背离突破",
  45,
  "价格创新低而资金流改善后突破",
);
const profile = spec(
  "volume-profile-poc",
  "F08.16",
  "筹码峰 POC/VAH 突破与回踩",
  60,
  "突破价值区上沿或回踩筹码峰后收复",
);
const anchored = spec(
  "anchored-vwap-reclaim",
  "F08.18",
  "锚定 AVWAP 成本线收复",
  40,
  "收复波段高点或低点锚定的成交量加权均价",
);
export const wyckoffVolumeSpecs: readonly TheoryScreenerMethodSpec[] = [
  spring,
  sos,
  lps,
  utad,
  vsa,
  divergence,
  profile,
  anchored,
];

function bounds(bars: readonly Bar[], start: number, end: number) {
  let top = start,
    bottom = start;
  for (let k = start + 1; k <= end; k++) {
    if (bars[k]!.high > bars[top]!.high) top = k;
    if (bars[k]!.low < bars[bottom]!.low) bottom = k;
  }
  return { top, bottom, high: bars[top]!.high, low: bars[bottom]!.low };
}

const typical = (b: Bar) => (b.high + b.low + b.close) / 3;

function volumeProfile(window: readonly Bar[]) {
  const { high, low } = bounds(window, 0, window.length - 1);
  const step = (high - low) / 20;
  if (step <= 0) return null;
  const bins: number[] = Array(20).fill(0);
  let total = 0;
  for (const b of window) {
    const bin = Math.max(
      0,
      Math.min(19, Math.floor((typical(b) - low) / step)),
    );
    bins[bin] = bins[bin]! + b.volume;
    total += b.volume;
  }
  const poc = bins.indexOf(Math.max(...bins));
  let left = poc,
    right = poc,
    covered = bins[poc]!;
  while (covered < total * 0.7 && (left > 0 || right < 19)) {
    if ((bins[left - 1] ?? -1) >= (bins[right + 1] ?? -1))
      covered += bins[--left]!;
    else covered += bins[++right]!;
  }
  return {
    poc: low + (poc + 0.5) * step,
    val: low + left * step,
    vah: low + (right + 1) * step,
  };
}

function cmf20(bars: readonly Bar[], end: number) {
  if (!isValidBarRange(bars, end - 19, end)) return null;
  let flow = 0,
    volume = 0;
  for (let k = end - 19; k <= end; k++) {
    const b = bars[k]!;
    if (b.high > b.low)
      flow += b.volume * ((2 * b.close - b.low - b.high) / (b.high - b.low));
    volume += b.volume;
  }
  return flow / volume;
}

export const createWyckoffVolumeFamilyScreener: TheoryFamilyScreenerFactory = ({
  bars,
}) => {
  const specs = wyckoffVolumeSpecs;
  if (!bars.length) return { specs, at: () => [] };
  const fast = ma(bars, 20),
    slow = ma(bars, 60),
    spreads = atr(bars, 14);
  const balance = obv(bars),
    money = mfi(bars),
    { extrema } = confirmedExtrema(bars);
  return {
    specs,
    at(i) {
      const matches: TheoryScreenMatch[] = [];
      if (i < 29 || !isValidBarRange(bars, i - 22, i)) return matches;
      const b = bars[i]!,
        prev = bars[i - 1]!,
        earlier = bars[i - 2]!;
      const ratio = priorVolumeRatio(bars, i)!;
      const line = (
        kind: TheoryGeometryLine["kind"],
        label: string,
        price: number,
        start: number,
      ) =>
        makeGeometryLine(bars, label, kind, "solid", [
          { index: start, price },
          { index: i, price },
        ]);
      const rangeLines = (high: number, low: number, start: number) => [
        line("upper", "区间上沿", high, start),
        line("lower", "区间下沿", low, start),
      ];
      function add(
        method: TheoryScreenerMethodSpec,
        pivotPrice: number,
        stopPrice: number,
        targetPrice: number,
        summary: string,
        lines: TheoryGeometryLine[],
      ) {
        const direction = method.direction === "short" ? "short" : "long";
        const rewardMultiple = computeRewardMultiple(
          direction,
          b.close,
          stopPrice,
          targetPrice,
        );
        if (
          i + 1 < method.warmupBars ||
          !rewardMultiple ||
          !Number.isFinite(rewardMultiple) ||
          !Number.isFinite(ratio)
        )
          return;
        matches.push({
          family: method.family,
          methodId: method.id,
          theoryId: method.theoryId,
          label: method.label,
          direction,
          index: i,
          date: b.date,
          close: b.close,
          pivotPrice,
          stopPrice,
          targetPrice,
          rewardMultiple,
          volumeRatio: ratio,
          score: clampScore(
            2 +
              Number(ratio >= 1.35) +
              Number(rewardMultiple >= 2) +
              Number(ratio >= 1.6),
          ),
          summary,
          geometry: { lines },
        });
      }

      const tr = bounds(bars, i - 22, i - 3);
      const isSpring = (s: Bar) =>
        s.low < tr.low && s.low >= tr.low * 0.94 && s.close >= tr.low * 0.995;
      if (
        tr.high - tr.low <= tr.low * 0.2 &&
        b.close > prev.high &&
        b.close > tr.low
      ) {
        const direct = isSpring(prev) && b.low >= prev.low;
        const quietTest =
          (prev.volume < earlier.volume &&
            priorVolumeRatio(bars, i - 1)! < 1) ||
          (b.volume < earlier.volume && ratio < 1);
        const test =
          isSpring(earlier) &&
          Math.min(prev.low, b.low) >= earlier.low &&
          quietTest;
        if (direct || test)
          add(
            spring,
            prev.high,
            (direct ? prev.low : earlier.low) * 0.99,
            tr.high,
            direct ? "震仓后收复箱底并突破前高" : "缩量二次测试守住震仓低点",
            rangeLines(tr.high, tr.low, i - 22),
          );
      }

      if (i >= 34 && isValidBarRange(bars, i - 25, i)) {
        const { high, low } = bounds(bars, i - 25, i - 1);
        const width = (high - low) / low;
        if (
          width >= 0.04 &&
          width <= 0.22 &&
          b.close > b.open &&
          (b.close - b.low) / (b.high - b.low + 1e-9) >= 0.65 &&
          b.close > high &&
          prev.close <= high &&
          ratio >= 1.5
        )
          add(
            sos,
            high,
            Math.max(low, high - 0.5 * (high - low)),
            high + 1.5 * (high - low),
            sos.description,
            rangeLines(high, low, i - 25),
          );
      }

      if (i >= 39 && b.close > b.open && b.close > prev.high) {
        for (let s = i - 2; s >= i - 10; s--) {
          if (!isValidBarRange(bars, s - 20, i)) break;
          const creek = bounds(bars, s - 20, s - 1).high,
            jump = bars[s]!;
          if (
            jump.close <= creek ||
            priorVolumeRatio(bars, s)! < 1.4 ||
            b.low < creek * 0.985
          )
            continue;
          const pullback = bars.slice(s + 1, i);
          if (
            pullback.every((p) => p.low >= creek * 0.985) &&
            pullback.some((_, j) => priorVolumeRatio(bars, s + 1 + j)! < 0.85)
          ) {
            add(
              lps,
              prev.high,
              Math.min(creek * 0.97, b.low, prev.low),
              Math.max(jump.high, b.close) + 2 * (jump.high - creek),
              lps.description,
              [line("neckline", "突破位", creek, s - 20)],
            );
            break;
          }
        }
      }

      const distribution = bounds(bars, i - 22, i - 2);
      if (
        i >= 34 &&
        distribution.high - distribution.low <= distribution.low * 0.25
      ) {
        const failed =
          prev.high > distribution.high &&
          prev.close <= distribution.high &&
          b.close < prev.low &&
          b.close < b.open;
        // Judge each earlier thrust against resistance known before that bar.
        const iceBreak =
          b.close < distribution.low &&
          prev.close >= distribution.low &&
          bars.slice(i - 12, i).some((thrust, j) => {
            const resistance = bounds(bars, i - 22, i - 13 + j).high;
            return thrust.high > resistance && thrust.close <= resistance;
          });
        if (failed || iceBreak)
          add(
            utad,
            failed ? prev.low : distribution.low,
            Math.max(prev.high, distribution.high) * 1.01,
            2 * distribution.low - distribution.high,
            failed ? "上冲失败后跌破前低" : "上冲失败后跌破箱底",
            rangeLines(distribution.high, distribution.low, i - 22),
          );
      }

      const fastNow = fast[i],
        slowNow = slow[i],
        prevRatio = priorVolumeRatio(bars, i - 1)!;
      if (i >= 34 && b.close > prev.high) {
        const noSupply =
          fastNow != null &&
          slowNow != null &&
          fastNow > slowNow &&
          b.close > slowNow &&
          b.close > b.open &&
          prev.close < earlier.close &&
          prev.high - prev.low <= 0.85 * spreads[i - 1]! &&
          prev.volume < Math.min(earlier.volume, bars[i - 3]!.volume) &&
          prevRatio < 0.75;
        const stopping =
          prev.close < 0.93 * bars[i - 6]!.close &&
          prevRatio >= 1.6 &&
          prev.high > prev.low &&
          prev.close >= (prev.high + prev.low) / 2 &&
          Math.min(prev.open, prev.close) - prev.low >=
            (prev.high - prev.low) / 3;
        if (noSupply || stopping) {
          const stop = Math.min(b.low, prev.low);
          add(
            vsa,
            prev.high,
            stop,
            b.close + 2.5 * (b.close - stop),
            noSupply
              ? "缩量窄幅下跌后突破测试高点"
              : "急跌出现停止量后突破前高",
            [line("neckline", "测试高点", prev.high, i - 1)],
          );
        }
      }

      if (i >= 44) {
        const [first, peak, last] = causalAlternatingPivots(
          extrema,
          bars,
          i,
          80,
        ).slice(-3);
        if (
          first?.kind === "low" &&
          peak?.kind === "high" &&
          last?.kind === "low" &&
          last.price < first.price &&
          i - (last.index + 3) <= 15 &&
          isValidBarRange(bars, first.index, i)
        ) {
          const improves = (
            a: number | null | undefined,
            z: number | null | undefined,
          ) => a != null && z != null && z > a;
          const flowUp =
            improves(balance[first.index], balance[last.index]) ||
            (improves(cmf20(bars, first.index), cmf20(bars, last.index)) &&
              improves(money[first.index], money[last.index]));
          const breakout = prev.close <= peak.price && b.close > peak.price;
          const reclaim =
            fastNow != null &&
            fast[i - 1] != null &&
            prev.close <= fast[i - 1]! &&
            b.close > Math.max(fastNow, prev.high) &&
            b.low > last.price;
          if (flowUp && (breakout || reclaim)) {
            const pivot = breakout ? peak.price : Math.max(fastNow!, prev.high);
            add(
              divergence,
              pivot,
              last.price,
              b.close + 2 * (b.close - last.price),
              divergence.description,
              [
                makeGeometryLine(bars, "价格低点", "lower", "solid", [
                  first,
                  last,
                ]),
                line(
                  "neckline",
                  "突破位",
                  pivot,
                  breakout ? peak.index : i - 1,
                ),
              ],
            );
          }
        }
      }

      if (
        i >= 60 &&
        fastNow != null &&
        slowNow != null &&
        fastNow >= slowNow * 0.98 &&
        isValidBarRange(bars, i - 60, i)
      ) {
        const levels = volumeProfile(bars.slice(i - 60, i));
        if (levels) {
          const { poc, val, vah } = levels;
          const breakout = prev.close <= vah && b.close > vah && ratio >= 1.35;
          const reclaim =
            prev.low <= poc * 1.015 &&
            prev.low >= val * 0.98 &&
            prev.close <= prev.open &&
            b.close > Math.max(poc, prev.high) &&
            b.close > b.open;
          if (breakout || reclaim) {
            const stop = Math.min(poc * 0.97, val, b.low);
            add(
              profile,
              breakout ? vah : Math.max(poc, prev.high),
              stop,
              b.close + 2 * (b.close - stop),
              breakout ? "放量突破价值区上沿" : "回踩筹码峰后突破前高",
              [
                line("neckline", "POC", poc, i - 60),
                line("upper", "VAH", vah, i - 60),
                line("lower", "VAL", val, i - 60),
              ],
            );
          }
        }
      }

      if (
        slowNow != null &&
        slow[i - 10] != null &&
        slowNow >= slow[i - 10]! * 0.99 &&
        isValidBarRange(bars, i - 60, i)
      ) {
        const { top, bottom } = bounds(bars, i - 60, i - 5);
        for (const side of ["high", "low"] as const) {
          const start = side === "high" ? top : bottom;
          if (start > i - 8) continue;
          let cost = 0,
            volume = 0;
          const points = [];
          for (let k = start; k <= i; k++) {
            const candle = bars[k]!;
            cost += typical(candle) * candle.volume;
            volume += candle.volume;
            points.push({ index: k, price: cost / volume });
          }
          const before = points.at(-2)!.price,
            now = points.at(-1)!.price;
          const setup =
            side === "high"
              ? prev.close <= before && ratio >= 1.25
              : b.close > slowNow &&
                prev.low <= before * 1.01 &&
                prev.close <= before * 1.005 &&
                b.close > prev.high;
          if (setup && b.close > now) {
            const stop = Math.min(b.low, prev.low, now * 0.97);
            add(
              anchored,
              now,
              stop,
              b.close + 2.5 * (b.close - stop),
              side === "high"
                ? "放量收复高点锚定成本线"
                : "回踩后收复低点锚定成本线",
              [makeGeometryLine(bars, "锚定均价", "neckline", "solid", points)],
            );
            break;
          }
        }
      }
      return matches;
    },
  };
};
