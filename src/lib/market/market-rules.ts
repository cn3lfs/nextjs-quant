import { computePriceLimits, type PriceLimitInput } from "tstdx/market-rules";
import { rulesFor } from "trading-strategy-core/market-rules";
import { marketSession } from "./market-session";
import type { Instrument } from "./instrument";
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
