import type {
  runPortfolio,
  PortfolioRequest,
  ValidationScore,
} from "quant-backtest";
import type { ValidationDataset } from "../../src/server/research/validation-capture";
import { scoreValidationResult } from "../../src/server/research/validation-replay";

/** Conditional TWR on actual shared-account flows. A day with no capital at
 * any bar is unknown; the benchmark compounds only the same funded days. */
export function scoreBookSleeves(
  result: ReturnType<typeof runPortfolio>,
  request: PortfolioRequest,
  dataset: ValidationDataset,
) {
  const prices = new Map<string, { open: number; close: number }>();
  for (const b of dataset.benchmark) {
    const date = b.date.slice(0, 10);
    if (date < request.start || date > request.end) continue;
    const prior = prices.get(date);
    prices.set(date, { open: prior?.open ?? b.open, close: b.close });
  }
  let previousBenchmark: number | undefined;
  const benchmarkDaily = new Map(
    result.equity.map((p) => {
      const b = prices.get(p.date),
        value = b ? b.close / (previousBenchmark ?? b.open) - 1 : undefined;
      previousBenchmark = b?.close;
      return [p.date, value] as const;
    }),
  );
  const scores = new Map<string, ValidationScore>();
  for (const sleeve of request.sleeves) {
    const flows = new Map<string, number>();
    for (const t of result.transfers)
      if (t.sleeve === sleeve.id)
        flows.set(t.date, (flows.get(t.date) ?? 0) + t.amount);
    let previous = request.initial * sleeve.share,
      nav = 1;
    const days = new Map<string, { nav: number; observed: boolean }>();
    for (const point of result.curve) {
      const date = point.date.slice(0, 10),
        current = point.sleeves.find((s) => s.id === sleeve.id)!.equity,
        flow = flows.get(point.date) ?? 0;
      let observed = days.get(date)?.observed ?? false;
      if (previous > 0) {
        nav *= 1 + ((current - flow) / previous - 1);
        observed = true;
      }
      previous = current;
      days.set(date, { nav, observed });
    }
    const equity = result.equity
      .filter((p) => days.get(p.date)!.observed)
      .map((p) => ({ ...p, equity: days.get(p.date)!.nav }));
    let benchmarkNav = 1;
    const benchmark = equity.flatMap((p) => {
      const value = benchmarkDaily.get(p.date);
      if (value === undefined) return [];
      const open = benchmarkNav;
      benchmarkNav *= 1 + value;
      return [
        {
          date: p.date,
          open,
          close: benchmarkNav,
          high: Math.max(open, benchmarkNav),
          low: Math.min(open, benchmarkNav),
          volume: 0,
          amount: 0,
        },
      ];
    });
    const ids = new Set(
      result.orders.filter((o) => o.sleeve === sleeve.id).map((o) => o.id),
    );
    const filtered = {
      ...result,
      equity,
      fills: result.fills.filter((f) => f.sleeve === sleeve.id),
      orders: result.orders.filter((o) => o.sleeve === sleeve.id),
      rejections: result.rejections.filter((r) => ids.has(r.orderId)),
      observations: result.observations.filter(
        (o) =>
          request.strategies.find((s) => s.id === o.strategyId)?.sleeve ===
          sleeve.id,
      ),
      ...(result.observationCounts
        ? {
            observationCounts: Object.fromEntries(
              Object.entries(result.observationCounts).filter(
                ([id]) =>
                  request.strategies.find((s) => s.id === id)?.sleeve ===
                  sleeve.id,
              ),
            ),
          }
        : {}),
    };
    const score = scoreValidationResult(
      filtered,
      { ...request, initial: 1 },
      { ...dataset, benchmark },
    );
    const activeReturns = new Map(
      equity.map((p, i) => [p.date, score.daily[i]!]),
    );
    score.daily = result.equity.map((p) => activeReturns.get(p.date) ?? null);
    scores.set(sleeve.id, score);
  }
  return scores;
}
