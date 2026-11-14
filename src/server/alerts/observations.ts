import type { Bar } from "~/lib/domain";
import {
  strategyProtection,
  type StrategyObjectInput,
} from "trading-strategies";
import type { AlertKind } from "~/lib/strategy-facts/alerts";

export type HoldingProtection = {
  stop: number | null;
  target: number | null;
  trailing: number | null;
};
export type HoldingWatchState = {
  bar: string;
  high: number;
  active: AlertKind | null;
};
/** Close crossing, not an invented intrabar path. Persisted re-arm survives restarts. */
export function holdingObservation(
  strategy: StrategyObjectInput,
  bar: Bar,
  protection: HoldingProtection,
  previous?: HoldingWatchState,
) {
  if (previous && previous.bar >= bar.date)
    return { state: previous, trigger: null };
  const high = previous?.high ?? bar.close;
  const closeOnly = {
    ...bar,
    open: bar.close,
    high: bar.close,
    low: bar.close,
  };
  const result = strategyProtection(
    {
      ...strategy,
      exit: { ...strategy.exit, trailing: protection.trailing ?? undefined },
    },
    closeOnly,
    { stop: protection.stop, target: protection.target, high },
  );
  const type = result?.trigger ?? null;
  return {
    state: {
      bar: bar.date,
      high: Math.max(high, bar.close),
      active: type,
    } as HoldingWatchState,
    trigger: type && type !== previous?.active ? type : null,
  };
}
/** Explanatory baseline only: close vs SMA20, SMA20 vs SMA60; temperature is close's percentile in last 120 observations. */
export function regimeObservation(bars: readonly Bar[]) {
  if (bars.length < 120) return null;
  const prices = bars.map((b) => b.close);
  const close = prices.at(-1)!;
  const mean = (n: number) => prices.slice(-n).reduce((a, b) => a + b, 0) / n;
  const fast = mean(20),
    slow = mean(60);
  const trend =
    close > fast && fast > slow
      ? "up"
      : close < fast && fast < slow
        ? "down"
        : "mixed";
  const temperature =
    (prices.slice(-120).filter((p) => p <= close).length / 120) * 100;
  return {
    trend,
    temperature,
    zone: temperature >= 80 ? "hot" : temperature <= 20 ? "cold" : "normal",
    basis: "收盘/SMA20/SMA60；温度=近120根收盘经验分位，非完整市场温度模型",
  };
}
