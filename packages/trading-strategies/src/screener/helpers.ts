import type { Bar } from "trading-strategy-core/bars";
import type { ConfirmedExtremum } from "trading-strategy-core/indicators";
import type { TheoryGeometryLine } from "./types.js";

export function isValidOhlcvBar(bar: Bar | undefined | null): bar is Bar {
  return (
    !!bar &&
    [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
      Number.isFinite,
    ) &&
    bar.volume > 0 &&
    bar.low > 0 &&
    bar.low <= Math.min(bar.open, bar.close) &&
    bar.high >= Math.max(bar.open, bar.close)
  );
}

export function isValidBarRange(
  bars: readonly Bar[],
  start: number,
  end: number,
): boolean {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end >= bars.length
  )
    return false;
  for (let i = start; i <= end; i++)
    if (!isValidOhlcvBar(bars[i])) return false;
  return true;
}

export function meanVolume(
  bars: readonly Bar[],
  start: number,
  end: number,
): number | null {
  if (!isValidBarRange(bars, start, end)) return null;
  let sum = 0;
  for (let i = start; i <= end; i++) sum += bars[i]!.volume;
  return sum / (end - start + 1);
}

export function priorVolumeRatio(
  bars: readonly Bar[],
  index: number,
  window = 20,
): number | null {
  const bar = bars[index];
  if (!isValidOhlcvBar(bar)) return null;
  const mean = meanVolume(bars, index - window, index - 1);
  return mean === null ? null : bar.volume / mean;
}

export function computeRewardMultiple(
  direction: "long" | "short",
  entryPrice: number,
  stopPrice: number | null,
  targetPrice: number | null,
): number | null {
  if (
    stopPrice === null ||
    targetPrice === null ||
    ![entryPrice, stopPrice, targetPrice].every(
      (p) => Number.isFinite(p) && p > 0,
    )
  )
    return null;
  const sign = direction === "long" ? 1 : -1;
  const risk = sign * (entryPrice - stopPrice);
  const reward = sign * (targetPrice - entryPrice);
  return risk > 0 && reward > 0 ? reward / risk : null;
}

export function clampScore(score: number): number {
  return Number.isNaN(score) ? 1 : Math.max(1, Math.min(5, Math.round(score)));
}

export function causalAlternatingPivots(
  extrema: readonly ConfirmedExtremum[],
  bars: readonly Bar[],
  atIndex: number,
  lookbackBars = 120,
): ConfirmedExtremum[] {
  const bar = bars[atIndex];
  if (!bar) return [];
  const first = Math.max(0, atIndex - lookbackBars);
  const result: ConfirmedExtremum[] = [];
  // confirmedExtrema emits pivots in ascending bar order.
  for (const p of extrema) {
    if (!(
      p.index >= first &&
      p.index + 3 <= atIndex &&
      p.confirmedAt <= bar.date &&
      isValidBarRange(bars, Math.max(0, p.index - 3), p.index + 3)
    ))
      continue;
    const last = result.at(-1);
    if (last?.kind !== p.kind) result.push(p);
    else if (p.kind === "high" ? p.price > last.price : p.price < last.price)
      result[result.length - 1] = p;
  }
  return result;
}

export function makeGeometryLine(
  bars: readonly Bar[],
  label: string,
  kind: TheoryGeometryLine["kind"],
  style: TheoryGeometryLine["style"],
  anchors: readonly { index: number; price: number }[],
): TheoryGeometryLine {
  return {
    label,
    kind,
    style,
    points: anchors
      .filter(
        ({ index, price }) =>
          Number.isInteger(index) &&
          index >= 0 &&
          index < bars.length &&
          Number.isFinite(price),
      )
      .map(({ index, price }) => ({
        index,
        price,
        date: bars[index]!.date,
      })),
  };
}

export function astockPriceLimitRatio(symbol?: string): number {
  if (/^bj/i.test(symbol ?? "")) return 0.3;
  return /^(sh688|sz30[01])/i.test(symbol ?? "") ? 0.2 : 0.1;
}

export function astockLimitUpCents(
  prevClose: number,
  symbol?: string,
): number | null {
  if (!Number.isFinite(prevClose) || prevClose <= 0) return null;
  const prevCents = Math.round(prevClose * 100);
  const ratioPct = Math.round(astockPriceLimitRatio(symbol) * 100);
  return Math.round((prevCents * (100 + ratioPct)) / 100);
}

export function astockLimitUpPrice(
  prevClose: number,
  symbol?: string,
): number | null {
  const cents = astockLimitUpCents(prevClose, symbol);
  return cents === null ? null : cents / 100;
}

export function isAstockLimitUp(
  prevClose: number,
  close: number,
  symbol?: string,
): boolean {
  if (!Number.isFinite(close) || close <= 0) return false;
  const limitCents = astockLimitUpCents(prevClose, symbol);
  return limitCents !== null && Math.round(close * 100) === limitCents;
}
