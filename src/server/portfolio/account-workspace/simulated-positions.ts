import { AccountWorkspaceRepository } from "../../db/account-workspace-repository";
import { AlertRepository } from "../../db/alert-repository";
import {
  type AccountFacts,
  tradeTime,
  type PositionLedgers,
} from "./position-ledgers";

export function readSimulatedPositions(
  { positions, trades, linked, stopFor }: PositionLedgers,
  facts: AccountFacts,
  repo: AccountWorkspaceRepository,
) {
  for (const { account, state } of facts.paper) {
    if (!state) continue;
    for (const [i, f] of state.result.fills.entries()) {
      const strategy = account.candidates.find(
        (c) => c.strategy.id === f.strategyId,
      )?.strategy;
      const event = facts.events.find(
        (e) => e.paperFillId === `${account.id}:${i}`,
      );
      trades.push({
        id: `paper:${account.id}:${i}`,
        account: account.id,
        kind: "paper",
        market: account.market,
        symbol: f.symbol,
        side: f.side,
        date: f.date,
        time: tradeTime(f.date, null, account.market),
        price: f.price,
        quantity: f.quantity,
        fees: f.fee ?? null,
        strategyId: f.strategyId,
        strategyVersion: strategy?.version ?? null,
        sleeve: f.sleeve,
        planId: event?.planId ?? null,
        alertKey: event?.key ?? null,
      });
    }
    for (const p of state.result.positions) {
      const strategy = account.candidates.find(
        (c) => c.strategy.id === p.strategyId,
      )?.strategy;
      const last = state.decisions
        .filter((d) => d.strategyId === p.strategyId && d.symbol === p.symbol)
        .at(-1);
      positions.push({
        id: `paper:${account.id}:${p.key}`,
        account: account.id,
        kind: "paper",
        market: account.market,
        currency: account.currency,
        symbol: p.symbol,
        sleeve: p.sleeve,
        industry: "未知",
        quantity: p.quantity,
        cost: p.quantity > 0 ? p.cost / p.quantity : null,
        price: p.mark,
        value: p.mark * p.quantity,
        stop: last?.stop ?? null,
        at: account.lastBar,
        strategyId: p.strategyId,
        strategyVersion: strategy?.version ?? null,
        reasons: ["本地模拟记账；不代表场所成交"],
      });
    }
  }
  for (const c of facts.crypto) {
    for (const t of c.trades)
      trades.push(
        linked({
          id: `crypto:${c.bot.id}:${c.revision}:${t.symbol}:${t.orderId}:${t.id}`,
          account: c.bot.id,
          kind: "exchange-simulation",
          market: "crypto",
          symbol: t.symbol,
          side: t.side === "BUY" ? "buy" : "sell",
          date: new Date(t.time).toISOString(),
          time: t.time,
          timePrecision: "instant",
          price: Number(t.price),
          quantity: Number(t.quantity),
          fees: Number(t.fee),
          feeCurrency: t.feeAsset,
          strategyId: null,
          strategyVersion: null,
          sleeve: "未知",
          planId: null,
          alertKey: null,
        }),
      );
    for (const p of c.snapshot?.positions ?? []) {
      if (Number(p.total) <= 0) continue;
      const source = stopFor(c.bot.id, p.symbol),
        protection = new AlertRepository(repo.db).state<{
          stop: number | null;
          sleeve: string;
        }>(`protection:crypto:${c.bot.id}:${p.symbol}`);
      positions.push({
        id: `crypto:${c.bot.id}:${p.symbol}`,
        account: c.bot.id,
        kind: "exchange-simulation",
        market: "crypto",
        currency: "USDT",
        symbol: p.symbol,
        sleeve: source.trade?.sleeve ?? protection?.sleeve ?? "未知",
        industry: "数字货币",
        quantity: Number(p.total),
        cost: null,
        price: p.price === null ? null : Number(p.price),
        value: p.marketValue === null ? null : Number(p.marketValue),
        stop: source.stop ?? protection?.stop ?? null,
        at: new Date(c.snapshot!.at).toISOString(),
        strategyId: source.trade?.strategyId ?? null,
        strategyVersion: source.trade?.strategyVersion ?? null,
        reasons: ["模拟钱包全部余额；历史覆盖不证明期初成本，R留空"],
      });
    }
  }
}
