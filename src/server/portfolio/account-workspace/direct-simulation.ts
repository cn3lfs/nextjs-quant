import Big from "big.js";
import type { Bar } from "~/lib/domain";
import { chinaDate } from "~/lib/market/security-trading-status";
import type { AccountPosition } from "~/lib/portfolio/account-workspace";
import type { AccountFacts, PositionLedgers } from "./position-ledgers";

export function readDirectSimulation(
  { trades, positions, linked }: PositionLedgers,
  facts: AccountFacts,
  bars: Record<string, Bar[]>,
) {
  if (facts.thsMock) {
    positions.push(...facts.thsMock.positions);
    trades.push(...facts.thsMock.trades.map(linked));
  }
  const plans = new Map(facts.plans.map((plan) => [plan.id, plan]));
  for (const {
    account,
    trades: fills,
    positions: holdings,
  } of facts.localSim) {
    const identity = {
      kind: "local-sim" as const,
      account: account.id,
      accountName: account.name,
      market: account.market,
      currency: account.currency,
    };
    for (const [index, fill] of fills.entries()) {
      const plan = fill.planId ? plans.get(fill.planId) : undefined;
      trades.push(
        linked({
          ...identity,
          id: `local-sim:${account.id}:${fill.fillId}`,
          symbol: fill.symbol,
          side: fill.side,
          date: fill.tradeDate,
          time: fill.executedAt,
          timePrecision: "instant",
          sourceOrder: { source: account.id, index },
          price: Number(fill.price),
          quantity: Number(fill.quantity),
          fees: new Big(fill.commission)
            .plus(fill.transfer)
            .plus(fill.tax)
            .plus(fill.slippage)
            .toNumber(),
          slippage: Number(fill.slippage),
          strategyId: plan?.strategyId ?? null,
          strategyVersion: plan?.strategyVersion ?? null,
          sleeve: plan?.sleeve ?? "未知",
          planId: fill.planId,
          alertKey: plan?.triggerKey ?? null,
        }),
      );
    }
    for (const holding of holdings) {
      const mark = bars[holding.symbol]?.at(-1);
      const quantity = Number(holding.quantity);
      const basis = new Big(holding.costBasis);
      const notional = mark
        ? new Big(mark.close).times(holding.quantity)
        : null;
      positions.push({
        ...identity,
        ...unattributedPosition,
        id: `local-sim:${account.id}:${holding.symbol}`,
        symbol: holding.symbol,
        quantity,
        cost: Number(holding.averageCost),
        price: mark?.close ?? null,
        at: mark?.date ?? null,
        value: notional?.toNumber() ?? null,
        direction: "long",
        multiplier: 1,
        marginUsed: 0,
        notional: notional?.toNumber() ?? null,
        unrealizedPnl: notional?.minus(basis).toNumber() ?? null,
        reasons: mark ? [] : ["缺少已完成的本地原价日线"],
      });
    }
  }
  for (const account of facts.futuresSim) {
    const identity = {
      kind: "futures-sim" as const,
      account: account.id,
      accountName: account.name,
      market: "futures" as const,
      currency: account.currency,
    };
    for (const [index, fill] of account.trades.entries()) {
      trades.push({
        ...identity,
        id: `futures-sim:${account.id}:${fill.id}`,
        symbol: fill.symbol,
        side: fill.action.startsWith("buy") ? "buy" : "sell",
        direction:
          fill.action === "buy_open" || fill.action === "sell_close"
            ? "long"
            : "short",
        action: fill.action,
        date: chinaDate(fill.executedAt),
        time: fill.executedAt,
        timePrecision: "instant",
        sourceOrder: {
          source: account.id,
          index: account.trades.length - 1 - index,
        },
        price: Number(fill.price),
        quantity: fill.quantity,
        multiplier: fill.contractMultiplier ?? 1,
        notional: Number(fill.notional),
        marginDelta: Number(fill.marginDelta),
        fees: Number(fill.fee),
        realizedPnl: Number(fill.realizedPnl),
        strategyId: null,
        strategyVersion: null,
        sleeve: "未知",
        planId: null,
        alertKey: null,
      });
    }
    for (const holding of account.positions) {
      const mark = bars[holding.symbol]?.at(-1);
      // Legacy accounts posted margin at one quoted unit per lot.
      const multiplier = holding.contractMultiplier ?? 1;
      const margin = new Big(holding.margin);
      const entryNotional = holding.costBasisRatio
        ? new Big(holding.costBasisRatio.num).div(holding.costBasisRatio.den)
        : new Big(
            holding.costBasis ??
              new Big(holding.avgEntryPrice)
                .times(holding.quantity)
                .times(multiplier),
          );
      const markNotional = mark
        ? new Big(mark.close).times(holding.quantity).times(multiplier)
        : null;
      const pnl =
        holding.side === "long"
          ? markNotional?.minus(entryNotional)
          : markNotional && entryNotional.minus(markNotional);
      positions.push({
        ...identity,
        ...unattributedPosition,
        id: `futures-sim:${account.id}:${holding.symbol}:${holding.side}`,
        symbol: holding.symbol,
        quantity: holding.quantity,
        cost: Number(holding.avgEntryPrice),
        price: mark?.close ?? null,
        at: mark?.date ?? null,
        value: markNotional?.toNumber() ?? null,
        direction: holding.side,
        multiplier,
        marginUsed: margin.toNumber(),
        entryNotional: entryNotional.toNumber(),
        notional: entryNotional.toNumber(),
        leverage: margin.gt(0) ? entryNotional.div(margin).toNumber() : null,
        unrealizedPnl: pnl?.toNumber() ?? null,
        reasons: mark
          ? []
          : ["缺少已完成的期货结算行情，按开仓名义金额展示敞口"],
      });
    }
  }
}

const unattributedPosition = {
  sleeve: "未知",
  industry: "未知",
  stop: null,
  strategyId: null,
  strategyVersion: null,
} satisfies Partial<AccountPosition>;
