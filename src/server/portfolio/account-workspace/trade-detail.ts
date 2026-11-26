import {
  matchesAccountKind,
  positionMetrics,
  type AccountKind,
  type AccountTrade,
} from "~/lib/portfolio/account-workspace";
import { pageHoldingsCorrelation } from "../holdings-correlation-service";
import { pagePositionRisk } from "../position-risk-service";
import { reviewTradeNav } from "~/lib/portfolio/trade-review-nav";
import { alertReference } from "~/lib/strategy-facts/alert-reference";
import { type AccountBook } from "./load-book";
import { calendarDays, paperDailyBars } from "./daily-bars";
import { accountAttribution } from "./attribution";
import { tradeChartHref } from "~/lib/chart/chart-trade-marks";

function tradeSource(trade: AccountTrade, book: AccountBook) {
  const event = book.facts.events.find((e) => e.key === trade.alertKey);
  const chartHref =
    trade.kind === "local-sim" && trade.market === "cn-equity"
      ? tradeChartHref({
          symbol: trade.symbol,
          at: trade.date,
          review: {
            source: "paper-account",
            refId: "local-sim:" + trade.account,
            accountId: trade.account,
            symbol: trade.symbol,
            label: trade.accountName ?? "本地模拟",
            backHref:
              "/accounts?" +
              new URLSearchParams({
                tab: "trades",
                trade: trade.id,
                symbol: trade.symbol,
              }),
          },
        })
      : undefined;
  return { ...trade, chartHref, alert: event ? alertReference(event) : null };
}
export function accountPositionDetail(
  book: AccountBook,
  id: string,
  tradePage = 0,
) {
  const position = book.positions.find((p) => p.id === id);
  if (!position) throw new Error("持仓不存在，请刷新账户");
  const trades = book.trades
    .filter(
      (t) =>
        t.kind === position.kind &&
        t.account === position.account &&
        t.symbol === position.symbol &&
        (position.kind !== "futures-sim" || t.direction === position.direction),
    )
    .filter((t) => t.id.split(":", 1)[0] === position.id.split(":", 1)[0])
    .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  const attribution = accountAttribution(
    book,
    position.strategyId ?? undefined,
    position.strategyVersion ?? undefined,
  );
  const symbols = book.positions
    .filter((p) => p.market === position.market && p.kind === position.kind)
    .map((p) => p.symbol);
  let correlationBars = book.bars;
  if (position.kind === "paper")
    correlationBars = paperDailyBars(book, position.account);
  const calendar =
    position.market === "crypto"
      ? calendarDays(
          symbols.flatMap((s) => (correlationBars[s] ?? []).map((b) => b.date)),
        )
      : book.calendar;
  const quantities = Object.fromEntries(
    book.positions
      .filter(
        (p) =>
          p.kind === position.kind &&
          p.market === position.market &&
          symbols.includes(p.symbol),
      )
      .map((p) => [p.symbol, p.quantity]),
  );
  const days = calendar
    .slice(-61)
    .map((date) => ({ date, positions: quantities }));
  const correlation = pageHoldingsCorrelation(
    { days, tradingDays: calendar, bars: correlationBars },
    {
      pageIndex: Math.floor(
        [...new Set(symbols)].sort().indexOf(position.symbol) / 20,
      ),
      pageSize: 20,
      desc: false,
    },
  );
  const imported = book.facts.fills.filter(
    (f) =>
      position.id.startsWith("delivery:") && f.account === position.account,
  );
  const nav =
    imported.length && imported.every((f) => f.instrument !== "convertible")
      ? reviewTradeNav({
          fills: imported,
          cashFlows: book.facts.cashFlows.filter(
            (f) => f.account === position.account,
          ),
          bars: book.bars,
          tradingDays: book.calendar,
        })
      : null;
  const concentration = pagePositionRisk(nav?.days ?? [], {
    pageIndex: 0,
    pageSize: 10,
    sort: "date",
    desc: true,
  });
  const selected = trades.slice(tradePage * 20, (tradePage + 1) * 20);
  return {
    position: { ...position, ...positionMetrics(position) },
    trades: selected.map((t) => tradeSource(t, book)),
    tradeCount: trades.length,
    attribution,
    correlation,
    concentration,
    suggestions: selected.map((t) => ({
      tradeId: t.id,
      plans: book.facts.plans
        .filter(
          (p) =>
            p.symbol === t.symbol &&
            p.market === t.market &&
            p.createdAt !== undefined &&
            p.createdAt <= t.time &&
            t.time - p.createdAt <= 7 * 86400000,
        )
        .slice(0, 10),
    })),
  };
}

export function accountTradePage(
  book: AccountBook,
  input: {
    page: number;
    kind: AccountKind | "all";
    symbol: string;
    tradeId?: string;
  },
) {
  const trades = book.trades
    .filter(
      (t) =>
        matchesAccountKind(t.kind, input.kind) &&
        (!input.symbol || t.symbol.includes(input.symbol)) &&
        (!input.tradeId || t.id === input.tradeId),
    )
    .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  const selected = trades.slice(input.page * 20, (input.page + 1) * 20);
  return {
    trades: selected.map((t) => tradeSource(t, book)),
    tradeCount: trades.length,
    suggestions: selected.map((t) => ({
      tradeId: t.id,
      plans: book.facts.plans
        .filter(
          (p) =>
            p.symbol === t.symbol &&
            p.market === t.market &&
            p.createdAt !== undefined &&
            p.createdAt <= t.time &&
            t.time - p.createdAt <= 7 * 86400000,
        )
        .slice(0, 10),
    })),
  };
}
