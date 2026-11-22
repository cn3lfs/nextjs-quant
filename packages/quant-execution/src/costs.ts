import { bpsOf, type Atoms } from "./atoms.js";
import type { CostRates, OrderSide } from "./types.js";

export type FeeParts = {
  commission: Atoms;
  transfer: Atoms;
  tax: Atoms;
  total: Atoms;
};

export function feesFor(
  side: OrderSide,
  notionalAtoms: Atoms,
  rates: CostRates,
): FeeParts {
  const commission = bpsOf(notionalAtoms, rates.commissionBps);
  const transfer = bpsOf(notionalAtoms, rates.transferBps);
  const tax = side === "sell" ? bpsOf(notionalAtoms, rates.sellTaxBps) : 0n;
  const minimum = rates.minimumCommission;
  const commissionWithMinimum = commission < minimum ? minimum : commission;
  return {
    commission: commissionWithMinimum,
    transfer,
    tax,
    total: commissionWithMinimum + transfer + tax,
  };
}
