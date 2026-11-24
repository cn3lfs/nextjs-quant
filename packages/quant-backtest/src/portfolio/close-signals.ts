import {
  strategyProtection,
  strategyTimeExit,
  usesStrategyBook,
  nextStrategyProtection,
  strategyReentryAllowed,
  type BookCandidate,
  type StrategyDecision,
} from "trading-strategies";
import { nextBar } from "./clock.js";
import { keyFor } from "./preparation.js";
import { type PortfolioState } from "./state.js";
import { type OrderExecutor } from "./order-execution.js";

export function observeClosingSignals(
  state: PortfolioState,
  index: number,
  date: string,
  execute: OrderExecutor,
) {
  const {
    request,
    market,
    strategies,
    instruments,
    accounts,
    controls,
    lastExitIndices,
    reentries,
    dailyDecisionCounts,
    pendingOrders,
    removePending,
    terminalValuations,
    observations,
    observationCounts,
    calendar,
    eligibleAt,
    pushOrder,
  } = state;
  const closeCandidates = new Map<string, BookCandidate[]>();
  for (const strategy of strategies) {
    const usesBook = usesStrategyBook(strategy);
    const candidates: BookCandidate[] = [];
    const count: (typeof dailyDecisionCounts)[number] = {
      strategyId: strategy.id,
      date,
      entries: 0,
      unknown: 0,
      ...(state.suspensionDates.size && { suspended: 0 }),
      expected: 0,
    };
    for (const [symbol, source] of instruments) {
      const eligible = eligibleAt(strategy, symbol, source, date);
      if (eligible) count.expected++;
      const i = source.indices.get(date);
      if (i === undefined) {
        if (eligible) {
          if (
            strategy.period === "day" &&
            state.suspensionDates.get(symbol)?.has(date)
          ) {
            (count.suspendedSymbols ??= []).push(symbol);
            count.suspended = count.suspendedSymbols.length;
          } else count.unknown++;
        }
        if (usesBook)
          candidates.push({
            symbol,
            bars: source.instrument.signalBars,
            external: source.instrument.external,
            decision: { entry: null, exit: null, stopLevel: null },
            eligible,
          });
        continue;
      }
      const account = accounts.get(strategy.sleeve)!,
        key = keyFor(strategy.id, symbol),
        bar = source.instrument.bars[i]!;
      const p = account.positions.get(key),
        c = controls.get(key);
      if (p && c) {
        const protection = strategyProtection(strategy, bar, c);
        const pendingSell = [...(pendingOrders.get(key) ?? [])].find(
          (o) => o.side === "sell",
        );
        const futureDelayedSell =
          pendingSell !== undefined &&
          (pendingSell.due === null ||
            Date.parse(pendingSell.due) > Date.parse(date));
        if (
          protection &&
          (!pendingSell ||
            pendingSell.exitFraction !== undefined ||
            futureDelayedSell)
        ) {
          const order =
            pendingSell ??
            pushOrder(strategy, symbol, date, date, "sell", protection.trigger);
          if (pendingSell) {
            delete order.exitFraction;
            order.targetRemainingQuantity = 0;
            order.trigger = protection.trigger;
            order.due = date;
          }
          execute(order, date, protection.price);
        }
      }
      const current = account.positions.get(key),
        control = controls.get(key);
      if (current && control) {
        current.mark = bar.close;
        control.high = Math.max(control.high, bar.high);
        control.bars++;
      }
      const terminal = source.instrument.terminal;
      if (terminal?.date === date) {
        if (current) {
          const price = terminal.valuation === "last-close" ? bar.close : 0;
          const quantity = current.quantity;
          const amount = account.terminalValue(key, price);
          terminalValuations.push({
            date,
            symbol,
            strategyId: strategy.id,
            sleeve: strategy.sleeve,
            quantity,
            price,
            amount,
            evidence: terminal.evidence,
          });
          controls.delete(key);
        }
        for (const order of [...(pendingOrders.get(key) ?? [])]) {
          order.status = "rejected";
          order.reason = "终止覆盖敏感性估值，不是市场成交";
          removePending(order);
        }
        continue;
      }
      // A held position still needs exit signals after leaving the universe.
      const decision: StrategyDecision =
        !eligible && !current
          ? { entry: null, exit: null, stopLevel: null }
          : source.evaluators.get(strategy.id)!.evaluate(
              i,
              current
                ? control?.studyEntry
                : {
                    entry: 0,
                    entryIndex: i,
                    lastExitIndex: lastExitIndices.get(key),
                  },
            );
      const timed = !!current && strategyTimeExit(strategy.exit, control!.bars);
      const fraction = (decision as { exitFraction?: number }).exitFraction;
      const partial =
        typeof fraction === "number" &&
        Number.isFinite(fraction) &&
        fraction > 0 &&
        fraction < 1 &&
        !timed;
      if (
        timed ||
        (decision.exit === true && (fraction === undefined || fraction >= 1))
      ) {
        for (const order of pendingOrders.get(key) ?? []) {
          if (
            order.side !== "sell" ||
            (order.exitFraction === undefined &&
              (order.targetRemainingQuantity ?? 0) <= 0)
          )
            continue;
          order.status = "rejected";
          order.reason = "剩余减仓委托已由收盘全平信号替代";
          removePending(order);
        }
      }
      if (eligible && (decision.entry === null || decision.exit === null))
        count.unknown++;
      if (eligible && decision.entry === true && decision.exit !== true)
        count.entries++;
      if (current && control && strategy.exit.chandelier) {
        const ratio = bar.close / source.instrument.signalBars[i]!.close;
        Object.assign(
          control,
          nextStrategyProtection(
            strategy.exit,
            control,
            bar,
            decision.chandelierStop == null
              ? null
              : decision.chandelierStop * ratio,
          ),
        );
      }
      const reentry = reentries.get(key);
      if (reentry && decision.entry === false) reentry.sawFalse = true;
      if (decision.entry === true) observationCounts[strategy.id]!.entries++;
      if (decision.exit === true) observationCounts[strategy.id]!.exits++;
      if (request.observationDetail === "full")
        observations.push({
          date,
          strategyId: strategy.id,
          symbol,
          decision,
        });
      if (usesBook) {
        candidates.push({
          symbol,
          bars: source.instrument.signalBars,
          external: source.instrument.external,
          decision: strategyReentryAllowed(
            strategy.exit,
            reentry,
            index,
            decision.entry,
          )
            ? decision
            : { ...decision, entry: false },
          eligible,
        });
      }
      if (pendingOrders.has(key)) continue;
      const side =
        current && (decision.exit === true || timed)
          ? "sell"
          : !usesBook &&
              eligible &&
              decision.entry === true &&
              strategyReentryAllowed(
                strategy.exit,
                reentry,
                index,
                decision.entry,
              ) &&
              (!current || control!.tranches < strategy.sizing.tranches)
            ? "buy"
            : null;
      if (side) {
        const next =
          calendar[index + 1 + (request.signalDelayBars ?? 0)] ??
          (!usesBook && market === "crypto" && !request.signalDelayBars
            ? nextBar(date, strategy.period)
            : null);
        const order = pushOrder(
          strategy,
          symbol,
          date,
          next,
          side,
          timed ? "time" : "signal",
        );
        if (side === "sell" && partial) order.exitFraction = fraction;
      }
    }
    if (state.collectDailyDecisionCounts) dailyDecisionCounts.push(count);
    closeCandidates.set(strategy.id, candidates);
  }
  return closeCandidates;
}
