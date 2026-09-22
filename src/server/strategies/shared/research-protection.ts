import type { Bar } from "~/lib/domain";
import { vcpFacts } from "../canslim/vcp";

/** Reuses the same 3-left/3-right, 60-bar diagnostic as breakout. This is a
 * price-structure engineering definition, not an additional CZSC DLL signal.
 */
export function researchHigherLow(
  bars: readonly Bar[],
  entryDate: string,
  entry: number,
) {
  const window = bars.slice(-60);
  if (
    window.length < 60 ||
    window.some(
      (bar, i) =>
        ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(
          Number.isFinite,
        ) ||
        bar.low <= 0 ||
        bar.low > Math.min(bar.open, bar.close) ||
        bar.high < Math.max(bar.open, bar.close) ||
        bar.volume < 0 ||
        (i > 0 && bar.date <= window[i - 1]!.date),
    )
  )
    return {
      status: "unavailable" as const,
      reason: "结构保本需要60根有效且递增的日线",
    };
  const facts = vcpFacts({
    id: "research-protection",
    hash: "",
    createdAt: 0,
    symbol: "",
    source: "tdx-local",
    adjustment: "none",
    period: "day",
    bars: [...window],
  });
  const barrier = [
    ...(facts.ambiguousDates ?? []),
    ...window.filter((bar) => bar.volume === 0).map((bar) => bar.date),
  ]
    .sort()
    .at(-1);
  const lows = (facts.extrema ?? []).filter(
    (point) => point.kind === "low" && (!barrier || point.date > barrier),
  );
  const previous = lows.at(-2),
    latest = lows.at(-1);
  const confirmed =
    !!previous &&
    !!latest &&
    latest.date > entryDate &&
    latest.price > previous.price &&
    latest.price > entry;
  return {
    status: confirmed ? ("confirmed" as const) : ("not-confirmed" as const),
    version: facts.version,
    asOf: window.at(-1)!.date,
    barrier: barrier ?? null,
    previous: previous ?? null,
    latest: latest ?? null,
  };
}
