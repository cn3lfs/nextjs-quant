import {
  evaluateStrategyBook,
  usesStrategyBook,
  strategyReentryAllowed,
  type BookCandidate,
} from "trading-strategies";
import { nextBar } from "./clock.js";
import { keyFor } from "./preparation.js";
import { type PortfolioState } from "./state.js";

export function scheduleClosingTargets(
  state: PortfolioState,
  index: number,
  date: string,
  closeCandidates: Map<string, BookCandidate[]>,
) {
  const {
    request,
    market,
    initial,
    sleeves,
    strategies,
    scheduledAt,
    accounts,
    controls,
    bookStates,
    bookDecisions,
    reentries,
    identities,
    pendingOrders,
    removePending,
    calendar,
    pushOrder,
  } = state;
  // Every sleeve position has its completed close and all standing
  // protection executions before any strategy reads portfolio equity.
  for (const strategy of strategies) {
    const candidates = closeCandidates.get(strategy.id)!;
    if (usesStrategyBook(strategy)) {
      const account = accounts.get(strategy.sleeve)!,
        sleeve = sleeves.find((s) => s.id === strategy.sleeve)!;
      const decision = evaluateStrategyBook(strategy, {
        date,
        calendar: request.calendar,
        candidates,
        equity: account.equity,
        initial: initial * sleeve.share,
        maxPositions: sleeve.maxPositions,
        state: bookStates.get(strategy.id),
        facts: request.bookFacts?.[strategy.id],
        holdings: [...account.positions].map(([key, p]) => ({
          symbol: identities.get(key)!.symbol,
          managed: identities.get(key)!.strategyId === strategy.id,
          weight: (p.quantity * p.mark) / account.equity,
          openRisk:
            controls.get(key)?.stop == null
              ? null
              : (p.quantity * Math.max(0, p.mark - controls.get(key)!.stop!)) /
                account.equity,
        })),
      });
      bookStates.set(strategy.id, decision.state);
      bookDecisions.push({ strategyId: strategy.id, decision });
      const next =
        calendar[index + 1 + (request.signalDelayBars ?? 0)] ??
        (market === "crypto" && !request.signalDelayBars
          ? nextBar(date, strategy.period)
          : null);
      if (decision.targets !== null) {
        for (const order of [...pendingOrders.values()].flatMap((s) => [...s]))
          if (
            order.strategyId === strategy.id &&
            order.targetWeight !== undefined
          ) {
            order.status = "rejected";
            order.reason = "被新的完成bar调仓目标替代";
            removePending(order);
          }
        const symbols = new Set([
          ...Object.keys(decision.targets),
          ...[...account.positions.keys()]
            .filter((k) => identities.get(k)!.strategyId === strategy.id)
            .map((k) => identities.get(k)!.symbol),
        ]);
        for (const symbol of [...symbols].sort()) {
          const key = keyFor(strategy.id, symbol),
            p = account.positions.get(key),
            weight = decision.targets[symbol] ?? 0;
          if (pendingOrders.has(key)) continue;
          const currentWeight = p ? (p.quantity * p.mark) / account.equity : 0;
          if (Math.abs(currentWeight - weight) <= 1e-10) continue;
          const order = pushOrder(
            strategy,
            symbol,
            date,
            next,
            currentWeight > weight ? "sell" : "buy",
            "signal",
          );
          order.targetWeight = weight;
          order.rankScore =
            decision.entries.find((entry) => entry.symbol === symbol)?.score ??
            0;
          order.industries = decision.industries;
          order.riskGroups = decision.riskGroups;
          order.marketTargetShare = decision.marketTargetShare;
        }
      }
      if (!strategy.rebalance && decision.available)
        for (const entry of decision.entries) {
          const key = keyFor(strategy.id, entry.symbol),
            control = controls.get(key);
          if (
            pendingOrders.has(key) ||
            entry.weight <= 0 ||
            (control?.tranches ?? 0) >= strategy.sizing.tranches ||
            !strategyReentryAllowed(
              strategy.exit,
              reentries.get(key),
              index,
              true,
            )
          )
            continue;
          const order = pushOrder(
            strategy,
            entry.symbol,
            date,
            next,
            "buy",
            "signal",
          );
          order.rankScore = entry.score;
          order.weightCeiling = entry.weight;
          order.industries = decision.industries;
          order.riskGroups = decision.riskGroups;
          order.marketTargetShare = decision.marketTargetShare;
        }
    }
  }
  for (const target of scheduledAt.get(date) ?? []) {
    const strategy = strategies.find((s) => s.id === target.strategyId)!;
    const account = accounts.get(strategy.sleeve)!;
    // New completed allocations replace old unfilled allocations, just as
    // the weekly book does. Executed fills remain immutable evidence.
    for (const order of [...pendingOrders.values()].flatMap((active) => [
      ...active,
    ])) {
      if (
        order.strategyId === strategy.id &&
        order.targetWeight !== undefined
      ) {
        order.status = "rejected";
        order.reason = "被新的完成bar调仓目标替代";
        removePending(order);
      }
    }
    const symbols = new Set([
      ...Object.keys(target.targets),
      ...[...account.positions.keys()]
        .filter((key) => identities.get(key)!.strategyId === strategy.id)
        .map((key) => identities.get(key)!.symbol),
    ]);
    for (const symbol of [...symbols].sort()) {
      const key = keyFor(strategy.id, symbol);
      const holding = account.positions.get(key);
      const weight = target.targets[symbol] ?? 0;
      const current = holding
        ? (holding.quantity * holding.mark) / account.equity
        : 0;
      if (Math.abs(current - weight) <= 1e-10 || pendingOrders.has(key))
        continue;
      const order = pushOrder(
        strategy,
        symbol,
        date,
        calendar[index + 1 + (request.signalDelayBars ?? 0)] ?? null,
        current > weight ? "sell" : "buy",
        "signal",
      );
      order.targetWeight = weight;
      order.targetSourceHash = target.sourceHash;
      const score = target.scores?.[symbol];
      if (score !== undefined) order.rankScore = score;
    }
  }
}
