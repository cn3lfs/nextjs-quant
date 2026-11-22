export type PortfolioLot = {
  quantity: number;
  bought: string;
  availableOn?: string;
};
export type PortfolioPosition = {
  quantity: number;
  cost: number;
  mark: number;
  lots: PortfolioLot[];
  bought: string;
};
export type PortfolioAction = {
  date: string;
  dividend: number;
  bonus: number;
  /** Split/consolidation multiplier, independent of bonus shares. */
  shareFactor?: number;
  rightsRatio?: number;
  rightsPrice?: number;
  evidence: string;
  availableAt: string;
  sharesSellableAt?: string;
} & (
  | {
      cashAvailableAt: string;
      timingAssumption: "ex-date-research-scenario";
    }
  | {
      /** Broker ledger: pay date and listing date are external evidence. */
      timingAssumption: "broker-ledger";
      cashAvailableAt?: string;
      sharesSellableAt?: string;
    }
  // Historical frozen inputs predate explicit timing disclosure.
  | { cashAvailableAt?: never; timingAssumption?: never }
);
export function actionPrice(price: number, action: PortfolioAction) {
  return (
    (price -
      action.dividend +
      (action.rightsRatio ?? 0) * (action.rightsPrice ?? 0)) /
    ((1 + action.bonus + (action.rightsRatio ?? 0)) * (action.shareFactor ?? 1))
  );
}
