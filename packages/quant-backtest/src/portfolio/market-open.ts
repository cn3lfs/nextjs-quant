import { transferStrategyBook } from "trading-strategies";
import { actionPrice } from "../portfolio-account.js";
import { keyFor } from "./preparation.js";
import { type PortfolioState } from "./state.js";
import { type OrderExecutor } from "./order-execution.js";

export function applyCorporateActions(state: PortfolioState, date: string) {
  const {
    market,
    strategies,
    accounts,
    controls,
    corporateActions,
    actionsAt,
  } = state;
  for (const account of accounts.values()) account.settlePendingCash(date);
  for (const { instrument, action } of actionsAt.get(date) ?? []) {
    for (const strategy of strategies) {
      const account = accounts.get(strategy.sleeve)!,
        key = keyFor(strategy.id, instrument.symbol),
        p = account.positions.get(key);
      if (!p) continue;
      const applied = account.corporateAction(
        key,
        action,
        market === "cn-equity",
        state.costs.dividendTaxBps ?? 0,
      )!;
      corporateActions.push({
        date,
        symbol: instrument.symbol,
        strategyId: strategy.id,
        evidence: action.evidence,
        ...applied,
      });
      if (applied.quantity !== applied.before) {
        for (const order of state.pendingOrders.get(key) ?? []) {
          if (
            order.side === "sell" &&
            order.targetRemainingQuantity !== undefined
          ) {
            const scaled =
              (order.targetRemainingQuantity * applied.quantity) /
              applied.before;
            // Keep at least the frozen remainder when only whole shares exist.
            order.targetRemainingQuantity =
              market === "cn-equity" ? Math.ceil(scaled) : scaled;
          }
        }
      }
      const c = controls.get(key)!;
      for (const field of ["entry", "high", "stop", "target"] as const)
        if (c[field] !== null) c[field] = actionPrice(c[field]!, action);
      if (!applied.quantity) controls.delete(key);
    }
  }
}
export function matchOpeningOrders(
  state: PortfolioState,
  date: string,
  execute: OrderExecutor,
) {
  const {
    request,
    instruments,
    accounts,
    openingEquities,
    identities,
    pendingOrders,
  } = state;
  state.dailyCapacityUsed.clear();
  const flows = state.flowsAt.get(date);
  for (const account of accounts.values())
    for (const [key, p] of account.positions) {
      const symbol = identities.get(key)!.symbol,
        source = instruments.get(symbol)!;
      const i = source.indices.get(date);
      if (i !== undefined) p.mark = source.instrument.bars[i]!.open;
      else if (flows)
        throw new Error("Missing opening valuation for external cash flow");
    }
  if (flows) {
    const equity = [...accounts.values()].reduce(
      (sum, account) => sum + account.equity,
      0,
    );
    const totalFlow = [...flows.values()].reduce(
      (sum, amount) => sum + amount,
      0,
    );
    const unitsAfter = state.units * ((equity + totalFlow) / equity);
    if (
      !(equity > 0 && equity + totalFlow > 0) ||
      !Number.isFinite(unitsAfter) ||
      unitsAfter <= 0 ||
      [...flows].some(
        ([sleeve, amount]) => accounts.get(sleeve)!.cash + amount < 0,
      )
    )
      throw new Error("External flow exceeds cash or exhausts portfolio units");
    // Issue and redeem units at the same pre-flow opening NAV across sleeves.
    state.units = unitsAfter;
    for (const [sleeve, amount] of flows) {
      accounts.get(sleeve)!.transfer(amount);
      for (const strategy of state.strategies) {
        if (strategy.sleeve !== sleeve) continue;
        const book = state.bookStates.get(strategy.id);
        if (book)
          state.bookStates.set(strategy.id, transferStrategyBook(book, amount));
      }
    }
  }
  for (const [sleeve, account] of accounts)
    openingEquities.set(sleeve, account.equity);
  const accountLimits =
    request.riskPolicy !== undefined ||
    request.accountMaxUniqueSymbols !== undefined ||
    request.accountMaxSymbolWeight !== undefined;
  const pending = [...pendingOrders.values()]
    .flatMap((active) => [...active])
    .filter(
      (o) =>
        o.status === "pending" &&
        o.due !== null &&
        Date.parse(o.due) <= Date.parse(date),
    )
    .map((order) => {
      if (order.targetWeight !== undefined) {
        const account = accounts.get(order.sleeve)!,
          p = account.positions.get(keyFor(order.strategyId, order.symbol));
        const actual = p
          ? (p.quantity * p.mark) / openingEquities.get(order.sleeve)!
          : 0;
        order.side = actual > order.targetWeight ? "sell" : "buy";
      }
      return order;
    })
    .sort(
      (a, b) =>
        (a.side === "sell" ? 0 : 1) - (b.side === "sell" ? 0 : 1) ||
        (accountLimits ? 0 : a.sleeve.localeCompare(b.sleeve)) ||
        (b.rankScore ?? 0) - (a.rankScore ?? 0) ||
        (request.buyTieBreak === "symbol-descending" && a.side === "buy"
          ? b.symbol.localeCompare(a.symbol)
          : a.symbol.localeCompare(b.symbol)) ||
        (accountLimits
          ? a.sleeve.localeCompare(b.sleeve) ||
            a.strategyId.localeCompare(b.strategyId)
          : 0) ||
        a.id - b.id,
    );
  const reducedSymbols = new Set(
    pending.filter((o) => o.drawdownReduction).map((o) => o.symbol),
  );
  const activePending = pending.filter((order) => {
    if (
      !order.drawdownReduction &&
      order.side === "buy" &&
      reducedSymbols.has(order.symbol)
    ) {
      state.reject(order, date, "回撤减仓同日禁止反手买入");
      return false;
    }
    return true;
  });
  if (!request.executionSlices && !request.executionQuote) {
    activePending.forEach((o) => execute(o, date));
    return;
  }
  // Account reductions are due at the legal open, before delayed strategy windows.
  const windowOrders: typeof activePending = [];
  for (const order of activePending) {
    if (order.drawdownReduction) execute(order, date);
    else windowOrders.push(order);
  }
  if (request.executionSlices)
    execute.executeSlices(windowOrders, date, request.executionSlices);
  else windowOrders.forEach((o) => execute(o, date));
}
