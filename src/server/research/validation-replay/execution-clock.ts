import { type PortfolioRequest } from "quant-backtest";
import { type ValidationDataset } from "../validation-capture";

export function projectToExecutionClock(
  request: PortfolioRequest,
  base: ValidationDataset,
  factor: number,
): PortfolioRequest {
  const strategies = request.strategies.map((s) => ({
    ...s,
    ...(s.exit.maxBars
      ? { exit: { ...s.exit, maxBars: s.exit.maxBars * factor } }
      : {}),
  }));
  const instruments = base.instruments.flatMap((instrument) => {
    const original = request.instruments.find(
      (i) => i.symbol === instrument.symbol,
    );
    if (!original) return [];
    const signals = new Map(
      original.external?.signals?.map((s) => [Date.parse(s.date), s]),
    );
    const levels = new Map(
      original.external?.levels?.map((s) => [Date.parse(s.date), s]),
    );
    const entry = strategies[0]!.entry;
    if (entry.kind !== "external")
      throw new Error(
        "Common-clock replay requires frozen native-timeframe decisions",
      );
    return [
      {
        ...instrument,
        external: {
          signals: instrument.bars.map((b) => ({
            id: entry.id,
            date: b.date,
            availableAt: b.date,
            entry: signals.get(Date.parse(b.date))?.entry ?? false,
            exit: signals.get(Date.parse(b.date))?.exit ?? false,
          })),
          levels: instrument.bars.flatMap((b) => {
            const level = levels.get(Date.parse(b.date));
            return level
              ? [{ ...level, date: b.date, availableAt: b.date }]
              : [];
          }),
        },
      },
    ];
  });
  return {
    ...request,
    strategies,
    instruments,
    calendar: base.benchmark.map((b) => b.date),
    start: [request.start, base.dates[0]!].sort().at(-1)!,
    end: [request.end, base.dates.at(-1)!].sort()[0]!,
  };
}
