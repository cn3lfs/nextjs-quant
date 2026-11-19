import { type Bar } from "~/lib/domain";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import { positionFor } from "~/lib/portfolio/trade-ledger";
import { reviewTrades } from "~/lib/portfolio/trade-review";
import { AccountWorkspaceRepository } from "../../db/account-workspace-repository";
import { AlertRepository } from "../../db/alert-repository";
import { tradeContext } from "../trade-ledger-service";
import {
  type AccountFacts,
  tradeTime,
  type PositionLedgers,
} from "./position-ledgers";

export function readRealPositions(
  { positions, trades, linked, stopFor }: PositionLedgers,
  facts: AccountFacts,
  context: Awaited<ReturnType<typeof tradeContext>>,
  repo: AccountWorkspaceRepository,
  bars: Record<string, Bar[]>,
  today: ReturnType<typeof chinaClock>,
) {
  for (const account of [...new Set(facts.batches.map((b) => b.account))]) {
    const fills = facts.fills.filter((f) => f.account === account),
      cashFlows = facts.cashFlows.filter((f) => f.account === account);
    const review = reviewTrades({
      fills,
      cashFlows,
      bars,
      tradingDays: context.calendar,
    });
    for (const f of fills)
      trades.push(
        linked({
          id: `delivery:${f.id}`,
          account,
          kind: "real",
          market: "cn-equity",
          symbol: f.symbol ?? f.code,
          side: f.kind,
          date: f.tradeDate,
          time: tradeTime(f.tradeDate, f.tradeTime, "cn-equity"),
          timePrecision: f.tradeTime ? "instant" : "day",
          sourceOrder: { source: f.batchId, index: f.rowIndex },
          price: f.price,
          quantity: f.quantity,
          strategyId: null,
          strategyVersion: null,
          sleeve: "未知",
          planId: null,
          alertKey: null,
        }),
      );
    for (const p of review.movingAverage.openPositions) {
      const unitUnknown = p.instrument === "convertible";
      const quote = bars[p.security]?.at(-1),
        source = stopFor(
          account,
          p.security,
          p.fillIndices.map((i) => `delivery:${fills[i]!.id}`),
        );
      const events = context.evidence(p.security),
        since = p.openingDate;
      const corporateUnknown =
        !since ||
        !events.coverageEnd ||
        events.coverageEnd < (quote?.date.slice(0, 10) ?? today.date) ||
        events.events.some(
          (e) =>
            e.date > since &&
            e.date <= (quote?.date.slice(0, 10) ?? today.date) &&
            [1, 11, 12].includes(e.category),
        );
      const cost =
        !unitUnknown &&
        !corporateUnknown &&
        !p.openingUnknown &&
        p.remainingCost.value !== null
          ? p.remainingCost.value / p.remainingQuantity
          : null;
      positions.push({
        id: `delivery:${account}:${p.security}`,
        account,
        kind: "real",
        market: "cn-equity",
        currency: "CNY",
        symbol: p.security,
        sleeve: source.trade?.sleeve ?? "未知",
        industry: "未知",
        quantity: p.remainingQuantity,
        cost,
        price: unitUnknown ? null : (quote?.close ?? null),
        value:
          !unitUnknown && !corporateUnknown && quote
            ? p.remainingQuantity * quote.close
            : null,
        stop: source.stop,
        at: quote?.date ?? null,
        strategyId: source.trade?.strategyId ?? null,
        strategyVersion: source.trade?.strategyVersion ?? null,
        reasons: [
          ...(unitUnknown
            ? ["可转债数量/价格单位须在原交割单复盘核对，统一风险估值留空"]
            : []),
          ...(corporateUnknown
            ? ["交割单股份未认证除权/到账，估值与R留空"]
            : []),
          ...(!quote ? ["缺原价日线"] : []),
        ],
      });
    }
  }
  for (const t of facts.local)
    trades.push(
      linked({
        id: `local:${t.id}`,
        account: "手工账本",
        kind: "real",
        market: "cn-equity",
        symbol: t.symbol,
        side: t.side,
        date: t.date,
        time: tradeTime(t.date, null, "cn-equity"),
        timePrecision: "day",
        price: t.price,
        quantity: t.quantity,
        strategyId: null,
        strategyVersion: null,
        sleeve: "未知",
        planId: null,
        alertKey: null,
      }),
    );
  for (const symbol of [...new Set(facts.local.map((t) => t.symbol))]) {
    const quote = bars[symbol]?.at(-1),
      p = positionFor(
        symbol,
        facts.local,
        today.date,
        context.calendar,
        context.evidence(symbol),
        quote ? { price: quote.close, date: quote.date } : null,
      );
    if (p.quantity <= 0) continue;
    let held = 0;
    const activeIds: string[] = [];
    for (const t of facts.local.filter((t) => t.symbol === symbol)) {
      held += t.side === "buy" ? t.quantity : -t.quantity;
      if (t.side === "buy") activeIds.push(`local:${t.id}`);
      if (held === 0) activeIds.length = 0;
    }
    const source = stopFor("手工账本", symbol, activeIds),
      protection = new AlertRepository(repo.db).state<{
        stop: number | null;
        sleeve: string;
      }>(`protection:cn-equity:${symbol}`);
    positions.push({
      id: `local:${symbol}`,
      account: "手工账本",
      kind: "real",
      market: "cn-equity",
      currency: "CNY",
      symbol,
      sleeve:
        source.trade?.sleeve !== "未知"
          ? (source.trade?.sleeve ?? "未知")
          : (protection?.sleeve ?? "未知"),
      industry: "未知",
      quantity: p.quantity,
      cost: p.adjustedCost,
      price: quote?.close ?? null,
      value: quote ? p.quantity * quote.close : null,
      stop: source.stop ?? protection?.stop ?? p.stop,
      at: quote?.date ?? null,
      strategyId: source.trade?.strategyId ?? null,
      strategyVersion: source.trade?.strategyVersion ?? null,
      reasons: ["手工账本独立于导入账户；请勿将同一成交重复登记到两个账户"],
    });
  }
}
