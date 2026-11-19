import type { PortfolioRequest } from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import type { StrategyBookFacts } from "trading-strategies";
import { type MarketLowZoneInput } from "trading-strategies";

export const lifecycleConfigHash =
  "b3793b9e455b5e4a563dc0ba526f43ad8854d1672f18613e604492fac68da97f";
export const lifecycleRpsPeriods = [
  18, 20, 22, 45, 50, 55, 108, 120, 132,
] as const;
export type LifecycleSourceKey = "cn-day" | "crypto-day" | "crypto-4h";
export type LifecycleFamilyAxis = {
  dailyAxis: string[];
  axisHash: string;
  sourceKeys: LifecycleSourceKey[];
  firstSignal?: string;
  warmupStart: string | null;
  warmupBars: number;
  targetThrough: string | null;
  valuationThrough: string | null;
  missing: string[];
};
export type LifecycleMarketSource = {
  request: Omit<
    PortfolioRequest,
    "strategies" | "sleeves" | "start" | "end" | "bookFacts"
  >;
  benchmark: readonly Bar[];
  bookFacts: StrategyBookFacts;
  inputHash: string;
  source: string;
  missing: string[];
  actionCoverage?: Readonly<
    Record<
      string,
      { from: string; through: string; source: string; hash: string }
    >
  >;
  rawUniverse?: { symbols: readonly string[]; source: string; hash: string };
  executionUniverse?: {
    symbols: readonly string[];
    source: string;
    hash: string;
  };
  signalBasis?: LifecycleSignalBasis;
};
export type LifecycleSignalOrigin = {
  symbol: string;
  startDate: string;
  through: string;
  anchor: { date: string; factor: number };
  rawSource: {
    format: "bar-tuples-1";
    path: string;
    hash: string;
    decodedContentHash: string;
    upstream?: unknown;
  };
  rawPrefixHash: string;
  eventsPrefixHash: string;
  factorsPrefixHash: string;
  signalPrefixHash: string;
  legacyForwardComparisonHash?: string;
};
export type LifecycleSignalBasis = {
  version: "tdx-first-raw-anchor-1";
  arithmetic: "rawOHLC*(F(t)/F(firstFrozenRawDate))";
  factorAlgorithmHash: string;
  gbbq: {
    path: string;
    hash: string;
    indexPath: string;
    indexHash: string;
    sourcePath: string;
    sourceHash: string;
    capturedAt: string;
    parserHash: string;
    parserKeyHash: string;
    runtimeHash: string;
    runtimeKeyHash: string;
    issues: unknown[];
    recordCount: number;
    bias: string;
  };
  origins: LifecycleSignalOrigin[];
};
export type LifecycleSourceBundle = {
  version: "lifecycle-source-1";
  configHash: string;
  frozenAt: string;
  inputHash: string;
  source: string;
  biasTags: string[];
  markets: Record<LifecycleSourceKey, LifecycleMarketSource>;
  families: Record<string, LifecycleFamilyAxis>;
  manifestPath: string;
  lowZoneSources: {
    indices: LifecycleLowZoneIndex[];
    membership: {
      path: string;
      hash: string;
      symbols: string[];
      basis: "current-labelled";
    } | null;
    financial: {
      path: string;
      hash: string;
      format: string;
      decoded: boolean;
      missing: string[];
    };
  };
  lowZoneInput?: MarketLowZoneInput;
};
export type LifecycleLowZoneIndex = {
  symbol: "sh000300" | "sh000001";
  role: "primary" | "diagnostic";
  bars: readonly Bar[];
  sourcePath: string;
  hash: string;
  sourceHash: string;
  missing: string[];
  archive?: {
    path: string;
    hash: string;
    decodedContentHash: string;
    pointerPath: string;
    pointerHash: string;
  };
};
export type LifecycleSourceOptions = {
  expectedConfigHash?: string;
  classicManifestPath?: string;
  reconstructionPath?: string;
  expectedRawPoolSize?: number;
  executionCapture?: {
    equityPointerPath: string;
    rosterPointerPath: string;
    correctionPath: string;
    expectedEquityHash: string;
    expectedRosterHash: string;
    expectedExecutionCount: number;
    excludedSymbols: readonly string[];
  };
  binanceRoot?: string;
  industryRoot?: string | null;
  expectedIndustryHash?: string;
  tdxRoot?: string | null;
  lowZoneMembershipPath?: string | null;
  expectedLowZoneMembershipHash?: string;
  /** Full original 799 financial decode is a separate budgeted source read. */
  decodeLowZoneFinancials?: boolean;
  gbbqPath?: string;
  expectedGbbqHash?: string;
  terminalStatusPath?: string | null;
  outputRoot?: string;
  now?: number;
};

export type SourceStage = (stage: string) => Promise<void>;
