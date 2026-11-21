import {
  confirmedExtrema,
  type ConfirmedExtremum,
} from "trading-strategy-core/indicators";
import type { Bar } from "trading-strategy-core/bars";
import {
  causalAlternatingPivots,
  computeRewardMultiple,
  isValidBarRange,
  isValidOhlcvBar,
  makeGeometryLine,
  meanVolume,
  priorVolumeRatio,
} from "./helpers.js";
import type {
  TheoryFamilyScreenerFactory,
  TheoryGeometryLine,
  TheoryScreenContext,
  TheoryScreenMatch,
  TheoryScreenerMethodSpec,
} from "./types.js";

function spec(
  slug: string,
  theoryId: string,
  label: string,
  warmupBars: number,
  description: string,
): TheoryScreenerMethodSpec {
  return {
    id: "f09-" + slug,
    theoryId,
    family: "growth-oneil",
    label,
    warmupBars,
    description,
    direction: "long",
  };
}
const sepa = spec(
  "sepa-trend-template",
  "F09.02",
  "SEPA 趋势模板突破",
  200,
  "长期均线向上，突破二十日高点",
);
const vcp = spec(
  "vcp-breakout",
  "F09.03",
  "VCP 波动收缩突破",
  60,
  "回撤逐次收窄，右侧缩量后放量突破",
);
const cup = spec(
  "cup-with-handle",
  "F09.04",
  "欧奈尔杯柄突破",
  65,
  "圆底回升后形成上半区缩量杯柄",
);
const doubleBottom = spec(
  "oneil-double-bottom",
  "F09.05",
  "欧奈尔双底突破",
  50,
  "二次探底后放量突破中间峰",
);
const flat = spec(
  "flat-base-on-base",
  "F09.06",
  "欧奈尔平底与底上底突破",
  60,
  "高位窄幅平台突破",
);
const ascending = spec(
  "ascending-base-htf",
  "F09.07",
  "欧奈尔升底与高紧旗突破",
  50,
  "连续升底或急升后旗形整理",
);
const darvas = spec(
  "darvas-box",
  "F09.09",
  "达瓦斯箱体突破",
  40,
  "突破已确认上下界的达瓦斯箱体",
);
const canslim = spec(
  "canslim-composite",
  "F09.01",
  "CANSLIM 成长领涨突破",
  60,
  "放量创新高并满足相对强势条件",
);
export const growthOneilSpecs: readonly TheoryScreenerMethodSpec[] = [
  sepa,
  vcp,
  cup,
  doubleBottom,
  flat,
  ascending,
  darvas,
  canslim,
];

type Point = { index: number; price: number };
function extreme(
  bars: readonly Bar[],
  start: number,
  end: number,
  field: "high" | "low",
): Point {
  let index = start;
  for (let k = start + 1; k <= end; k++)
    if (
      field === "high"
        ? bars[k]!.high > bars[index]!.high
        : bars[k]!.low < bars[index]!.low
    )
      index = k;
  return { index, price: bars[index]![field] };
}
type Box = { top: Point; bottom: Point };
// Store the box available BEFORE each bar, including the bar which breaks it.
function prepareBoxes(bars: readonly Bar[]) {
  const active: (Box | undefined)[] = [];
  let box: Box | undefined;
  let sealed = false;
  let bottomCount = 0;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    if (sealed) active[i] = box;
    if (!isValidOhlcvBar(bar)) {
      box = undefined;
      sealed = false;
      continue;
    }
    if (
      box &&
      (bar.high > box.top.price || (sealed && bar.low < box.bottom.price))
    ) {
      box = undefined;
      sealed = false;
    }
    if (!box) {
      if (
        isValidBarRange(bars, i - 19, i) &&
        bar.high >= extreme(bars, i - 19, i, "high").price
      ) {
        box = {
          top: { index: i, price: bar.high },
          bottom: { index: i, price: bar.low },
        };
        bottomCount = 0;
      }
      continue;
    }
    if (sealed) continue;
    if (bar.low < box.bottom.price) {
      box = { ...box, bottom: { index: i, price: bar.low } };
      bottomCount = 0;
    } else if (i - box.top.index > 3) bottomCount++;
    const width = (box.top.price - box.bottom.price) / box.top.price;
    if (width > 0.22) box = undefined;
    else if (bottomCount >= 3 && width >= 0.03) sealed = true;
  }
  return active;
}

function detect(
  context: TheoryScreenContext,
  i: number,
  extrema: readonly ConfirmedExtremum[],
  box?: Box,
) {
  const { bars } = context;
  const matches: TheoryScreenMatch[] = [];
  const volumeRatio = priorVolumeRatio(bars, i);
  if (i < 39 || volumeRatio === null) return matches;
  const { close, date } = bars[i]!;
  const high = (a: number, b: number) => extreme(bars, a, b, "high");
  const low = (a: number, b: number) => extreme(bars, a, b, "low");
  const ma = (n: number, end = i) => {
    if (!isValidBarRange(bars, end - n + 1, end)) return NaN;
    let sum = 0;
    for (let k = end - n + 1; k <= end; k++) sum += bars[k]!.close;
    return sum / n;
  };
  const range = (a: number, b: number) => isValidBarRange(bars, a, b);
  const breaks = (pivot: number, minVolume = 0) =>
    close > pivot && bars[i - 1]!.close <= pivot && volumeRatio >= minVolume;
  const horizontal = (
    kind: TheoryGeometryLine["kind"],
    label: string,
    start: number,
    price: number,
  ) =>
    makeGeometryLine(bars, label, kind, "solid", [
      { index: start, price },
      { index: i, price },
    ]);
  const outline = (points: Point[], pivot: Point) => [
    makeGeometryLine(bars, "形态轮廓", "outline", "solid", [
      ...points,
      { index: i, price: close },
    ]),
    horizontal("neckline", "突破枢轴", pivot.index, pivot.price),
  ];
  function emit(
    method: TheoryScreenerMethodSpec,
    pivotPrice: number,
    stopPrice: number,
    targetPrice: number,
    lines: TheoryGeometryLine[],
    score = 4,
    summary = method.description,
  ) {
    const rewardMultiple = computeRewardMultiple(
      "long",
      close,
      stopPrice,
      targetPrice,
    );
    if (rewardMultiple === null) return;
    matches.push({
      methodId: method.id,
      theoryId: method.theoryId,
      label: method.label,
      family: "growth-oneil",
      direction: "long",
      index: i,
      date,
      close,
      pivotPrice,
      stopPrice,
      targetPrice,
      rewardMultiple,
      volumeRatio,
      score,
      summary,
      geometry: { lines },
    });
  }
  const ma20 = ma(20),
    ma60 = ma(60);
  if (range(i - 249, i)) {
    const ma50 = ma(50),
      ma150 = ma(150),
      ma200 = ma(200);
    const pivot = high(i - 20, i - 1).price;
    const rps = context.rpsAt?.(i);
    const ranked = rps?.rps50 != null || rps?.rps120 != null;
    if (
      close > ma50 &&
      ma50 > ma150 &&
      ma150 > ma200 &&
      ma200 > ma(200, i - 20) &&
      close >= 1.3 * low(i - 249, i).price &&
      close >= 0.75 * high(i - 249, i).price &&
      (!ranked || Math.max(rps?.rps50 ?? 0, rps?.rps120 ?? 0) >= 70) &&
      breaks(pivot)
    ) {
      const stop = Math.max(ma50, low(i - 20, i - 1).price);
      emit(sepa, pivot, stop, close + 2.5 * (close - stop), [
        horizontal("upper", "20日高点", i - 20, pivot),
        makeGeometryLine(bars, "MA50", "lower", "solid", [
          { index: i - 20, price: ma(50, i - 20) },
          { index: i, price: ma50 },
        ]),
      ]);
    }
  }
  const swings = causalAlternatingPivots(extrema, bars, i - 1, 180);
  // The latest completed pullback can already have a confirmed rebound high.
  const lastLow = swings.at(-1)?.kind === "high" ? swings.slice(0, -1) : swings;
  const [h1, l1, h2, l2] = lastLow.slice(-4);
  if (h1?.kind === "high" && l1 && h2 && l2 && range(h1.index, i)) {
    const first = (h1.price - l1.price) / h1.price,
      second = (h2.price - l2.price) / h2.price;
    const high5 = high(i - 5, i - 1).price,
      low5 = low(i - 5, i - 1).price;
    const pivot = Math.max(h2.price, high5);
    if (
      i >= 59 &&
      first >= 0.08 &&
      first <= 0.38 &&
      second > 0.02 &&
      second <= 0.75 * first &&
      l2.price > l1.price &&
      h2.price >= h1.price * 0.94 &&
      (high5 - low5) / close <= 0.08 &&
      meanVolume(bars, i - 5, i - 1)! <
        0.9 * meanVolume(bars, i - 20, i - 1)! &&
      breaks(pivot, 1.3)
    ) {
      const stop = Math.min(l2.price, low5);
      emit(
        vcp,
        pivot,
        stop,
        close + 2 * Math.max(close - stop, h1.price - l1.price),
        outline([h1, l1, h2, l2], { index: h2.index, price: pivot }),
      );
    }
    const bottom = Math.min(l1.price, l2.price),
      depth = (h1.price - bottom) / h1.price;
    if (
      i >= 49 &&
      h2.price < h1.price * 0.99 &&
      l2.price <= l1.price * 1.015 &&
      l2.price >= l1.price * 0.92 &&
      depth >= 0.1 &&
      depth <= 0.45 &&
      h2.price >= bottom * 1.06 &&
      i - (l2.index + 3) <= 20 &&
      breaks(h2.price, 1.25)
    )
      emit(
        doubleBottom,
        h2.price,
        Math.min(l2.price, h2.price * 0.93),
        2 * h2.price - bottom,
        outline([h1, l1, h2, l2], h2),
      );
  }

  if (i >= 64 && volumeRatio >= 1.3) {
    // Search actual rims, most recent first. The advance must predate the left rim.
    cupSearch: for (let r = i - 4; r >= i - 20; r--) {
      const right = high(r, i - 1);
      if (right.index !== r || !breaks(right.price)) continue;
      for (let k = i - 25; k >= Math.max(15, i - 180); k--) {
        const left = { index: k, price: bars[k]!.high };
        if (
          Math.abs(right.price - left.price) > 0.08 * left.price ||
          left.price < bars[k - 1]!.high ||
          left.price < bars[k + 1]!.high
        )
          continue;
        const start = Math.max(0, k - 40);
        if (!range(start, i) || left.price < 1.15 * low(start, k - 15).price)
          continue;
        const bottom = low(k + 1, r - 1);
        if (
          high(k, bottom.index).price > left.price ||
          high(bottom.index, r).price > right.price
        )
          continue;
        const height = left.price - bottom.price,
          depth = height / left.price;
        if (depth < 0.12 || depth > 0.38) continue;
        let lowerBars = 0;
        for (let j = k; j <= r; j++)
          if (bars[j]!.close <= bottom.price + 0.4 * height) lowerBars++;
        const handle = low(r + 1, i - 1);
        if (
          lowerBars < 0.2 * (r - k + 1) ||
          handle.price <= bottom.price + 0.5 * (right.price - bottom.price) ||
          (right.price - handle.price) / right.price > 0.15 ||
          meanVolume(bars, r + 1, i - 1)! >= meanVolume(bars, k, r)!
        )
          continue;
        emit(
          cup,
          right.price,
          handle.price,
          right.price + height,
          outline([left, bottom, right, handle], right),
        );
        break cupSearch;
      }
    }
  }
  if (i >= 59 && range(i - 59, i)) {
    const top = high(i - 25, i - 1).price,
      bottom = low(i - 25, i - 1).price;
    if (
      (top - bottom) / top <= 0.15 &&
      top >= 0.92 * high(i - 59, i).price &&
      ma20 >= 0.98 * ma60 &&
      breaks(top, 1.35)
    ) {
      let stacked = false;
      for (let start = i - 55; start + 19 <= i - 26; start++) {
        const prev = high(start, start + 19).price;
        if (
          prev >= bottom * 0.94 &&
          prev <= bottom * 1.04 &&
          low(start, start + 19).price >= prev * 0.85
        ) {
          stacked = true;
          break;
        }
      }
      emit(
        flat,
        top,
        bottom,
        top + 2 * (top - bottom),
        [
          horizontal("upper", "平台上沿", i - 25, top),
          horizontal("lower", "平台下沿", i - 25, bottom),
        ],
        stacked ? 5 : 4,
        stacked ? "底上底放量突破" : flat.description,
      );
    }
  }
  if (i >= 49 && volumeRatio >= 1.3) {
    let flag = false;
    for (let k = i - 10; k >= i - 21; k--) {
      const start = Math.max(i - 45, k - 30);
      if (!range(start, i)) continue;
      const top = bars[k]!.high,
        origin = low(start, k - 1),
        floor = low(k + 1, i - 1);
      if (
        top < 1.65 * origin.price ||
        high(k + 1, i - 1).price > top ||
        floor.price < 0.78 * top ||
        !breaks(top)
      )
        continue;
      emit(
        ascending,
        top,
        floor.price,
        close + top - origin.price,
        [
          horizontal("upper", "旗顶", k, top),
          horizontal("lower", "旗底", k + 1, floor.price),
        ],
        4,
        "高紧旗放量突破",
      );
      flag = true;
      break;
    }
    const legs = lastLow.slice(-6);
    if (
      !flag &&
      legs.length === 6 &&
      legs[0]!.kind === "high" &&
      range(legs[0]!.index, i)
    ) {
      const valid = [0, 2, 4].every((k) => {
        const h = legs[k]!.price,
          l = legs[k + 1]!.price;
        return (
          (h - l) / h >= 0.06 &&
          (h - l) / h <= 0.22 &&
          (k === 0 || (h > legs[k - 2]!.price && l > legs[k - 1]!.price))
        );
      });
      const top = legs[4]!,
        floor = legs[5]!.price;
      if (valid && breaks(top.price))
        emit(
          ascending,
          top.price,
          floor,
          close + 2 * (close - floor),
          outline(legs, top),
          4,
          "三次升底放量突破",
        );
    }
  }
  if (box && (i < 59 || close > ma60) && breaks(box.top.price, 1.3))
    emit(
      darvas,
      box.top.price,
      box.bottom.price,
      3 * box.top.price - 2 * box.bottom.price,
      [
        horizontal("upper", "箱顶", box.top.index, box.top.price),
        horizontal("lower", "箱底", box.bottom.index, box.bottom.price),
      ],
    );

  if (i >= 59 && ma20 > ma60) {
    const pivot = high(i - 50, i - 1).price;
    if (breaks(pivot, 1.5)) {
      let leader = false;
      if (context.rpsAt) {
        const r = context.rpsAt(i);
        leader = Math.max(r?.rps50 ?? 0, r?.rps120 ?? 0) >= 80;
      } else if (range(i - 60, i)) {
        const gain = close / bars[i - 60]!.close;
        leader = gain >= 1.2;
        if (leader && context.benchmarkBars) {
          const benchmark = context.benchmarkBars;
          const end = benchmark.findIndex((b) => b.date === date);
          const start = benchmark.findIndex(
            (b) => b.date === bars[i - 60]!.date,
          );
          leader =
            end - start === 60 &&
            isValidBarRange(benchmark, start, end) &&
            gain > benchmark[end]!.close / benchmark[start]!.close;
        }
      }
      if (leader) {
        const financial = context.financialsAt
          ? context.financialsAt(i)
          : context.financials;
        const bonus =
          (financial?.profitGrowthYoY ?? 0) >= 25 ||
          (financial?.roe ?? 0) >= 15;
        emit(
          canslim,
          pivot,
          Math.max(pivot * 0.92, ma20),
          close * 1.25,
          [
            horizontal("upper", "50日高点", i - 50, pivot),
            makeGeometryLine(bars, "20日均线支撑", "lower", "solid", [
              { index: i - 1, price: ma(20, i - 1) },
              { index: i, price: ma20 },
            ]),
          ],
          bonus ? 5 : 4,
          bonus
            ? "领涨放量突破，利润增长或净资产收益率达标"
            : canslim.description,
        );
      }
    }
  }
  return matches;
}

export const createGrowthOneilFamilyScreener: TheoryFamilyScreenerFactory = (
  context,
) => {
  const { extrema } = confirmedExtrema(context.bars);
  const boxes = prepareBoxes(context.bars);
  return {
    specs: growthOneilSpecs,
    at: (i) =>
      Number.isInteger(i) && i >= 0 && i < context.bars.length
        ? detect(context, i, extrema, boxes[i])
        : [],
  };
};
