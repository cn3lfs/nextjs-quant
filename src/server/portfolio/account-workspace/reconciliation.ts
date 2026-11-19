import { type AccountPosition } from "~/lib/portfolio/account-workspace";

function sumKnown(values: readonly (number | null)[]) {
  if (!values.length || values.includes(null)) return null;
  return values.reduce<number>((sum, value) => sum + value!, 0);
}

export function reconcileRealHoldings(
  positions: readonly AccountPosition[],
  names: ReadonlyMap<string, string | null> = new Map(),
) {
  const symbols = new Map<
    string,
    { delivery: AccountPosition[]; local: AccountPosition[] }
  >();
  for (const position of positions) {
    if (position.kind !== "real" || position.quantity === 0) continue;
    const source = position.id.split(":", 1)[0];
    if (source !== "local" && source !== "delivery") continue;
    const key = [position.currency, position.market, position.symbol].join(":");
    const group = symbols.get(key) ?? { delivery: [], local: [] };
    group[source].push(position);
    symbols.set(key, group);
  }
  const rows = [...symbols.values()].map(({ delivery, local }) => {
    const all = [...delivery, ...local],
      position = all[0]!;
    const amounts = (items: AccountPosition[]) =>
      sumKnown(items.map((p) => (p.price === null ? null : p.value)));
    const deliveryValue = amounts(delivery),
      localValue = amounts(local);
    const overlap = delivery.length > 0 && local.length > 0;
    const grossTotal = amounts(all);
    return {
      market: position.market,
      symbol: position.symbol,
      name: names.get(position.symbol) ?? null,
      currency: position.currency,
      deliveryValue,
      localValue,
      deliveryQuantity: delivery.reduce((n, p) => n + p.quantity, 0),
      localQuantity: local.reduce((n, p) => n + p.quantity, 0),
      grossTotal,
      lowerBound:
        grossTotal === null
          ? null
          : overlap
            ? Math.max(deliveryValue!, localValue!)
            : grossTotal,
      upperBound: grossTotal,
      overlap,
    };
  });
  const summaryByCurrency = (["CNY", "USDT"] as const).map((currency) => {
    const group = rows.filter((r) => r.currency === currency);
    return {
      currency,
      grossTotal: sumKnown(group.map((r) => r.grossTotal)),
      deduplicatedLowerBound: sumKnown(group.map((r) => r.lowerBound)),
      deliveryTotal: sumKnown(
        group
          .filter((r) => r.deliveryQuantity !== 0)
          .map((r) => r.deliveryValue),
      ),
      localTotal: sumKnown(
        group.filter((r) => r.localQuantity !== 0).map((r) => r.localValue),
      ),
      overlapCount: group.filter((r) => r.overlap).length,
    };
  });
  return {
    overlapSymbols: rows.filter((row) => row.overlap),
    summaryByCurrency,
    industryLimitBasis: "upper-bound" as const,
  };
}
