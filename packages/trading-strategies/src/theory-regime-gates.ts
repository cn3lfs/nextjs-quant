import type { Bar } from "trading-strategy-core/bars";
import { completedBarFilter } from "trading-strategy-core/completed-bars";
import { isValidOhlcvBar } from "./screener/helpers.js";

export const oneilMarketDefaults = {
  distributionWindow: 25,
  pressureThreshold: 4,
  correctionThreshold: 6,
  followThroughGain: 0.0125,
  pressureScale: 0.5,
} as const;
export const dowDualIndexDefaults = { swingBars: 3, waitScale: 0.5 } as const;

type Cutoff = {
  asOf?: string;
  index?: number;
  /** Epoch milliseconds. Use only daily sessions completed by the A-share close cutoff. */
  now?: number;
  /** Explicitly unfinished sessions are excluded even after the clock cutoff. */
  formingDates?: readonly string[];
};
export type OneilMarketOptions = Cutoff & {
  [K in keyof typeof oneilMarketDefaults]?: number;
};
export type OneilMarketDirection = {
  status:
    "confirmed-uptrend" | "uptrend-under-pressure" | "correction" | "unknown";
  distributionDays: number | null;
  rallyDay: number | null;
  followThroughDate: string | null;
  scale: number | null;
};
export type DowDualIndexOptions = Cutoff & {
  [K in keyof typeof dowDualIndexDefaults]?: number;
};
export type DowDualIndexDirection = {
  status: "confirmed-up" | "confirmed-down" | "wait" | "unknown";
  scale: number | null;
};

function completionFilter({ now, formingDates }: Cutoff) {
  const closed = now === undefined ? undefined : completedBarFilter("day", now);
  const forming = new Set(formingDates);
  return (date: string) => !forming.has(date) && (!closed || closed(date));
}

// An explicit date must exist in the bounded input. Only completed sessions
// within that prefix contribute prices, volumes, or pivot confirmation.
function completedBars(
  bars: readonly Bar[],
  { asOf, index }: Cutoff,
  isComplete: (date: string) => boolean,
) {
  if (
    index !== undefined &&
    (!Number.isInteger(index) || index < 0 || index >= bars.length)
  )
    return null;
  const end = index === undefined ? bars.length : index + 1;
  const history: Bar[] = [];
  let reachedDate = asOf === undefined;
  for (let i = 0; i < end; i++) {
    const bar = bars[i]!;
    if (asOf !== undefined && bar.date > asOf) break;
    if (isComplete(bar.date)) {
      if (
        !isValidOhlcvBar(bar) ||
        !Number.isFinite(Date.parse(bar.date)) ||
        (history.length && bar.date <= history.at(-1)!.date)
      )
        return null;
      history.push(bar);
    }
    if (bar.date === asOf) {
      reachedDate = true;
      break;
    }
  }
  return reachedDate && history.length ? history : null;
}
const unitScale = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
const positiveInteger = (n: number) => Number.isSafeInteger(n) && n > 0;

export function evaluateOneilMarketDirection(
  bars: readonly Bar[],
  options: OneilMarketOptions = {},
): OneilMarketDirection {
  const {
    distributionWindow,
    pressureThreshold,
    correctionThreshold,
    followThroughGain,
    pressureScale,
  } = { ...oneilMarketDefaults, ...options };
  const history = completedBars(bars, options, completionFilter(options));
  // Each distribution observation needs a prior close and comparable volume.
  if (
    !history ||
    !positiveInteger(distributionWindow) ||
    history.length <= distributionWindow ||
    !positiveInteger(pressureThreshold) ||
    !positiveInteger(correctionThreshold) ||
    correctionThreshold <= pressureThreshold ||
    !Number.isFinite(followThroughGain) ||
    followThroughGain <= 0 ||
    !unitScale(pressureScale)
  )
    return {
      status: "unknown",
      distributionDays: null,
      rallyDay: null,
      followThroughDate: null,
      scale: null,
    };

  let start: number | null = null,
    rallyLow = history[0]!.low;
  let followThroughDate: string | null = null;
  let distributionDays = 0;
  const distribution = (i: number) => {
    const bar = history[i]!,
      prior = history[i - 1]!;
    return bar.volume > prior.volume && bar.close <= prior.close * (1 - 0.002);
  };
  for (let i = 1; i < history.length; i++) {
    const bar = history[i]!,
      prior = history[i - 1]!;
    if (distribution(i)) distributionDays++;
    if (i > distributionWindow && distribution(i - distributionWindow))
      distributionDays--;
    if (
      start !== null &&
      (bar.low < rallyLow ||
        (followThroughDate !== null && distributionDays >= correctionThreshold))
    ) {
      start = null;
      rallyLow = bar.low;
      followThroughDate = null;
      continue;
    }
    if (start === null) {
      rallyLow = Math.min(rallyLow, bar.low);
      if (bar.close > prior.close) start = i;
    } else if (
      followThroughDate === null &&
      i - start + 1 >= 4 &&
      distributionDays < correctionThreshold &&
      bar.volume > prior.volume &&
      bar.close >= prior.close * (1 + followThroughGain)
    ) {
      followThroughDate = bar.date;
    }
  }
  const status =
    followThroughDate === null
      ? "correction"
      : distributionDays >= pressureThreshold
        ? "uptrend-under-pressure"
        : "confirmed-uptrend";
  return {
    status,
    distributionDays,
    rallyDay: start === null ? null : history.length - start,
    followThroughDate,
    scale:
      status === "correction"
        ? 0
        : status === "confirmed-uptrend"
          ? 1
          : pressureScale,
  };
}

function swingDirection(bars: readonly Bar[], k: number) {
  let previousHigh: number | undefined, lastHigh: number | undefined;
  let previousLow: number | undefined, lastLow: number | undefined;
  for (let i = k; i + k < bars.length; i++) {
    const pivot = bars[i]!;
    let high = true,
      low = true;
    for (let d = 1; d <= k && (high || low); d++) {
      high =
        high &&
        pivot.high > bars[i - d]!.high &&
        pivot.high > bars[i + d]!.high;
      low = low && pivot.low < bars[i - d]!.low && pivot.low < bars[i + d]!.low;
    }
    if (high) {
      previousHigh = lastHigh;
      lastHigh = pivot.high;
    }
    if (low) {
      previousLow = lastLow;
      lastLow = pivot.low;
    }
  }
  if (
    previousHigh === undefined ||
    lastHigh === undefined ||
    previousLow === undefined ||
    lastLow === undefined
  )
    return null;
  if (lastHigh > previousHigh && lastLow > previousLow) return "up";
  if (lastHigh < previousHigh && lastLow < previousLow) return "down";
  return "mixed";
}

export function evaluateDowDualIndex(
  primaryBars: readonly Bar[],
  secondaryBars: readonly Bar[],
  options: DowDualIndexOptions = {},
): DowDualIndexDirection {
  const { swingBars, waitScale } = { ...dowDualIndexDefaults, ...options };
  const unknown = { status: "unknown", scale: null } as const;
  if (!positiveInteger(swingBars) || !unitScale(waitScale)) return unknown;
  // index belongs to the primary series; the other index is bounded by date.
  const isComplete = completionFilter(options);
  let asOf = options.asOf;
  if (asOf === undefined) {
    if (options.index !== undefined) asOf = primaryBars[options.index]?.date;
    else {
      const lastCompleteDate = (bars: readonly Bar[]) => {
        for (let i = bars.length - 1; i >= 0; i--)
          if (isComplete(bars[i]!.date)) return bars[i]!.date;
      };
      const primaryEnd = lastCompleteDate(primaryBars);
      const secondaryEnd = lastCompleteDate(secondaryBars);
      if (!primaryEnd || !secondaryEnd) return unknown;
      asOf = primaryEnd < secondaryEnd ? primaryEnd : secondaryEnd;
    }
  }
  if (!asOf) return unknown;
  const a = completedBars(
      primaryBars,
      { asOf, index: options.index },
      isComplete,
    ),
    b = completedBars(secondaryBars, { asOf }, isComplete);
  if (!a || !b) return unknown;
  // Different inception dates are fine; a hole inside the overlap is not.
  const first = a[0]!.date > b[0]!.date ? a[0]!.date : b[0]!.date;
  const left = a.slice(a.findIndex((bar) => bar.date >= first)),
    right = b.slice(b.findIndex((bar) => bar.date >= first));
  if (
    left.length !== right.length ||
    left.some((bar, i) => bar.date !== right[i]!.date)
  )
    return unknown;
  const primary = swingDirection(left, swingBars),
    secondary = swingDirection(right, swingBars);
  if (primary === null || secondary === null) return unknown;
  if (primary === "up" && secondary === "up")
    return { status: "confirmed-up", scale: 1 };
  if (primary === "down" && secondary === "down")
    return { status: "confirmed-down", scale: 0 };
  return { status: "wait", scale: waitScale };
}

export type LongOnlyMixtureInput = {
  strategies: readonly {
    id: string;
    gateWeight: number;
    targets: Readonly<Record<string, number | null>> | null;
    exits: readonly string[];
  }[];
  maxSymbolWeight: number;
  maxTotalExposure: number;
};
export type LongOnlyMixture = {
  status: "ok" | "partial" | "unknown";
  weights: Record<string, number>;
  forcedExits: string[];
  totalExposure: number | null;
  scaleApplied: number | null;
};

export function composeLongOnlyStrategies(
  input: LongOnlyMixtureInput,
): LongOnlyMixture {
  const raw = new Map<string, number>(),
    exits = new Set<string>(),
    unknownSymbols = new Set<string>();
  let gateSum = 0,
    unknownUniverse = false,
    incomplete = false;
  for (const strategy of input.strategies) {
    const ownExits = new Set(strategy.exits);
    for (const symbol of ownExits) exits.add(symbol);
    if (strategy.gateWeight === 0) continue;
    const validGate =
      Number.isFinite(strategy.gateWeight) && strategy.gateWeight >= 0;
    if (validGate) gateSum += strategy.gateWeight;
    else incomplete = true;
    if (strategy.targets === null) {
      unknownUniverse = true;
      continue;
    }
    for (const [symbol, weight] of Object.entries(strategy.targets)) {
      if (ownExits.has(symbol)) continue;
      if (!validGate || weight === null || !unitScale(weight)) {
        unknownSymbols.add(symbol);
        continue;
      }
      raw.set(symbol, (raw.get(symbol) ?? 0) + strategy.gateWeight * weight);
    }
  }
  const unknown: LongOnlyMixture = {
    status: "unknown",
    weights: {},
    forcedExits: [...exits].sort(),
    totalExposure: null,
    scaleApplied: null,
  };
  if (
    unknownUniverse ||
    gateSum > 1 + 1e-9 ||
    !unitScale(input.maxSymbolWeight) ||
    input.maxSymbolWeight === 0 ||
    !unitScale(input.maxTotalExposure) ||
    input.maxTotalExposure === 0
  )
    return unknown;
  const capped = [...raw]
    .filter(([symbol]) => !unknownSymbols.has(symbol))
    .map(
      ([symbol, weight]) =>
        [symbol, Math.min(weight, input.maxSymbolWeight)] as const,
    );
  const sum = capped.reduce((total, [, weight]) => total + weight, 0);
  const partial = incomplete || unknownSymbols.size > 0;
  if (partial && !capped.length) return unknown;
  const scaleApplied =
    sum > input.maxTotalExposure ? input.maxTotalExposure / sum : 1;
  const weights = Object.fromEntries(
    capped.map(([symbol, weight]) => [symbol, weight * scaleApplied]),
  );
  return {
    status: partial ? "partial" : "ok",
    weights,
    forcedExits: [...exits].filter((symbol) => !(weights[symbol]! > 0)).sort(),
    totalExposure: sum * scaleApplied,
    scaleApplied,
  };
}
