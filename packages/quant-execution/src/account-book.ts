type Scalar = number | bigint;
type Lot<N> = { quantity: N };
type Holding<N, L> = { quantity: N; mark: N; cost: N; lots: L[] };

/** Mutable ledger state shared by market-atom execution and decimal research
 * settlement. Cost is total basis in atoms, average unit basis in replay. */
export class AccountBook<
  N extends Scalar,
  L extends Lot<N>,
  P extends Holding<N, L>,
> {
  readonly positions = new Map<string, P>();
  constructor(
    public cash: N,
    private readonly units: {
      zero: N;
      add(a: N, b: N): N;
      subtract(a: N, b: N): N;
      keepLot(quantity: N): boolean;
      keepPosition(quantity: N): boolean;
    },
  ) {}

  postFill(
    symbol: string,
    side: "buy" | "sell",
    quantity: N,
    price: N,
    nextCash: N,
    available: (lot: L) => boolean,
    buyLot: () => L,
    buyPosition: (prior: P | undefined, quantity: N, lots: L[]) => P,
    saleBasis: (prior: P, remaining: N) => N,
  ) {
    const prior = this.positions.get(symbol);
    if (side === "buy") {
      const total = this.units.add(
        prior?.quantity ?? this.units.zero,
        quantity,
      );
      this.positions.set(
        symbol,
        buyPosition(prior, total, [...(prior?.lots ?? []), buyLot()]),
      );
    } else if (prior) {
      let remaining = quantity;
      for (const lot of prior.lots) {
        if (!available(lot)) continue;
        const sold = lot.quantity < remaining ? lot.quantity : remaining;
        lot.quantity = this.units.subtract(lot.quantity, sold);
        remaining = this.units.subtract(remaining, sold);
        if (remaining === this.units.zero) break;
      }
      prior.lots = prior.lots.filter((lot) => this.units.keepLot(lot.quantity));
      const total = this.units.subtract(prior.quantity, quantity);
      prior.cost = saleBasis(prior, total);
      prior.quantity = total;
      prior.mark = price;
      if (!this.units.keepPosition(total)) this.positions.delete(symbol);
    }
    this.cash = nextCash;
  }

  postAction(symbol: string, position: P, nextCash: N, effect: Holding<N, L>) {
    Object.assign(position, effect);
    this.cash = nextCash;
    if (effect.quantity <= this.units.zero) this.positions.delete(symbol);
  }
}
