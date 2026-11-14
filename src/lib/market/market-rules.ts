import { computePriceLimits, type PriceLimitInput } from "tstdx/market-rules";
import {
  defaultExecutionCosts,
  type ExecutionCosts,
} from "quant-backtest/costs";
import { marketSession } from "./market-session";
import type { Instrument, Market } from "./instrument";

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
export function sessionFor(
  instrument: Instrument,
  now: number,
  trading: "open" | "closed" | "unknown" = "unknown",
) {
  const rule = rulesFor(instrument);
  if (rule.calendar === "continuous")
    return { kind: "continuous", label: "7×24交易" };
  if (rule.calendar === "exchange") return marketSession(now, trading);
  return { kind: "unknown", label: "需合约交易时段" };
}
export function priceLimitsFor(
  instrument: Instrument,
  preClose: number,
  options: PriceLimitInput & { ruleDate: number },
) {
  const rule = rulesFor(instrument);
  if (rule.priceLimits === "cn-board")
    return computePriceLimits(instrument.symbol, preClose, options);
  return {
    up: null,
    down: null,
    percent: null,
    reason:
      rule.priceLimits === "none"
        ? "no-price-limit"
        : "contract-evidence-required",
    ruleDate: options.ruleDate,
  };
}
