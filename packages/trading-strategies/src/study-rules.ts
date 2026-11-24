import { createTheoryRangeRule } from "./theory-range.js";
import { createTheoryAdvancedRule } from "./theory-advanced.js";
import { createTheoryStructureRule } from "./theory-structure.js";
import { createClassicRule } from "./classics/index.js";
import { createTheoryDailyRule } from "./theory-daily.js";
import {
  ma,
  ema,
  macd,
  rsi,
  kdj,
  boll,
  atr,
  obv,
  maSeries,
  cci,
  mfi,
  williamsR,
  chaikinMoneyFlow,
  dmi,
  supertrend,
  parabolicSar,
  ichimoku,
} from "trading-strategy-core/indicators";
import { calculateFactor } from "trading-strategy-core/factors";
import type { Bar } from "trading-strategy-core/bars";
import {
  isVolumeStudy,
  isWyckoffExitStudy,
  isWyckoffStudy,
  wyckoffExitStudyBindings,
  wyckoffStudyBindings,
  wyckoffTrendVol10Diagnostic,
  volumeStudyBindings,
  type StudyStrategy,
} from "./study-catalog.js";
import {
  researchWyckoffSeries,
  type WyckoffFacts,
  type WyckoffPoint,
} from "./research/wyckoff/research-wyckoff.js";
import { researchVolumeSeries } from "./research/volume/research-volume.js";
import {
  isLegacySignalStrategy,
  legacySignalSeries,
} from "./research/legacy-signals.js";

type Position = {
  entry: number;
  entryIndex: number;
  signalIndex?: number;
  lastExitIndex?: number;
};
type Rule = (
  index: number,
  position: Position,
) => {
  enter: boolean;
  exit: boolean;
  entryFraction?: number;
  exitFraction?: number;
  reason?: string | null;
};

function frozenCloseProtection(
  bars: readonly Bar[],
  series: readonly {
    entry: boolean;
    exit: boolean;
    reason?: string | null;
    ruleStop?: { price: number; days: number };
  }[],
  firstHoldingBar: 0 | 1,
  protectionReason: string,
): Rule {
  return (index, position) => {
    const row = series[index];
    const entrySignal =
      position.signalIndex === undefined
        ? undefined
        : series[position.signalIndex];
    const stop = entrySignal?.ruleStop;
    const holdingBar = index - position.entryIndex;
    const close = bars[index]?.close;
    const lostLevel =
      position.entry > 0 &&
      stop !== undefined &&
      holdingBar >= firstHoldingBar &&
      holdingBar < firstHoldingBar + stop.days &&
      close !== undefined &&
      close > 0 &&
      close < stop.price;
    return {
      enter: row?.entry ?? false,
      exit: (row?.exit ?? false) || lostLevel,
      reason: lostLevel ? protectionReason : (row?.reason ?? null),
    };
  };
}

export function wyckoffTrendNextDayConditions(
  candidate: Pick<WyckoffFacts, "low" | "high" | "meanVolume">,
  nextBar: Bar,
  nextPoint: Pick<WyckoffPoint, "reason">,
) {
  return {
    holdCandidateLow: nextBar.low >= candidate.low,
    closeAboveCandidateHigh: nextBar.close > candidate.high,
    volumeGe15xMean20: nextBar.volume >= candidate.meanVolume * 1.5,
    volumeGe10xMean20: nextBar.volume >= candidate.meanVolume,
    validNextBarNoReason: !nextPoint.reason,
  };
}

function trendVol10Series(bars: readonly Bar[]) {
  const series = researchWyckoffSeries("wy-trend-pullback-daily", bars);
  return series.map((row, index) => {
    const candidate = series[index - 1]?.events.find(
      (event) => event.kind === "trend" && event.state === "candidate",
    );
    if (!candidate || row.ruleStop) return row;
    const checks = wyckoffTrendNextDayConditions(
      candidate.facts,
      bars[index]!,
      row,
    );
    if (
      !checks.holdCandidateLow ||
      !checks.closeAboveCandidateHigh ||
      !checks.validNextBarNoReason ||
      !checks.volumeGe10xMean20
    )
      return row;
    return {
      ...row,
      entry: !row.exit,
      ruleStop: {
        price: candidate.facts.low,
        days: 3,
        reason: "威科夫冻结候选低点",
      },
    };
  });
}

/** Signals see completed, causally normalized prices only. Execution stays in the study runner. */
export function createExtendedStudyRule(
  strategy: StudyStrategy,
  bars: readonly Bar[],
): Rule | null {
  if (isVolumeStudy(strategy))
    return frozenCloseProtection(
      bars,
      researchVolumeSeries(volumeStudyBindings[strategy], bars),
      0,
      "入场确认位前三根内收盘失守",
    );
  if (isWyckoffStudy(strategy))
    return frozenCloseProtection(
      bars,
      researchWyckoffSeries(wyckoffStudyBindings[strategy], bars),
      1,
      "威科夫冻结低点收盘失守",
    );
  if (isWyckoffExitStudy(strategy)) {
    // These JAC controls have a zero-day close guard and use their own exit events.
    const series = researchWyckoffSeries(
      wyckoffExitStudyBindings[strategy],
      bars,
    );
    return (index) => {
      const row = series[index];
      if (strategy === "research-wy-sow-lpsy") {
        const fullExit = row?.events.find(
          (event) =>
            event.state === "confirmed" &&
            (event.kind === "ut" || event.kind === "ice"),
        );
        if (fullExit)
          return {
            enter: false,
            exit: true,
            reason: fullExit.kind === "ut" ? "UT 确认全平" : "破冰确认全平",
          };
      }
      const reduction = row?.exit ? undefined : row?.reduction;
      return {
        enter: row?.entry ?? false,
        exit: (row?.exit ?? false) || Boolean(reduction),
        ...(reduction && { exitFraction: reduction.fraction }),
        reason: row?.reason ?? reduction?.reason ?? null,
      };
    };
  }
  if (strategy === wyckoffTrendVol10Diagnostic)
    return frozenCloseProtection(
      bars,
      trendVol10Series(bars),
      1,
      "威科夫冻结低点收盘失守",
    );
  if (isLegacySignalStrategy(strategy)) {
    const series = legacySignalSeries(strategy, bars);
    return (index, position) => {
      const row = series[index];
      return {
        enter: row?.entry ?? false,
        exit:
          (row?.exit ?? false) ||
          (strategy === "research-growth" &&
            position.entry > 0 &&
            index - position.entryIndex >= 5),
        entryFraction: row && "entryFraction" in row ? row.entryFraction : 1,
        reason: row?.reason ?? null,
      };
    };
  }
  const rangeRule = createTheoryRangeRule(strategy, bars);
  if (rangeRule) return rangeRule;
  const theoryRule = createTheoryDailyRule(strategy, bars);
  if (theoryRule) return theoryRule;
  const structureRule = createTheoryStructureRule(strategy, bars);
  if (structureRule) return structureRule;
  const advancedRule = createTheoryAdvancedRule(strategy, bars);
  if (advancedRule) return advancedRule;
  const classicRule = createClassicRule(strategy, bars);
  if (classicRule) return classicRule;
  const closes = bars.map((b) => b.close);
  const high = (i: number, n: number) =>
    Math.max(...bars.slice(i - n, i).map((b) => b.high));
  const low = (i: number, n: number) =>
    Math.min(...bars.slice(i - n, i).map((b) => b.low));
  const timedRiskExit = (i: number, p: Position, days = 20) =>
    i - p.entryIndex >= days || closes[i]! < p.entry * 0.92;
  switch (strategy) {
    case "sma200": {
      const average = ma(bars, 200);
      return (i) => ({
        enter: closes[i]! > average[i]!,
        exit: closes[i]! < average[i]!,
      });
    }
    case "golden-cross":
    case "ema-cross": {
      const fast = strategy === "ema-cross" ? ema(bars, 12) : ma(bars, 50);
      const slow = strategy === "ema-cross" ? ema(bars, 26) : ma(bars, 200);
      return (i) => ({ enter: fast[i]! > slow[i]!, exit: fast[i]! < slow[i]! });
    }
    case "triple-ma": {
      const fast = ma(bars, 20),
        mid = ma(bars, 60),
        slow = ma(bars, 120);
      return (i) => ({
        enter: fast[i]! > mid[i]! && mid[i]! > slow[i]!,
        exit: fast[i]! < mid[i]! || closes[i]! < slow[i]!,
      });
    }
    case "macd": {
      const line = macd(bars);
      return (i) => ({
        enter: line[i]!.dif! > line[i]!.dea! && line[i]!.dif! > 0,
        exit: line[i]!.dif! < line[i]!.dea!,
      });
    }
    case "dmi": {
      const line = dmi(bars);
      return (i) => ({
        enter:
          line[i]!.adx !== null &&
          line[i]!.adx! > 25 &&
          line[i]!.plus! > line[i]!.minus!,
        exit:
          line[i]!.plus! < line[i]!.minus! ||
          (line[i]!.adx !== null && line[i]!.adx! < 20),
      });
    }
    case "supertrend":
    case "sar": {
      const line = strategy === "sar" ? parabolicSar(bars) : supertrend(bars);
      return (i) => ({
        enter: line[i]?.bullish === true,
        exit: line[i]?.bullish === false,
      });
    }
    case "ichimoku": {
      const cloud = ichimoku(bars);
      return (i) => ({
        enter:
          cloud[i]!.upper !== null &&
          closes[i]! > cloud[i]!.upper! &&
          cloud[i]!.conversion! > cloud[i]!.base!,
        exit:
          cloud[i]!.lower !== null &&
          (closes[i]! < cloud[i]!.lower! ||
            cloud[i]!.conversion! < cloud[i]!.base!),
      });
    }
    case "turtle": {
      const ranges = atr(bars, 20);
      return (i, p) => ({
        enter: closes[i]! > high(i, 20),
        exit:
          closes[i]! < low(i, 10) ||
          closes[i]! < p.entry - 2 * ranges[p.entryIndex - 1]!,
      });
    }
    case "boll-breakout": {
      const bands = boll(bars);
      return (i) => ({
        enter:
          bands[i]!.upper! > bands[i]!.lower! && closes[i]! > bands[i]!.upper!,
        exit: closes[i]! < bands[i]!.mid!,
      });
    }
    case "keltner": {
      const middle = ema(bars, 20),
        ranges = atr(bars, 20);
      return (i) => ({
        enter: closes[i]! > middle[i]! + 2 * ranges[i]!,
        exit: closes[i]! < middle[i]!,
      });
    }
    case "dual-thrust":
      return (i) => {
        const window = closes.slice(i - 4, i);
        const range = Math.max(
          high(i, 4) - Math.min(...window),
          Math.max(...window) - low(i, 4),
        );
        return {
          enter: range > 0 && closes[i]! > bars[i]!.open + 0.5 * range,
          exit: range > 0 && closes[i]! < bars[i]!.open - 0.5 * range,
        };
      };
    case "momentum120":
    case "momentum250":
    case "skip-momentum": {
      const line = calculateFactor(
        bars,
        strategy === "skip-momentum"
          ? { id: "skip-momentum" }
          : {
              id: "roc",
              parameters: { period: strategy === "momentum120" ? 120 : 250 },
            },
      ).values;
      return (i) => ({
        enter: line[i] !== null && line[i]! > 0,
        exit: line[i] !== null && line[i]! < 0,
      });
    }
    case "rsi-trend":
    case "rsi-reversion":
    case "rsi2": {
      const period = strategy === "rsi2" ? 2 : 14;
      const line = rsi(bars, [period, period, period]),
        long = ma(bars, 200),
        fast = ma(bars, 5);
      return (i, p) => {
        const value = line[i]!.rsi6;
        if (strategy === "rsi-trend")
          return {
            enter: value !== null && value > 55,
            exit: value !== null && value < 45,
          };
        if (strategy === "rsi2")
          return {
            enter: value !== null && value < 10 && closes[i]! > long[i]!,
            exit:
              closes[i]! > fast[i]! ||
              closes[i]! < long[i]! ||
              i - p.entryIndex >= 10,
          };
        return {
          enter: value !== null && value < 30,
          exit: (value !== null && value > 70) || timedRiskExit(i, p),
        };
      };
    }
    case "kdj": {
      const line = kdj(bars);
      return (i, p) => ({
        enter:
          line[i]!.k! > line[i]!.d! &&
          line[i - 1]!.k! <= line[i - 1]!.d! &&
          line[i]!.k! < 30,
        exit:
          (line[i]!.k! < line[i]!.d! &&
            line[i - 1]!.k! >= line[i - 1]!.d! &&
            line[i]!.k! > 70) ||
          timedRiskExit(i, p),
      });
    }
    case "cci":
    case "williams":
    case "mfi": {
      const line =
        strategy === "cci"
          ? cci(bars)
          : strategy === "williams"
            ? williamsR(bars)
            : mfi(bars);
      const lower =
        strategy === "cci" ? -100 : strategy === "williams" ? -80 : 20;
      const upper =
        strategy === "cci" ? 100 : strategy === "williams" ? -20 : 80;
      return (i, p) => ({
        enter: line[i] !== null && line[i]! < lower,
        exit: (line[i] !== null && line[i]! > upper) || timedRiskExit(i, p),
      });
    }
    case "short-reversal":
    case "bias": {
      const average = ma(bars, strategy === "bias" ? 20 : 5);
      return (i, p) => ({
        enter:
          strategy === "bias"
            ? closes[i]! / average[i]! < 0.92
            : closes[i]! / closes[i - 5]! < 0.95,
        exit:
          closes[i]! > average[i]! ||
          timedRiskExit(i, p, strategy === "bias" ? 20 : 10),
      });
    }
    case "obv": {
      const line = obv(bars),
        average = maSeries(line, 20),
        trend = ma(bars, 60);
      return (i) => ({
        enter:
          line[i] !== null &&
          average[i] !== null &&
          line[i]! > average[i]! &&
          closes[i]! > trend[i]!,
        exit:
          (line[i] !== null && average[i] !== null && line[i]! < average[i]!) ||
          closes[i]! < trend[i]!,
      });
    }
    case "volume-breakout": {
      const volume = maSeries(
          bars.map((b) => b.volume),
          20,
        ),
        average = ma(bars, 20);
      return (i) => ({
        enter:
          closes[i]! > high(i, 20) && bars[i]!.volume > 1.5 * volume[i - 1]!,
        exit: closes[i]! < average[i]!,
      });
    }
    case "cmf": {
      const line = chaikinMoneyFlow(bars),
        average = ma(bars, 60);
      return (i) => ({
        enter: line[i] !== null && line[i]! > 0.1 && closes[i]! > average[i]!,
        exit: (line[i] !== null && line[i]! < 0) || closes[i]! < average[i]!,
      });
    }
    case "chandelier": {
      const average = ma(bars, 50),
        ranges = atr(bars, 22);
      return (i, p) => ({
        enter: closes[i]! > average[i]!,
        exit:
          closes[i]! <
          Math.max(...closes.slice(p.entryIndex, i + 1)) - 3 * ranges[i]!,
      });
    }
    case "seasonal":
      return (i) => {
        const month = Number(bars[i]!.date.slice(5, 7)),
          invested = month >= 11 || month <= 4;
        return { enter: invested, exit: !invested };
      };
    default:
      return null;
  }
}
