import {
  type StrategyObjectInput,
  type StrategyExternalInputs,
  type StrategyBookFacts,
} from "trading-strategies";
import { type Bar } from "trading-strategy-core/bars";
import { type ExecutionCosts } from "trading-strategy-core/costs";
import { type PortfolioAction } from "../portfolio-account.js";

export type Market = "cn-equity" | "crypto";
export type PortfolioExecution = {
  slippagePolicy?: "reject" | "clamp" | "none";
  evidence: string;
  minimum?: number;
  step?: number;
  maximum?: number;
  limitUp: number | null;
  limitDown: number | null;
  tradable: boolean;
};
export type PortfolioInstrument = {
  symbol: string;
  market: Market;
  bars: readonly Bar[];
  /** Already adjusted at a fixed historical denominator; never used for fills. */
  signalBars: readonly Bar[];
  /** Ex-post daily scoring evidence only. Include the real resumption date
   * so a shorter replay cannot inherit a full-history certification. */
  certifiedSuspensions?: readonly {
    symbol: string;
    date: string;
    resumptionDate: string;
  }[];
  /** A local pure facts adapter may quote from frozen bars on demand. It is
   * reconstructed by the research loader, never serialized as executable code. */
  execution:
    | PortfolioExecution
    | Readonly<Record<string, PortfolioExecution>>
    | ((
        bar: Readonly<Bar> | undefined,
        previous: Readonly<Bar> | undefined,
      ) => PortfolioExecution | undefined);
  external?: StrategyExternalInputs;
  /** Explicit survivorship sensitivity only; never claimed as a historical fill. */
  terminal?: {
    date: string;
    valuation: "last-close" | "total-loss";
    evidence: string;
  };
  /** Research scenario timing or the original shape of a historical frozen action. */
  actions?: readonly PortfolioAction[];
};
export type PortfolioSleeve = {
  id: string;
  share: number;
  riskPerTrade: number;
  maxPositions: number;
};
export type PortfolioRequest = {
  /** Defaults to "counts". Only "full" retains per-bar observations. */
  observationDetail?: "full" | "counts";
  /** Research sensitivity only. Equal-score buys default to ascending symbols. */
  buyTieBreak?: "symbol-ascending" | "symbol-descending";
  market: Market;
  initial: number;
  start: string;
  end: string;
  calendar: readonly string[];
  instruments: readonly PortfolioInstrument[];
  strategies: readonly StrategyObjectInput[];
  sleeves: readonly PortfolioSleeve[];
  costs?: ExecutionCosts;
  maxParticipation?: number;
  accountMaxUniqueSymbols?: number;
  accountMaxSymbolWeight?: number;
  collectDailyDecisionCounts?: boolean;
  capacityPolicy?: "clip" | "reject";
  bookFacts?: Readonly<Record<string, StrategyBookFacts>>;
  /** A completed pre-start weekly signal seeds only next-session orders; no warmup equity is scored. */
  bookSeeds?: readonly {
    strategyId: string;
    date: string;
    availableAt: string;
    selectionFrom?: string;
    /** Paper registration may occur after the seed's next open. The selection
     * feature still warms up, but an already missed execution is never replayed. */
    emitOrders?: boolean;
    /** Exact prior weekly buffer feature, without positions, capital or DD. */
    previousSelected?: {
      date: string;
      availableAt: string;
      symbols: readonly string[];
      sourceHash: string;
    };
  }[];
  rebalance?: { everyBars?: number; drift?: number };
  /** Completed-bar targets; only idle cash is transferred, never forced sales. */
  sleeveTargets?: readonly {
    date: string;
    availableAt: string;
    shares: Readonly<Record<string, number>>;
  }[];
  /** Stress discretionary entry/exit signals; standing protection remains active. */
  signalDelayBars?: 0 | 1;
  /** PIT memberships for rule universes. Missing is unknown, never all-market. */
  memberships?: readonly {
    strategyId: string;
    date: string;
    availableAt: string;
    symbols: readonly string[];
  }[];
  /** Explicit causal research weight ceilings; absent row forbids entry. */
  positionWeights?: readonly {
    strategyId: string;
    symbol: string;
    date: string;
    availableAt: string;
    weight: number;
  }[];
  /** Frozen completed-day allocations. Weights are fractions of sleeve equity,
   * not buy ceilings; absent symbols are liquidated at the next legal open. */
  scheduledTargets?: readonly {
    strategyId: string;
    date: string;
    availableAt: string;
    sourceHash: string;
    targets: Readonly<Record<string, number>>;
    /** Higher scores get buy priority when targets compete for cash or slots. */
    scores?: Readonly<Record<string, number>>;
  }[];
};
export type PortfolioOrder = {
  id: number;
  strategyId: string;
  sleeve: string;
  symbol: string;
  side: "buy" | "sell";
  signalAt: string;
  due: string | null;
  status: "pending" | "filled" | "rejected";
  reason: string | null;
  attempts: number;
  exitFraction?: number;
  targetRemainingQuantity?: number;
  capacityClipped?: true;
  trigger: "signal" | "stop" | "target" | "trailing" | "time";
  rankScore?: number;
  weightCeiling?: number;
  targetWeight?: number;
  targetSourceHash?: string;
  industries?: Record<string, string[]>;
  riskGroups?: string[][];
  marketTargetShare?: number;
};
export type PortfolioFill = {
  orderId: number;
  strategyId: string;
  sleeve: string;
  symbol: string;
  side: "buy" | "sell";
  signalAt: string;
  date: string;
  price: number;
  quantity: number;
  fee: number;
  cashAfter: number;
  holdingAfter: number;
  capacityClipped?: true;
  executionEvidence?: {
    intendedPrice: number;
    slippageBps: number;
    source: "portfolio-OHLC-model";
  };
};
export type PositionControl = {
  studyEntry?: {
    entry: number;
    entryIndex: number;
    signalIndex: number;
    lastExitIndex?: number;
  };
  stop: number | null;
  entry: number;
  high: number;
  target: number | null;
  bars: number;
  tranches: number;
};
