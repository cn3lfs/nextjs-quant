import {
  evaluateStrategyBook,
  type StrategyBookDecision,
} from "trading-strategies";
import { type PortfolioState } from "./state.js";

export function seedStrategyBooks(state: PortfolioState) {
  const {
    request,
    initial,
    sleeves,
    strategies,
    instruments,
    bookStates,
    bookDecisions,
    calendar,
    eligibleAt,
    pushOrder,
  } = state;
  for (const seed of request.bookSeeds ?? []) {
    const strategy = strategies.find((s) => s.id === seed.strategyId);
    if (
      !strategy?.rebalance ||
      seed.availableAt > seed.date ||
      seed.date >= calendar[0]! ||
      !request.calendar.includes(seed.date) ||
      bookStates.has(strategy.id)
    )
      throw new Error("Invalid causal pre-start book seed");
    const previousSelected = seed.previousSelected;
    if (
      previousSelected &&
      (seed.selectionFrom !== undefined ||
        !Number.isFinite(Date.parse(previousSelected.date)) ||
        !Number.isFinite(Date.parse(previousSelected.availableAt)) ||
        previousSelected.availableAt > previousSelected.date ||
        previousSelected.date >= seed.date ||
        !/^[a-f0-9]{64}$/.test(previousSelected.sourceHash) ||
        new Set(previousSelected.symbols).size !==
          previousSelected.symbols.length ||
        previousSelected.symbols.some((symbol) => !symbol))
    )
      throw new Error("Invalid causal prior weekly selection feature");
    const sleeve = sleeves.find((s) => s.id === strategy.sleeve)!;
    const week = (date: string) => {
      const d = new Date(date.slice(0, 10));
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    };
    const selectionDates = seed.selectionFrom
      ? request.calendar.filter(
          (date, i) =>
            date >= seed.selectionFrom! &&
            date <= seed.date &&
            request.calendar[i + 1] &&
            week(date) !== week(request.calendar[i + 1]!),
        )
      : [seed.date];
    if (
      !selectionDates.length ||
      selectionDates.at(-1) !== seed.date ||
      (seed.selectionFrom && seed.selectionFrom > seed.date)
    )
      throw new Error("Invalid causal selection warmup seed");
    let decision: StrategyBookDecision | undefined;
    for (const date of selectionDates) {
      const candidates = [...instruments].map(([symbol, source]) => {
        const i = source.indices.get(date);
        return {
          symbol,
          bars: source.instrument.signalBars,
          external: source.instrument.external,
          eligible: eligibleAt(strategy, symbol, source, date),
          decision:
            i === undefined
              ? { entry: null, exit: null, stopLevel: null }
              : source.evaluators.get(strategy.id)!.evaluate(i),
        };
      });
      // Selection/buffer history is a causal feature. Warmup always has fresh
      // initial capital and no positions, fills, returns or inherited DD.
      decision = evaluateStrategyBook(strategy, {
        date,
        calendar: request.calendar,
        candidates,
        equity: initial * sleeve.share,
        initial: initial * sleeve.share,
        maxPositions: sleeve.maxPositions,
        facts: request.bookFacts?.[strategy.id],
        holdings: [],
        state:
          decision?.state ??
          (previousSelected
            ? { selected: [...previousSelected.symbols] }
            : undefined),
      });
      if (!decision.available)
        throw new Error(
          `Pre-start selection evidence unavailable: ${decision.reason}`,
        );
    }
    if (!decision || !decision.available || decision.targets === null)
      throw new Error(
        `Pre-start book seed unavailable: ${decision?.reason ?? "not a completed weekly signal"}`,
      );
    bookStates.set(strategy.id, decision.state);
    bookDecisions.push({ strategyId: strategy.id, decision });
    if (seed.emitOrders === false) continue;
    for (const [symbol, weight] of Object.entries(decision.targets))
      if (weight > 0) {
        const due = calendar[request.signalDelayBars ?? 0] ?? null;
        const order = pushOrder(
          strategy,
          symbol,
          seed.date,
          due,
          "buy",
          "signal",
        );
        order.targetWeight = weight;
        order.rankScore =
          decision.entries.find((entry) => entry.symbol === symbol)?.score ?? 0;
        order.industries = decision.industries;
        order.riskGroups = decision.riskGroups;
        order.marketTargetShare = decision.marketTargetShare;
      }
  }
}
