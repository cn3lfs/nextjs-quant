import { researchExecutionCosts } from "trading-strategy-core/costs";
import { formatSimAtoms as formatAtoms } from "~/lib/portfolio/sim-accounts";
import type {
  SimAccountSummary,
  SimOrderPreview,
  SimPosition,
} from "~/lib/portfolio/sim-accounts";

export type Market = SimAccountSummary["market"];
export const moneyDigits = (market: Market) => (market === "crypto" ? 8 : 2);
export const quantityDigits = (market: Market) => (market === "crypto" ? 8 : 0);
const scale = (digits: number) => 10n ** BigInt(digits);
const maxInteger = (1n << 63n) - 1n;

export function checkedAtoms(value: bigint) {
  if (value > maxInteger || value < -maxInteger - 1n)
    throw new Error("数值超出 SQLite 整数范围");
  return value;
}

// Callers validate the decimal syntax at the shared schema boundary.
export function parseAtoms(decimal: string, digits: number) {
  const [whole, fraction = ""] = decimal.split(".");
  const significant = fraction.replace(/0+$/, "");
  if (significant.length > digits)
    throw new Error("数值精度超过市场允许的最小单位");
  return checkedAtoms(BigInt(whole! + significant.padEnd(digits, "0")));
}
// All operands are non-negative. Round half up only at a ledger unit boundary.
function rounded(numerator: bigint, denominator: bigint) {
  return (numerator + denominator / 2n) / denominator;
}

export interface ReplayFill {
  symbol: string;
  side: "buy" | "sell";
  quantity_atoms: bigint;
  gross_atoms: bigint;
  commission_atoms: bigint;
  tax_atoms: bigint;
  slippage_atoms: bigint;
  trade_date: string;
}
interface Holding {
  quantity: bigint;
  sellable: bigint;
  basis: bigint;
}

/** A weekend account view has the same settlement date as the preceding Friday. */
export function settlementDate(market: Market, date: string): string {
  if (market === "crypto") return date;
  const utc = new Date(date + "T00:00:00Z");
  const weekday = utc.getUTCDay();
  if (weekday !== 0 && weekday !== 6) return date;
  utc.setUTCDate(utc.getUTCDate() - (weekday === 0 ? 2 : 1));
  return utc.toISOString().slice(0, 10);
}

export function replayPositions(
  fills: Iterable<ReplayFill>,
  market: Market,
  currentTradeDate: string,
) {
  const positions = new Map<string, Holding>();
  const settledThrough = settlementDate(market, currentTradeDate);
  for (const fill of fills) {
    if (fill.trade_date > currentTradeDate)
      throw new Error("交易日期早于账户已成交日期");
    const holding = positions.get(fill.symbol) ?? {
      quantity: 0n,
      sellable: 0n,
      basis: 0n,
    };
    const qty = fill.quantity_atoms;
    if (fill.side === "buy") {
      holding.basis +=
        fill.gross_atoms +
        fill.commission_atoms +
        fill.tax_atoms +
        fill.slippage_atoms;
      holding.quantity += qty;
      if (market === "crypto" || fill.trade_date < settledThrough)
        holding.sellable += qty;
    } else {
      holding.basis -= rounded(holding.basis * qty, holding.quantity);
      holding.quantity -= qty;
      holding.sellable -= qty;
    }
    if (holding.quantity === 0n) positions.delete(fill.symbol);
    else positions.set(fill.symbol, holding);
  }
  return positions;
}
export function positionView(
  symbol: string,
  holding: Holding,
  market: Market,
): SimPosition {
  const money = moneyDigits(market),
    qty = quantityDigits(market);
  const average = rounded(
    holding.basis * scale(qty + 8 - money),
    holding.quantity,
  );
  return {
    symbol,
    quantity: formatAtoms(holding.quantity, qty),
    sellableQuantity: formatAtoms(holding.sellable, qty),
    costBasis: formatAtoms(holding.basis, money),
    averageCost: formatAtoms(average, 8),
  };
}
export function normalizeSimSymbol(value: string, market: Market): string {
  const symbol = value.trim();
  if (market === "crypto") {
    const pair = /^(?:cx)?(BTCUSDT|ETHUSDT)$/i.exec(symbol);
    if (!pair) throw new Error("数字货币账户仅支持 BTCUSDT / ETHUSDT 现货");
    return "cx" + pair[1]!.toUpperCase();
  }
  if (!/^(sh|sz|bj)\d{6}$/i.test(symbol))
    throw new Error("A股账户的证券代码与市场不匹配");
  return symbol.toLowerCase();
}

export function orderTerms(input: SimOrderPreview, market: Market) {
  const currency = market === "crypto" ? "USDT" : "CNY";
  if (
    (input.market && input.market !== market) ||
    (input.currency && input.currency !== currency)
  )
    throw new Error("委托市场或币种与账户不匹配");
  return {
    symbol: normalizeSimSymbol(input.symbol, market),
    quantity: parseAtoms(input.quantity, quantityDigits(market)),
    price: parseAtoms(input.price, moneyDigits(market)),
    side: input.side,
    tradeDate: input.tradeDate,
    executionMode: input.executionMode ?? "manual",
    planId: input.planId ?? null,
  };
}
export type OrderTerms = ReturnType<typeof orderTerms>;

export function quote(
  terms: OrderTerms,
  market: Market,
  cash: bigint,
  sellable: bigint,
) {
  const { quantity, price, side } = terms;
  if (side === "sell" && quantity > sellable)
    throw new Error("账户可卖数量不足");
  if (
    market === "cn-equity" &&
    quantity % 100n !== 0n &&
    !(side === "sell" && quantity === sellable)
  )
    throw new Error("A股委托必须为100股整手，零股仅可一次卖清");
  const grossNumerator = quantity * price;
  const unit = scale(quantityDigits(market));
  if (grossNumerator < unit) throw new Error("成交额不足一个最小货币单位");
  const gross = checkedAtoms(rounded(grossNumerator, unit));
  const costs = researchExecutionCosts(market, "fixed");
  const bps = (rate: number) => rounded(gross * BigInt(rate), 10000n);
  const minimum = BigInt(costs.minimumCommission) * scale(moneyDigits(market));
  const variable = bps(costs.commissionBps);
  const commission = variable < minimum ? minimum : variable;
  const tax = side === "sell" ? bps(costs.sellTaxBps) : 0n;
  const slippage = bps(costs.slippageBps);
  const delta = checkedAtoms(
    (side === "sell" ? gross : -gross) - commission - tax - slippage,
  );
  const cashAfter = checkedAtoms(cash + delta);
  if (cashAfter < 0n) throw new Error("账户可用资金不足");
  return { gross, commission, tax, slippage, delta, cashAfter, costs };
}
