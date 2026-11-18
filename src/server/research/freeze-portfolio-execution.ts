import type { PortfolioInstrument, PortfolioExecution } from "quant-backtest";

/** Freeze pure adapters as data before hashing, exporting and executing. Missing
 * evidence stays absent so a round-trip cannot turn a blocked fill into a trade. */
export function freezePortfolioExecution(
  instrument: PortfolioInstrument,
): PortfolioInstrument {
  const adapter = instrument.execution;
  if (typeof adapter !== "function") return instrument;
  const execution: Record<string, PortfolioExecution> = {};
  instrument.bars.forEach((bar, index) => {
    const fact = adapter(bar, instrument.bars[index - 1]);
    if (fact) execution[bar.date] = fact;
  });
  return { ...instrument, execution };
}
