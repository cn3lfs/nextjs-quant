import type { Bar } from "trading-strategy-core/bars";
import { ma, obv } from "trading-strategy-core/indicators";
import {
  computeRewardMultiple,
  isValidBarRange,
  makeGeometryLine,
  priorVolumeRatio,
} from "./helpers.js";
import type {
  TheoryFamilyScreenerFactory,
  TheoryScreenMatch,
  TheoryScreenerMethodSpec,
} from "./types.js";

const finNum = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const definitions = [
  [
    "f13-greenblatt-magic-formula",
    "F13.13",
    "魔法公式 ROIC+高盈利收益率突破",
    60,
    "高资本回报与高盈利收益率，收盘突破二十日前高。",
  ],
  [
    "f13-piotroski-fscore",
    "F13.12",
    "Piotroski F-Score 财务质量突破",
    60,
    "财务质量评分或多项质量指标达标，收盘突破二十日前高。",
  ],
  [
    "f13-lynch-garp-peg",
    "F13.05",
    "彼得林奇 GARP 合理估值成长",
    60,
    "合理估值成长股收盘突破十五日前高。",
  ],
  [
    "f13-graham-value-shield",
    "F13.01",
    "格雷厄姆安全边际低估值反转",
    60,
    "低估值个股重新站上二十日均线并突破前一日高点。",
  ],
  [
    "f13-quality-momentum-lowvol",
    "F13.14",
    "质量+低波+动量多因子共振",
    65,
    "低波动正动量叠加质量筛选，收盘突破二十日前高。",
  ],
] as const;

export const valueMultifactorSpecs: readonly TheoryScreenerMethodSpec[] =
  definitions.map(([id, theoryId, label, warmupBars, description]) => ({
    id,
    theoryId,
    family: "value-multifactor",
    label,
    direction: "long",
    warmupBars,
    description,
  }));

function priorRange(bars: readonly Bar[], i: number, length: number) {
  let low = Infinity;
  let high = -Infinity;
  for (let j = i - length; j < i; j++) {
    low = Math.min(low, bars[j]!.low);
    high = Math.max(high, bars[j]!.high);
  }
  return { low, high, width: (high - low) / low };
}

function maxDrawdown60(bars: readonly Bar[], i: number) {
  let peak = bars[i - 60]!.close;
  let drawdown = 0;
  for (let j = i - 59; j <= i; j++) {
    const close = bars[j]!.close;
    peak = Math.max(peak, close);
    drawdown = Math.max(drawdown, (peak - close) / peak);
  }
  return drawdown;
}

function hasAccumulationVolume(bars: readonly Bar[], i: number) {
  let upVolume = 0,
    downVolume = 0,
    upDays = 0,
    downDays = 0;
  for (let j = i - 20; j < i; j++) {
    const bar = bars[j]!;
    const previous = bars[j - 1]!.close;
    if (bar.close > previous) {
      upVolume += bar.volume;
      upDays++;
    } else if (bar.close < previous) {
      downVolume += bar.volume;
      downDays++;
    }
  }
  return (
    upDays > 0 && downDays > 0 && upVolume / upDays > downVolume / downDays
  );
}

// Welford sample variance over the 60 returns ending on the previous bar.
function priorVolatility60(bars: readonly Bar[], i: number) {
  let mean = 0;
  let sumSquares = 0;
  for (let j = i - 60; j < i; j++) {
    const dailyReturn = bars[j]!.close / bars[j - 1]!.close - 1;
    const delta = dailyReturn - mean;
    mean += delta / (j - (i - 60) + 1);
    sumSquares += delta * (dailyReturn - mean);
  }
  return Math.sqrt(sumSquares / 59);
}

export const createValueMultifactorFamilyScreener: TheoryFamilyScreenerFactory =
  (context) => {
    const { bars } = context;
    const specs = valueMultifactorSpecs;
    if (bars.length === 0) return { specs, at: () => [] };
    const ma20 = ma(bars, 20);
    const ma60 = ma(bars, 60);
    const volumeBalance = obv(bars);

    return {
      specs,
      at(i) {
        if (!isValidBarRange(bars, i - 60, i)) return [];
        const bar = bars[i]!;
        const prev = bars[i - 1]!;
        const fast = ma20[i]!;
        const slow = ma60[i]!;
        const slowPrevious = ma60[i - 10];
        const range20 = priorRange(bars, i, 20);
        const high15 = priorRange(bars, i, 15).high;
        const breakout20 =
          bar.close > range20.high && prev.close <= range20.high;
        const breakout15 = bar.close > high15 && prev.close <= high15;
        const reversal =
          bar.close > fast &&
          prev.close <= ma20[i - 1]! &&
          bar.close > prev.high;
        if (!breakout15 && !reversal) return [];

        let fin = context.financialsAt
          ? context.financialsAt(i)
          : context.financials;
        if (typeof fin?.availableAt === "string") {
          const day = fin.availableAt.slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > bar.date) fin = null;
        } else if (
          !context.financialsAt &&
          (fin?.availableAt !== undefined || i !== bars.length - 1)
        ) {
          fin = null;
        }
        const pe = finNum(fin?.pe) ?? Infinity;
        const debt = finNum(fin?.debtToAsset);
        const ncav = finNum(fin?.ncavPerShare);
        const return60 = bar.close / bars[i - 60]!.close - 1;
        const volumeRatio = priorVolumeRatio(bars, i);
        const trendStop = Math.min(fast, bar.close * 0.94);
        const matches: TheoryScreenMatch[] = [];
        function emit(
          spec: TheoryScreenerMethodSpec,
          pivotPrice: number,
          lookback: number,
          stopPrice = trendStop,
          multiple = 2.5,
        ) {
          const targetPrice = bar.close + multiple * (bar.close - stopPrice);
          const rewardMultiple = computeRewardMultiple(
            "long",
            bar.close,
            stopPrice,
            targetPrice,
          );
          if (rewardMultiple === null) return;
          matches.push({
            family: spec.family,
            methodId: spec.id,
            theoryId: spec.theoryId,
            label: spec.label,
            direction: "long",
            index: i,
            date: bar.date,
            close: bar.close,
            pivotPrice,
            stopPrice,
            targetPrice,
            rewardMultiple,
            volumeRatio,
            score: 3,
            summary: spec.label + (fin ? "（财务快照）" : "（量价代理）"),
            geometry: {
              lines: [
                makeGeometryLine(bars, "突破确认价", "upper", "solid", [
                  { index: i - lookback, price: pivotPrice },
                  { index: i, price: pivotPrice },
                ]),
              ],
            },
          });
        }

        if (breakout20) {
          const magic = fin
            ? (finNum(fin.roic) ?? finNum(fin.roe) ?? 0) >= 12 &&
              ((finNum(fin.earningsYield) ?? 0) >= 0.04 || (pe > 0 && pe <= 25))
            : return60 >= 0.12 && maxDrawdown60(bars, i) <= 0.16 && fast > slow;
          if (magic) emit(specs[0]!, range20.high, 20);

          const quality = fin
            ? (finNum(fin.fScore) ?? 0) >= 7 ||
              [
                (finNum(fin.roe) ?? 0) >= 10,
                (finNum(fin.operatingCashFlowPerShare) ?? 0) > 0,
                (finNum(fin.grossMargin) ?? 0) >= 20,
                debt !== null && debt <= 60,
                (finNum(fin.currentRatio) ?? 0) >= 1.2,
                (finNum(fin.profitGrowthYoY) ?? 0) > 0,
              ].filter(Boolean).length >= 3
            : slowPrevious != null &&
              slow > slowPrevious &&
              fast > slow &&
              volumeBalance[i] != null &&
              volumeBalance[i - 20] != null &&
              volumeBalance[i]! > volumeBalance[i - 20]! &&
              hasAccumulationVolume(bars, i);
          if (quality) emit(specs[1]!, range20.high, 20);
        }

        if (breakout15) {
          const growth = finNum(fin?.profitGrowthYoY);
          const garp = fin
            ? growth != null &&
              growth >= 15 &&
              growth <= 65 &&
              ((pe > 0 && pe <= growth * 1.2) || (finNum(fin.roe) ?? 0) >= 14)
            : return60 >= 0.12 &&
              return60 <= 0.55 &&
              fast > slow &&
              range20.width <= 0.16;
          if (garp) emit(specs[2]!, high15, 15);
        }

        if (reversal) {
          const pb = finNum(fin?.pb) ?? Infinity;
          const value = fin
            ? (ncav !== null && bar.close <= ncav * 1.25) ||
              (pe > 0 && pe <= 16 && pb > 0 && pb <= 1.8)
            : slowPrevious != null &&
              slow >= slowPrevious * 0.99 &&
              priorRange(bars, i, 40).width <= 0.16;
          if (value)
            emit(
              specs[3]!,
              Math.max(fast, prev.high),
              1,
              Math.min(priorRange(bars, i, 10).low, bar.close * 0.94),
              2.2,
            );
        }

        if (
          breakout20 &&
          i >= specs[4]!.warmupBars &&
          return60 >= 0.1 &&
          fast > slow &&
          (fin?.roe == null || (finNum(fin.roe) ?? 0) >= 10) &&
          (fin?.grossMargin == null || (finNum(fin.grossMargin) ?? 0) >= 18) &&
          Number.isFinite(bars[i - 61]!.close) &&
          bars[i - 61]!.close > 0 &&
          priorVolatility60(bars, i) <= 0.025
        ) {
          emit(specs[4]!, range20.high, 20);
        }
        return matches;
      },
    };
  };
