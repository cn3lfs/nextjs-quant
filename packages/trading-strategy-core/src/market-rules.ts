import { defaultExecutionCosts, type ExecutionCosts } from "./costs.js";
export type Market = "cn-equity" | "crypto" | "futures";
export type Instrument = { market: Market; symbol: string };
export type MarketRules = {
  calendar: "exchange" | "continuous" | "contract";
  timezone: string | null;
  sessions: readonly (readonly [string, string])[] | null;
  settlementDays: 0 | 1;
  quantity: {
    kind: "lot" | "venue-step" | "contract";
    minimum: number | null;
    step: number | null;
  };
  priceLimits: "cn-board" | "none" | "contract";
  costs: ExecutionCosts | null;
  shorting: boolean;
};
/** Templates are experimental costs, never asserted historical/venue charges.
 * Null contract/venue fields require instrument evidence before execution. */
export const marketRules: Readonly<Record<Market, MarketRules>> = {
  "cn-equity": {
    calendar: "exchange",
    timezone: "Asia/Shanghai",
    sessions: [
      ["09:30", "11:30"],
      ["13:00", "15:00"],
    ],
    settlementDays: 1,
    quantity: { kind: "lot", minimum: 100, step: 100 },
    priceLimits: "cn-board",
    costs: defaultExecutionCosts,
    shorting: false,
  },
  crypto: {
    calendar: "continuous",
    timezone: "UTC",
    sessions: [["00:00", "24:00"]],
    settlementDays: 0,
    quantity: { kind: "venue-step", minimum: null, step: null },
    priceLimits: "none",
    costs: {
      ...defaultExecutionCosts,
      commissionBps: 10,
      minimumCommission: 0,
      sellTaxBps: 0,
    },
    shorting: false,
  },
  futures: {
    calendar: "contract",
    timezone: null,
    sessions: null,
    settlementDays: 0,
    quantity: { kind: "contract", minimum: 1, step: 1 },
    priceLimits: "contract",
    costs: null,
    shorting: true,
  },
};
export const rulesFor = (instrument: Instrument) =>
  marketRules[instrument.market];

/** Explicit research scenarios, not historical ST/IPO or queue certification. */
export const openingQuoteProfiles = {
  conservative: {
    limitTolerance: 0.000001,
    exclusiveLimit: false,
    rejectOnePrice: true,
  },
  "allocation-scenario": {
    limitTolerance: 0.001,
    exclusiveLimit: true,
    rejectOnePrice: false,
  },
} as const;
const equityResearchBoards = [
  { prefixes: ["sh688"], from: "", minimum: 200, step: 1, limit: 0.2 },
  {
    prefixes: ["sz30"],
    from: "2020-08-24",
    minimum: 100,
    step: 100,
    limit: 0.2,
  },
  { prefixes: [""], from: "", minimum: 100, step: 100, limit: 0.1 },
] as const;
export function equityResearchRules(symbol: string, date: string) {
  return equityResearchBoards.find(
    (row) =>
      date >= row.from &&
      row.prefixes.some((prefix) => symbol.startsWith(prefix)),
  )!;
}
