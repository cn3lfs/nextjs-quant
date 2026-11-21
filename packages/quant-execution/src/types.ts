import type { Atoms, Market } from "./atoms.js";

export type OrderSide = "buy" | "sell";
export type TimeInForce = "next-open" | "day";

export type OrderIntent = {
  id: string;
  symbol: string;
  side: OrderSide;
  quantity: Atoms;
  due?: string;
  tif?: TimeInForce;
  note?: string;
};

export type ExecutionQuote = {
  date: string;
  open: Atoms;
  high: Atoms;
  low: Atoms;
  close: Atoms;
  volume: Atoms;
  tradable: boolean;
  limitUp?: Atoms | null;
  limitDown?: Atoms | null;
};

export type Fill = {
  orderId: string;
  symbol: string;
  side: OrderSide;
  date: string;
  quantity: Atoms;
  price: Atoms;
  gross: Atoms;
  commission: Atoms;
  transfer: Atoms;
  tax: Atoms;
  cashDelta: Atoms;
};

export type Rejection = {
  orderId: string;
  symbol: string;
  date: string;
  reason: string;
};

export type PositionLot = {
  quantity: Atoms;
  price: Atoms;
  acquiredAt: string;
  sellableAt: string;
};

export type PositionState = {
  symbol: string;
  quantity: Atoms;
  cost: Atoms;
  mark: Atoms;
  lots: PositionLot[];
};

export type AccountState = {
  cash: Atoms;
  positions: PositionState[];
};

export type CorporateActionEffect = {
  date: string;
  symbol: string;
  cashPerShare: Atoms;
  shareFactor: number;
  shareDelta: Atoms;
  /** Required for newly credited shares. */
  sharesSellableAt?: string;
  evidence: string;
};

export type CostRates = {
  commissionBps: number;
  minimumCommission: Atoms;
  transferBps: number;
  sellTaxBps: number;
  dividendTaxBps?: number;
  slippageBps: number;
};

export type ExecutionEvent =
  | { type: "submitted"; order: OrderIntent }
  | { type: "filled"; fill: Fill }
  | { type: "rejected"; rejection: Rejection }
  | { type: "corporate-action"; effect: CorporateActionEffect; cash: Atoms }
  | { type: "external-fill"; fill: Fill };
