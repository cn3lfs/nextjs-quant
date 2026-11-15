import type { PortfolioRequest } from "quant-backtest";
export type ResearchSizing = "equal" | "volatility";
/** Fixed before results: 60 completed UTC daily returns, sample volatility,
 * 365-day annualization, 30% target; no leverage and 1/N per-instrument cap. */
export function sizeCryptoResearch(
  request: PortfolioRequest,
  scheme: ResearchSizing,
): PortfolioRequest {
  if (request.market !== "crypto")
    throw new Error("Crypto research sizing requires crypto market");
  const count = request.instruments.length;
  if (!count) throw new Error("Empty sizing universe");
  const cap = 1 / count;
  const strategies = request.strategies.map((s) => ({
    ...s,
    sizing: {
      kind: "weight" as const,
      weight: cap,
      tranches: s.sizing.tranches,
    },
  }));
  const positionWeights: NonNullable<
    PortfolioRequest["positionWeights"]
  >[number][] = [];
  if (scheme === "volatility")
    for (const instrument of request.instruments) {
      const closes = new Map<string, number>();
      for (const b of instrument.bars) {
        const stamp = Date.parse(b.date);
        if (b.date.length !== 10 && stamp % 86400000 !== 0) continue;
        // Intraday labels are native bar ends; midnight belongs to previous UTC day.
        const date =
          b.date.length === 10
            ? b.date
            : new Date(stamp - 1).toISOString().slice(0, 10);
        closes.set(date, b.close);
      }
      const rows = [...closes].sort(([a], [b]) => a.localeCompare(b));
      for (let i = 60; i < rows.length; i++) {
        const slice = rows.slice(i - 60, i + 1);
        const complete = slice.every(
          (r, j) =>
            j === 0 ||
            Date.parse(r[0]) - Date.parse(slice[j - 1]![0]) === 86400000,
        );
        if (!complete) continue;
        const returns = slice.slice(1).map((r, j) => r[1] / slice[j]![1] - 1);
        const mean = returns.reduce((a, b) => a + b, 0) / 60;
        const vol = Math.sqrt(
          (returns.reduce((n, r) => n + (r - mean) ** 2, 0) / 59) * 365,
        );
        const date =
          request.strategies[0]!.period === "day"
            ? rows[i]![0]
            : new Date(Date.parse(rows[i]![0]) + 86400000).toISOString();
        const weight = cap * Math.min(1, vol === 0 ? 1 : 0.3 / vol);
        for (const s of strategies)
          positionWeights.push({
            strategyId: s.id,
            symbol: instrument.symbol,
            date,
            availableAt: date,
            weight,
          });
      }
    }
  // A missing daily close invalidates the last volatility estimate. Explicit
  // zero sentinels prevent latest-known weights surviving a historical gap.
  if (scheme === "volatility") {
    const keys = new Set(
      positionWeights.map((w) => `${w.strategyId}|${w.symbol}|${w.date}`),
    );
    const expired = positionWeights.flatMap((w) => {
      const stamp = new Date(Date.parse(w.date) + 86400000).toISOString();
      const date =
        request.strategies[0]!.period === "day" ? stamp.slice(0, 10) : stamp;
      return keys.has(`${w.strategyId}|${w.symbol}|${date}`)
        ? []
        : [{ ...w, date, availableAt: date, weight: 0 }];
    });
    positionWeights.push(...expired);
    positionWeights.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.strategyId.localeCompare(b.strategyId) ||
        a.symbol.localeCompare(b.symbol),
    );
  }
  return {
    ...request,
    strategies,
    sleeves: request.sleeves.map((s) => ({ ...s, maxPositions: count })),
    ...(scheme === "volatility" ? { positionWeights } : {}),
  };
}
