import {
  AccountBook,
  atomScales,
  bpsOf,
  feesFor,
  notional,
  resolveInstrumentRule,
} from "quant-execution";
import {
  executionCostsForInstrument,
  researchExecutionCosts,
} from "trading-strategy-core/costs";
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
  transfer_atoms?: bigint;
  tax_atoms: bigint;
  slippage_atoms: bigint;
  trade_date: string;
}
type SimLot = { quantity: bigint; date: string };
type BookPosition = {
  quantity: bigint;
  mark: bigint;
  cost: bigint;
  lots: SimLot[];
};
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
  const book = new AccountBook<bigint, SimLot, BookPosition>(0n, {
    zero: 0n,
    add: (a, b) => a + b,
    subtract: (a, b) => a - b,
    keepLot: (q) => q > 0n,
    keepPosition: (q) => q > 0n,
  });
  const availableOn = (symbol: string, day: string) => {
    const sameDay =
      market === "crypto" ||
      resolveInstrumentRule(symbol, day).settlementDays === 0;
    return (lot: SimLot) => sameDay || lot.date < day;
  };
  const sellable = (lots: SimLot[], available: (lot: SimLot) => boolean) =>
    lots.reduce(
      (total, lot) => (available(lot) ? total + lot.quantity : total),
      0n,
    );
  for (const fill of fills) {
    if (fill.trade_date > currentTradeDate)
      throw new Error("交易日期早于账户已成交日期");
    const day = settlementDate(market, fill.trade_date);
    const available = availableOn(fill.symbol, day);
    const qty = fill.quantity_atoms;
    if (
      fill.side === "sell" &&
      qty > sellable(book.positions.get(fill.symbol)?.lots ?? [], available)
    )
      throw new Error("账户可卖数量不足");
    // This projection replays positions only. Cash comes from sim_cash_flows.
    book.postFill(
      fill.symbol,
      fill.side,
      qty,
      0n,
      book.cash,
      available,
      () => ({ quantity: qty, date: fill.trade_date }),
      (prior, quantity, lots) => ({
        quantity,
        lots,
        mark: 0n,
        cost:
          (prior?.cost ?? 0n) +
          fill.gross_atoms +
          fill.commission_atoms +
          (fill.transfer_atoms ?? 0n) +
          fill.tax_atoms +
          fill.slippage_atoms,
      }),
      (prior) => prior.cost - rounded(prior.cost * qty, prior.quantity),
    );
  }
  const day = settlementDate(market, currentTradeDate);
  const positions = new Map<string, Holding>();
  for (const [symbol, position] of book.positions)
    positions.set(symbol, {
      quantity: position.quantity,
      basis: position.cost,
      sellable: sellable(position.lots, availableOn(symbol, day)),
    });
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
  const symbol = normalizeSimSymbol(input.symbol, market);
  const priceDigits =
    market === "crypto"
      ? atomScales.crypto.price
      : resolveInstrumentRule(symbol, input.tradeDate).priceTick === 0.001
        ? 3
        : 2;
  return {
    symbol,
    quantity: parseAtoms(input.quantity, quantityDigits(market)),
    price: parseAtoms(input.price, priceDigits),
    priceDigits,
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
  const unit = scale(
    quantityDigits(market) + terms.priceDigits - moneyDigits(market),
  );
  if (grossNumerator < unit) throw new Error("成交额不足一个最小货币单位");
  const priceAtoms =
    price * scale(atomScales[market].price - terms.priceDigits);
  const gross = checkedAtoms(notional(quantity, priceAtoms, market));
  const fixed = researchExecutionCosts(market, "fixed");
  const costs =
    market === "cn-equity"
      ? executionCostsForInstrument(fixed, terms.symbol, terms.tradeDate)
      : fixed;
  const fees = feesFor(side, gross, {
    ...costs,
    transferBps: costs.transferBps ?? 0,
    minimumCommission: parseAtoms(
      String(costs.minimumCommission),
      moneyDigits(market),
    ),
  });
  const { commission, transfer, tax } = fees;
  const slippage = bpsOf(gross, costs.slippageBps);
  const delta = checkedAtoms(
    (side === "sell" ? gross : -gross) - fees.total - slippage,
  );
  const cashAfter = checkedAtoms(cash + delta);
  if (cashAfter < 0n) throw new Error("账户可用资金不足");
  return {
    gross,
    commission,
    transfer,
    tax,
    slippage,
    delta,
    cashAfter,
    costs,
  };
}
