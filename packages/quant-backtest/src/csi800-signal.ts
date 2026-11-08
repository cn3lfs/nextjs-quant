import type { Csi800Stock } from "./csi800-study.js";
import type { Bar } from "./model.js";

/** Causal close-to-close economic wealth, reinvesting distributions at close.
 * Scaled OHLC is for completed-bar indicators only, never open-to-open labels.
 */
export function csi800SignalBars(stock: Csi800Stock): Bar[] {
  const ordered = [...stock.actions].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  let cursor = 0,
    previousSignal: number | undefined;
  return stock.bars.map((b, i) => {
    const previous = stock.bars[i - 1];
    let shares = 1,
      distribution = 0;
    while (cursor < ordered.length && ordered[cursor]!.date <= b.date) {
      const a = ordered[cursor++]!;
      if (!previous || a.date <= previous.date) continue;
      distribution +=
        shares * (a.dividend - (a.rights ?? 0) * (a.rightsPrice ?? 0));
      shares *= 1 + a.bonus + (a.rights ?? 0);
    }
    const close = previous
      ? (previousSignal! * (b.close * shares + distribution)) / previous.close
      : b.close;
    const scale = close / b.close;
    previousSignal = close;
    return {
      ...b,
      close,
      open: b.open * scale,
      high: b.high * scale,
      low: b.low * scale,
    };
  });
}

/** One raw share purchased at entry open; no entitlement to entry-date actions. */
export function csi800ForwardReturn(
  stock: Csi800Stock,
  entry: string,
  exit: string,
) {
  const start = stock.bars.find((b) => b.date === entry),
    end = stock.bars.find((b) => b.date === exit);
  if (!start || !end || exit <= entry) return null;
  let quantity = 1,
    cash = 0;
  for (const a of [...stock.actions].sort((a, b) =>
    a.date.localeCompare(b.date),
  )) {
    if (a.date <= entry || a.date > exit) continue;
    if (a.unsupported) return null;
    cash += quantity * (a.dividend - (a.rights ?? 0) * (a.rightsPrice ?? 0));
    quantity *= 1 + a.bonus + (a.rights ?? 0);
  }
  const result = (quantity * end.open + cash) / start.open - 1;
  return Number.isFinite(result) ? result : null;
}
