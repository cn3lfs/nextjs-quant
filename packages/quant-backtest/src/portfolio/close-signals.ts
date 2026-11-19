import {
  strategyProtection,
  strategyTimeExit,
  usesStrategyBook,
  nextStrategyProtection,
  strategyReentryAllowed,
  type BookCandidate,
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
    lifecycle,
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
    const candidates: BookCandidate[] = [];
    const count = {
      strategyId: strategy.id,
      date,
      entries: 0,
      unknown: 0,
      expected: 0,
    };
    for (const [symbol, source] of instruments) {
      const eligible = eligibleAt(strategy, symbol, source, date);
      if (eligible) count.expected++;
      const i = source.indices.get(date);
      if (i === undefined) {
        if (eligible) count.unknown++;
        if (usesStrategyBook(strategy))
          candidates.push({
            symbol,
            bars: source.instrument.signalBars,
            external: source.instrument.external,
            decision: { entry: null, exit: null, stopLevel: null },
            eligible: eligibleAt(strategy, symbol, source, date),
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
        if (
          protection &&
          ![...(pendingOrders.get(key) ?? [])].some((o) => o.side === "sell")
        ) {
          const order = pushOrder(
            strategy,
            symbol,
            date,
            date,
            "sell",
            protection.trigger,
          );
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
      const decision = source.evaluators.get(strategy.id)!.evaluate(
        i,
        current
          ? control?.studyEntry
          : {
              entry: 0,
              entryIndex: i,
              lastExitIndex: lastExitIndices.get(key),
            },
      );
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
      if (request.observationDetail !== "counts")
        observations.push({
          date,
          strategyId: strategy.id,
          symbol,
          decision,
        });
      if (usesStrategyBook(strategy)) {
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
        if (
          current &&
          (decision.exit === true ||
            strategyTimeExit(strategy.exit, control!.bars)) &&
          !pendingOrders.has(key)
        ) {
          const timed = strategyTimeExit(strategy.exit, control!.bars);
          pushOrder(
            strategy,
            symbol,
            date,
            calendar[index + 1 + (request.signalDelayBars ?? 0)] ?? null,
            "sell",
            timed ? "time" : "signal",
          );
        }
        continue;
      }
      if (pendingOrders.has(key)) continue;
      const timed = !!current && strategyTimeExit(strategy.exit, control!.bars);
      const side =
        current && (decision.exit === true || timed)
          ? "sell"
          : eligible &&
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
          (market === "crypto" && !request.signalDelayBars
            ? nextBar(date, strategy.period)
            : null);
        pushOrder(
          strategy,
          symbol,
          date,
          next,
          side,
          timed ? "time" : "signal",
        );
      }
    }
    if (lifecycle) dailyDecisionCounts.push(count);
    closeCandidates.set(strategy.id, candidates);
  }
  return closeCandidates;
}
