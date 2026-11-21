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
  for (const account of accounts.values())
    for (const [key, p] of account.positions) {
      const symbol = identities.get(key)!.symbol,
        source = instruments.get(symbol)!;
      const i = source.indices.get(date);
      if (i !== undefined) p.mark = source.instrument.bars[i]!.open;
    }
  for (const [sleeve, account] of accounts)
    openingEquities.set(sleeve, account.equity);
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
        a.sleeve.localeCompare(b.sleeve) ||
        (b.rankScore ?? 0) - (a.rankScore ?? 0) ||
        (request.buyTieBreak === "symbol-descending" && a.side === "buy"
          ? b.symbol.localeCompare(a.symbol)
          : a.symbol.localeCompare(b.symbol)) ||
        a.id - b.id,
    );
  pending.forEach((o) => execute(o, date));
}
