import { transferStrategyBook } from "trading-strategies";
import { big } from "trading-strategy-core/money";
import { drawdownReductionScale, evaluatePortfolioRisk } from "quant-execution";
import { accountDate } from "./clock.js";
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
  if (state.riskAudit) {
    // A truncated intraday replay cannot count its last observation as a completed session.
    const intraday = strategies.some((strategy) =>
      /^\d+[mh]$/.test(strategy.period),
    );
    const endTime = accountDate(date, state.market).slice(11, 19);
    const day = observationDay(date);
    if (
      !intraday ||
      endTime === (state.market === "cn-equity" ? "15:00:00" : "00:00:00")
    ) {
      const previous = state.riskAudit.daily.at(-1);
      const missingMark = [...accounts.values()].some((account) =>
        [...account.positions.keys()].some((key) => {
          const symbol = identities.get(key)!.symbol;
          // The later resumption certificate is ex-post scoring evidence.
          // It cannot qualify a recovery close for the next day's live decision.
          return !state.instruments.get(symbol)!.indices.has(date);
        }),
      );
      if (missingMark) {
        state.riskAudit.missingCloses.push(day);
        return;
      }
      if (day === previous?.date) return;
      const current = evaluatePortfolioRisk({
        date: day,
        unitNav: row.equity / state.units,
        previous,
        previousSessionDate: state.previousRiskSession.get(day),
        policy: request.riskPolicy,
      });
      state.riskAudit.daily.push(current);
      const retainedScale = drawdownReductionScale(previous, current);
      if (retainedScale === null) return;

      const due = state.calendar[index + 1] ?? null;
      const strategyById = new Map(strategies.map((s) => [s.id, s]));
      for (const account of accounts.values()) {
        for (const [key, position] of account.positions) {
          const { symbol, strategyId } = identities.get(key)!;
          const order = state.pushOrder(
            strategyById.get(strategyId)!,
            symbol,
            date,
            due,
            "sell",
            "signal",
          );
          order.drawdownReduction = true;
          // Freeze the remaining quantity at the trigger close. Retries sell
          // only the outstanding amount, using the existing settlement and lot rules.
          const target = big(position.quantity).times(retainedScale);
          order.targetRemainingQuantity =
            state.market === "cn-equity"
              ? target.round(0, 3).toNumber()
              : target.toNumber();
          order.exitFraction = 1 - retainedScale;
          state.riskAudit.reductions.push({
            orderId: order.id,
            date: day,
            symbol,
            quantityBefore: position.quantity,
            retainedScale,
          });
        }
      }
    }
  }
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
    ...(state.riskAudit && { riskAudit: state.riskAudit }),
    ...(request.externalCashFlows?.length && {
      externalCashFlows: request.externalCashFlows,
    }),
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
