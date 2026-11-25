import Big from "big.js";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { futuresContract } from "~/lib/market/futures";
import {
  futuresContractCurrency,
  futuresSimAccountCreateSchema,
  futuresSimOrderConfirmSchema,
  futuresSimOrderPreviewSchema,
  type FuturesSimAccountCreate,
  type FuturesSimAccountSummary,
  type FuturesSimOrderConfirm,
  type FuturesSimOrderPreview,
  type FuturesSimOrderPreviewResult,
  type FuturesSimPosition,
  type FuturesSimTrade,
} from "~/lib/portfolio/futures-sim";
import { atomic, get, put, readRecordSnapshot } from "../db";

const recordKind = "futures-sim-account";
const feeRate = "0.0001";

type Rational = { num: bigint; den: bigint };

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = absBigInt(a);
  let y = absBigInt(b);
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

function makeRat(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new Error("有理数分母不能为零");
  const sign = den < 0n ? -1n : 1n;
  const n = num * sign;
  const d = den * sign;
  const g = gcdBigInt(n, d);
  return { num: n / g, den: d / g };
}

function decimalToRat(value: string): Rational {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart = "0", fracPart = ""] = unsigned.split(".");
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, "") || "0";
  const num = BigInt(digits) * (negative ? -1n : 1n);
  const den = 10n ** BigInt(fracPart.length);
  return makeRat(num, den);
}

function ratAdd(a: Rational, b: Rational): Rational {
  return makeRat(a.num * b.den + b.num * a.den, a.den * b.den);
}

function ratSub(a: Rational, b: Rational): Rational {
  return makeRat(a.num * b.den - b.num * a.den, a.den * b.den);
}

function ratScale(a: Rational, mul: number, div: number): Rational {
  return makeRat(a.num * BigInt(mul), a.den * BigInt(div));
}

function ratRoundHalfUp(r: Rational, dp: number): string {
  const negative = r.num < 0n;
  const scale = 10n ** BigInt(dp);
  const scaledNum = absBigInt(r.num) * scale;
  let q = scaledNum / r.den;
  const rem = scaledNum % r.den;
  if (rem * 2n >= r.den) q += 1n;
  const digits = q.toString().padStart(dp + 1, "0");
  const formatted =
    dp > 0
      ? `${digits.slice(0, digits.length - dp)}.${digits.slice(digits.length - dp)}`
      : digits;
  return negative && q !== 0n ? `-${formatted}` : formatted;
}

function ratToDisplayBig(r: Rational): Big {
  return new Big(r.num.toString()).div(r.den.toString());
}

function serializeRat(r: Rational): { num: string; den: string } {
  return { num: r.num.toString(), den: r.den.toString() };
}

function positionCostRat(position: FuturesSimPosition): Rational {
  if (position.costBasisRatio) {
    return makeRat(
      BigInt(position.costBasisRatio.num),
      BigInt(position.costBasisRatio.den),
    );
  }
  return decimalToRat(position.costBasis);
}

type StoredPosition = Omit<
  FuturesSimPosition,
  "costBasis" | "contractMultiplier" | "marginRate"
> & {
  costBasis?: string;
  costBasisRatio?: { num: string; den: string };
  contractMultiplier?: number;
  marginRate: string | number;
};
type StoredAccount = Omit<FuturesSimAccountSummary, "positions"> & {
  positions: StoredPosition[];
};

function readAccount(account: StoredAccount): FuturesSimAccountSummary {
  const positions = account.positions.map((position) => {
    // Positions created before lot-multiplier accounting posted margin at 1 unit/lot.
    // Keep their original multiplier = 1 so closing settles coherently against posted margin.
    const contractMultiplier = position.contractMultiplier ?? 1;
    const costBasis =
      position.costBasis ??
      new Big(position.avgEntryPrice)
        .times(position.quantity)
        .times(contractMultiplier)
        .toFixed();
    const costBasisRatio =
      position.costBasisRatio ?? serializeRat(decimalToRat(costBasis));
    return {
      ...position,
      contractMultiplier,
      costBasis,
      costBasisRatio,
      marginRate: new Big(position.marginRate).toFixed(),
    };
  });
  return { ...account, positions };
}

function requireAccount(id: string): FuturesSimAccountSummary {
  const account = id.startsWith(recordKind + ":")
    ? get<StoredAccount>(id)
    : undefined;
  if (!account || account.id !== id) throw new Error("期货模拟账户不存在");
  return readAccount(account);
}

export function listFuturesSimAccounts() {
  return readRecordSnapshot(recordKind, (accounts: Iterable<StoredAccount>) =>
    Array.from(accounts, readAccount).sort(
      (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    ),
  );
}

export function createFuturesSimAccount(input: FuturesSimAccountCreate) {
  const { name, currency, initialCapital } =
    futuresSimAccountCreateSchema.parse(input);
  const capital = new Big(initialCapital).toFixed(2);
  if (new Big(capital).eq(0)) throw new Error("初始资金按分取整后须大于零");
  const now = Date.now();
  const account: FuturesSimAccountSummary = {
    id: recordKind + ":" + randomUUID(),
    name,
    currency,
    initialCapital: capital,
    cash: capital,
    frozenMargin: "0.00",
    realizedPnl: "0.00",
    positions: [],
    trades: [],
    createdAt: now,
    updatedAt: now,
  };
  return put(recordKind, account.id, account);
}

function quote(
  account: FuturesSimAccountSummary,
  order: z.output<typeof futuresSimOrderPreviewSchema>,
) {
  const { symbol, action, quantity, marginRate } = order;
  const contract = futuresContract(symbol);
  if (!contract) throw new Error("不支持的期货品种");
  const currency = futuresContractCurrency(contract);
  if (account.currency !== currency)
    throw new Error("合约币种与期货模拟账户币种不匹配");

  const precision = Math.max(2, contract.precision);
  const price = new Big(order.price).round(precision);
  if (price.eq(0)) throw new Error("成交价按合约精度取整后须大于零");
  const opening = action === "buy_open" || action === "sell_open";
  const side =
    action === "buy_open" || action === "sell_close" ? "long" : "short";
  const positionIndex = account.positions.findIndex(
    (p) => p.symbol === symbol && p.side === side,
  );
  const position = account.positions[positionIndex];
  if (
    opening &&
    position &&
    position.contractMultiplier !== contract.contractMultiplier
  ) {
    throw new Error("旧版无乘数持仓需先全部平仓后再按标准合约乘数开仓");
  }
  const effectiveMultiplier = opening
    ? contract.contractMultiplier
    : (position?.contractMultiplier ?? contract.contractMultiplier);
  const notional = price.times(quantity).times(effectiveMultiplier);
  const fee = notional.times(feeRate).round(2);
  const positionQtyBefore = position?.quantity ?? 0;
  const positionQtyAfter = positionQtyBefore + (opening ? quantity : -quantity);
  const cash = new Big(account.cash);
  let cashAfter: Big;
  let requiredMargin = new Big(0);
  let releasedMargin = new Big(0);
  let effectiveMarginRate = marginRate;
  let grossPnl = new Big(0);
  let estimatedPnl = new Big(0);
  let nextPosition: FuturesSimPosition | undefined;

  if (opening) {
    if (!Number.isSafeInteger(positionQtyAfter))
      throw new Error("持仓数量超出安全整数范围");
    const rawMargin = notional.times(marginRate);
    requiredMargin = rawMargin.round(2);
    cashAfter = cash.minus(requiredMargin).minus(fee);
    if (cashAfter.lt(0)) throw new Error("可用资金不足");
    const priorCostRat = position ? positionCostRat(position) : makeRat(0n, 1n);
    const nextCostRat = ratAdd(priorCostRat, decimalToRat(notional.toFixed()));
    const priorCost = ratToDisplayBig(priorCostRat);
    const costBasis = ratToDisplayBig(nextCostRat);
    nextPosition = {
      symbol,
      name: contract.name,
      side,
      quantity: positionQtyAfter,
      contractMultiplier: effectiveMultiplier,
      costBasis: costBasis.toFixed(),
      costBasisRatio: serializeRat(nextCostRat),
      avgEntryPrice: ratRoundHalfUp(
        ratScale(nextCostRat, 1, positionQtyAfter * effectiveMultiplier),
        precision,
      ),
      margin: requiredMargin.plus(position?.margin ?? 0).toFixed(2),
      marginRate:
        position && position.marginRate !== marginRate
          ? priorCost
              .times(position.marginRate)
              .plus(rawMargin)
              .div(costBasis)
              .toFixed()
          : marginRate,
    };
  } else {
    if (!position || positionQtyAfter < 0) throw new Error("可平仓数量不足");
    effectiveMarginRate = position.marginRate;
    const margin = new Big(position.margin);
    const costRat = positionCostRat(position);
    const closedCostRat =
      positionQtyAfter === 0
        ? costRat
        : ratScale(costRat, quantity, positionQtyBefore);
    releasedMargin =
      positionQtyAfter === 0
        ? margin
        : margin.times(quantity).div(position.quantity).round(2);
    const exitNotionalRat = decimalToRat(notional.toFixed());
    const grossPnlRat =
      side === "long"
        ? ratSub(exitNotionalRat, closedCostRat)
        : ratSub(closedCostRat, exitNotionalRat);
    grossPnl = new Big(ratRoundHalfUp(grossPnlRat, 2));
    estimatedPnl = grossPnl.minus(fee);
    cashAfter = cash.plus(releasedMargin).plus(estimatedPnl);
    if (positionQtyAfter > 0) {
      const remainingCostRat = ratSub(costRat, closedCostRat);
      nextPosition = {
        ...position,
        quantity: positionQtyAfter,
        costBasis: ratToDisplayBig(remainingCostRat).toFixed(),
        costBasisRatio: serializeRat(remainingCostRat),
        margin: margin.minus(releasedMargin).toFixed(2),
      };
    }
  }

  const preview: FuturesSimOrderPreviewResult = {
    accountId: account.id,
    symbol,
    name: contract.name,
    currency,
    action,
    quantity,
    price: price.toFixed(precision),
    contractMultiplier: effectiveMultiplier,
    marginRate: effectiveMarginRate,
    notional: notional.toFixed(2),
    requiredMargin: requiredMargin.toFixed(2),
    releasedMargin: releasedMargin.toFixed(2),
    fee: fee.toFixed(2),
    grossPnl: grossPnl.toFixed(2),
    estimatedPnl: estimatedPnl.toFixed(2),
    cashBefore: account.cash,
    cashAfter: cashAfter.toFixed(2),
    positionQtyBefore,
    positionQtyAfter,
  };
  return { preview, positionIndex, nextPosition };
}

export function previewFuturesSimOrder(input: FuturesSimOrderPreview) {
  const order = futuresSimOrderPreviewSchema.parse(input);
  return quote(requireAccount(order.accountId), order).preview;
}

export function confirmFuturesSimOrder(input: FuturesSimOrderConfirm) {
  const order = futuresSimOrderConfirmSchema.parse(input);
  return atomic(() => {
    const account = requireAccount(order.accountId);
    const prior = account.trades.find(
      (trade) => trade.clientRequestId === order.clientRequestId,
    );
    if (prior) return prior;

    const { preview, positionIndex, nextPosition } = quote(account, order);
    const marginDelta = new Big(preview.requiredMargin).minus(
      preview.releasedMargin,
    );
    const trade: FuturesSimTrade = {
      id: randomUUID(),
      clientRequestId: order.clientRequestId,
      symbol: preview.symbol,
      name: preview.name,
      action: preview.action,
      quantity: preview.quantity,
      contractMultiplier: preview.contractMultiplier,
      grossPnl: preview.grossPnl,
      price: preview.price,
      notional: preview.notional,
      marginDelta: marginDelta.toFixed(2),
      fee: preview.fee,
      realizedPnl: preview.estimatedPnl,
      executedAt: Date.now(),
    };
    if (positionIndex < 0 && nextPosition) account.positions.push(nextPosition);
    else if (nextPosition) account.positions[positionIndex] = nextPosition;
    else account.positions.splice(positionIndex, 1);
    account.cash = preview.cashAfter;
    account.frozenMargin = marginDelta.plus(account.frozenMargin).toFixed(2);
    account.realizedPnl = new Big(account.realizedPnl)
      .plus(trade.realizedPnl)
      .toFixed(2);
    account.updatedAt = trade.executedAt;
    account.trades.unshift(trade);
    put(recordKind, account.id, account);
    return trade;
  });
}
