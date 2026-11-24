import {
  executionInstrumentKind,
  type ExecutionInstrumentKind,
  type ExecutionInstrumentOptions,
} from "trading-strategy-core/costs";
export { isCnEtfSymbol } from "trading-strategy-core/costs";

export type InstrumentRuleOptions = ExecutionInstrumentOptions;
export type InstrumentRule = {
  kind: "stock" | "etf";
  board: ExecutionInstrumentKind;
  instrumentKind: ExecutionInstrumentKind;
  priceTick: number;
  minimumBuyQuantity: number;
  buyQuantityStep: number;
  settlementCycle: "T+0" | "T+1";
  settlementDays: 0 | 1;
  stampDutyExempt: boolean;
  transferFeeExempt: boolean;
};

/** Exchange buy lots. STAR and Beijing allow one-share increments above the
 * minimum. Explicit instrument metadata is the authority on the sale cycle. */
export function resolveInstrumentRule(
  symbol: string,
  date: string,
  options?: InstrumentRuleOptions,
): InstrumentRule {
  const instrumentKind = executionInstrumentKind(symbol, date, options);
  const etf = instrumentKind === "etf-equity" || instrumentKind === "etf-t0";
  const star = instrumentKind === "equity-star";
  if (!etf && options?.settlementCycle === "T+0")
    throw new RangeError("Stocks require T+1 settlement");
  const settlementCycle =
    options?.settlementCycle ?? (instrumentKind === "etf-t0" ? "T+0" : "T+1");
  return {
    instrumentKind,
    board: instrumentKind,
    kind: etf ? "etf" : "stock",
    priceTick: etf ? 0.001 : 0.01,
    minimumBuyQuantity: star ? 200 : 100,
    buyQuantityStep: star || instrumentKind === "equity-bj" ? 1 : 100,
    settlementCycle,
    settlementDays: settlementCycle === "T+0" ? 0 : 1,
    stampDutyExempt: etf || options?.stampDutyExempt === true,
    transferFeeExempt: etf || options?.stampDutyExempt === true,
  };
}
