import { transferStrategyBook } from "trading-strategies";
import { big } from "trading-strategy-core/money";
import { type PortfolioState } from "./state.js";

export function rebalanceAndMarkEquity(
  state: PortfolioState,
  index: number,
  date: string,
) {
  const {
    request,
    sleeves,
    strategies,
    accounts,
    bookStates,
    observationDay,
    identities,
    transfers,
    curve,
    positionSnapshots,
    daily,
  } = state;
  if (request.rebalance) {
    const target = request.sleeveTargets
      ?.filter((t) => t.date <= date)
      .sort((a, b) => a.date.localeCompare(b.date))
      .at(-1);
    const targets = sleeves.map((s) => ({
      ...s,
      share: target?.shares[s.id] ?? s.share,
    }));
    const total = [...accounts.values()].reduce((n, a) => n + a.equity, 0);
    const due =
      request.rebalance.everyBars !== undefined &&
      (index + 1) % request.rebalance.everyBars === 0;
    const drift =
      request.rebalance.drift !== undefined &&
      targets.some(
        (s) =>
          Math.abs(accounts.get(s.id)!.equity / total - s.share) >=
          request.rebalance!.drift!,
      );
    if (due || drift || target?.date === date) {
      let poolAtoms = 0n;
      for (const s of targets) {
        const a = accounts.get(s.id)!,
          excess = Math.max(0, a.equity - total * s.share);
        if (excess > 0 && a.cashAtoms > 0n) {
          const moved = a.transferOutUpToCash(excess);
          if (moved.atoms > 0n) {
            poolAtoms += moved.atoms;
            transfers.push({ date, sleeve: s.id, amount: -moved.amount });
            for (const strategy of strategies.filter(
              (v) => v.sleeve === s.id,
            )) {
              const state = bookStates.get(strategy.id);
              if (state)
                bookStates.set(
                  strategy.id,
                  transferStrategyBook(state, -moved.amount),
                );
            }
          }
        }
      }
      const needs = targets.map((s) => ({
        s,
        need: Math.max(0, total * s.share - accounts.get(s.id)!.equity),
      }));
      const totalNeed = needs.reduce((n, x) => n + x.need, 0);
      if (poolAtoms > 0n && totalNeed > 0) {
        let allocatedAtoms = 0n;
        needs
          .filter((x) => x.need > 0)
          .forEach((x, i, all) => {
            const receiver = accounts.get(x.s.id)!;
            const step = receiver.cashTransferStep;
            const remaining = poolAtoms - allocatedAtoms;
            const rawShare =
              i === all.length - 1
                ? remaining
                : BigInt(
                    big(poolAtoms.toString())
                      .times(x.need)
                      .div(totalNeed)
                      .toFixed(0, 0),
                  );
            const quantized =
              i === all.length - 1 ? remaining : (rawShare / step) * step;
            const clamped = quantized > remaining ? remaining : quantized;
            if (clamped <= 0n) return;
            const amount = receiver.transferAtoms(clamped);
            allocatedAtoms += clamped;
            transfers.push({ date, sleeve: x.s.id, amount });
            for (const strategy of strategies.filter(
              (v) => v.sleeve === x.s.id,
            )) {
              const state = bookStates.get(strategy.id);
              if (state)
                bookStates.set(
                  strategy.id,
                  transferStrategyBook(state, amount),
                );
            }
          });
      }
    }
  }
  const rows = sleeves.map((s) => ({
    id: s.id,
    cash: accounts.get(s.id)!.cash,
    equity: accounts.get(s.id)!.equity,
  }));
  const row = {
    date,
    cash: rows.reduce((n, s) => n + s.cash, 0),
    equity: rows.reduce((n, s) => n + s.equity, 0),
    sleeves: rows,
  };
  curve.push(row);
  for (const [sleeve, account] of accounts)
    for (const [key, position] of account.positions) {
      const identity = identities.get(key)!;
      positionSnapshots.push({
        date,
        symbol: identity.symbol,
        strategyId: identity.strategyId,
        sleeve,
        quantity: position.quantity,
        weight:
          row.equity > 0 ? (position.quantity * position.mark) / row.equity : 0,
      });
    }
  daily.set(observationDay(date), { ...row, date: observationDay(date) });
}
export function portfolioResult(state: PortfolioState) {
  const {
    request,
    accounts,
    bookStates,
    bookDecisions,
    lifecycle,
    dailyDecisionCounts,
    identities,
    orders,
    fills,
    rejections,
    transfers,
    corporateActions,
    terminalValuations,
    observations,
    observationCounts,
    curve,
    positionSnapshots,
    daily,
  } = state;
  return {
    version: "portfolio-event-1" as const,
    quality: "rule-check-only" as const,
    orders,
    fills,
    rejections,
    positions: [...accounts].flatMap(([sleeve, a]) =>
      [...a.positions].map(([key, p]) => ({
        sleeve,
        key,
        ...identities.get(key)!,
        ...p,
        lots: p.lots.map((l) => ({ ...l })),
      })),
    ),
    equity: [...daily.values()],
    curve,
    positionSnapshots,
    observations,
    ...(request.observationDetail !== "full" ? { observationCounts } : {}),
    transfers,
    corporateActions,
    terminalValuations,
    ...(lifecycle
      ? {
          bookDecisions,
          bookStates: Object.fromEntries(bookStates),
          dailyDecisionCounts,
        }
      : {}),
  };
}
