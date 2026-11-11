/** Provider-neutral annual amounts. Adapters validate periods, visibility and units. */
export type FinancialAnnualKey =
  | "revenue"
  | "operatingCost"
  | "netProfit"
  | "parentProfit"
  | "minorityProfit"
  | "assets"
  | "equity"
  | "currentAssets"
  | "currentLiabilities"
  | "operatingCashFlow";

export type AnnualAmountPoint = {
  field: string;
  raw: unknown;
  rawUnit: string | null;
  value: number | null;
  currency: "CNY" | null;
  reasons: string[];
  evidenceId: string;
};
export type AnnualAmount = {
  value: number | null;
  currency: "CNY" | null;
  points: AnnualAmountPoint[];
  reasons: string[];
};
export type FinancialAnnualInput = {
  /** Strictly ascending, unique complete year ends, YYYY1231; no gap filling. */
  annual: {
    period: string;
    amountUnit: "yuan";
    amounts: Record<FinancialAnnualKey, AnnualAmount>;
  }[];
  rejected: { field: string; evidenceId: string; reason: string }[];
};
export type NumberFact = {
  value: number | null;
  currencyBasis: "CNY" | "source-yuan-unspecified" | null;
  citations: string[];
  formula: string;
  missing: string[];
};
export type QualityAnnual = {
  period: string;
  amounts: Record<FinancialAnnualKey, AnnualAmount>;
  netProfit: NumberFact;
  averageAssets: NumberFact;
  averageEquity: NumberFact;
  ratios: Record<
    | "netMargin"
    | "assetTurnover"
    | "equityMultiplier"
    | "roe"
    | "reportedProfitRoa"
    | "grossMargin"
    | "currentRatio"
    | "cashToProfit"
    | "cashReturnOnOpeningAssets",
    NumberFact
  >;
};
export type QualityFacts = {
  version: string;
  symbol: string;
  annual: QualityAnnual[];
  rejected: FinancialAnnualInput["rejected"];
  fScore: {
    period: string | null;
    total: null;
    knownPoints: number;
    knownCount: number;
    items: {
      id: string;
      point: 0 | 1 | null;
      citations: string[];
      reason: string;
    }[];
  };
  warnings: string[];
};
