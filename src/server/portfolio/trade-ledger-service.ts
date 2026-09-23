import { createHash } from "node:crypto";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import {
  positionFor,
  tradeInputSchema,
  tradedSignalComparison,
  type CorporateEvidence,
  type Position,
} from "~/lib/portfolio/trade-ledger";
import { sqlite, get, put } from "../db";
import { z } from "zod";
import { settings } from "../infra/settings";
import { readSnapshot } from "../data-sources/tdx/tdx";
import { readGbbq } from "../data-sources/tdx/tdx-gbbq";
import { localCalendarReference } from "../market/data-health";
import { tradingLedgerMethods } from "../research/research-skills";
import { TradeLedgerStore } from "./trade-ledger-store";
import { SignalLedgerStore } from "../monitoring/signal-ledger-store";

export async function tradeContext() {
  const config = settings(),
    today = chinaClock(Date.now()).date;
  const calendar = await localCalendarReference(
    config.tdxRoot,
    config.calendar,
  );
  let events: Awaited<ReturnType<typeof readGbbq>>["events"] = new Map();
  let coverageEnd: string | null = null,
    source = "本地 GBBQ 缺失或不可读";
  try {
    const data = await readGbbq(config.tdxRoot);
    events = data.events;
    for (const list of events.values())
      for (const e of list)
        if (!coverageEnd || e.date > coverageEnd) coverageEnd = e.date;
    source = `${data.path}; mtime=${data.modified}; parsedHash=${createHash(
      "sha256",
    )
      .update(JSON.stringify([...events]))
      .digest("hex")}`;
  } catch {
    /* Explicit unknown state; never silently treat missing as no event. */
  }
  return {
    today,
    calendar: calendar.days,
    calendarSource: calendar.source,
    evidence: (symbol: string): CorporateEvidence => ({
      events: events.get(symbol) ?? [],
      coverageEnd,
      source,
      bonusListings: get<CorporateEvidence["bonusListings"]>(
        `trade-bonus-${symbol}`,
      ),
    }),
  };
}
export async function recordBonusListing(
  symbol: string,
  eventDate: string,
  date: string,
  source: string,
) {
  z.string()
    .regex(/^(sh|sz|bj)\d{6}$/)
    .parse(symbol);
  z.string().min(1).max(200).parse(source);
  const context = await tradeContext();
  const event = context
    .evidence(symbol)
    .events.find(
      (e) =>
        e.date === eventDate && e.category === 1 && (e.bonusRatio ?? 0) > 0,
    );
  if (
    !event ||
    date < eventDate ||
    date > context.today ||
    !context.calendar.includes(date)
  )
    throw new Error("送转事件或可卖交易日期无效");
  const id = `trade-bonus-${symbol}`;
  const previous =
    get<NonNullable<CorporateEvidence["bonusListings"]>>(id) ?? {};
  // Receipt is append-only; revising it could invalidate an already recorded sale.
  if (previous[eventDate]) throw new Error("该事件已有可卖依据，保留原记录");
  put("trade-bonus", id, { ...previous, [eventDate]: { date, source } });
}
export async function recordLocalTrade(input: unknown) {
  const t = tradeInputSchema.parse(input);
  const context = await tradeContext();
  const methods = await tradingLedgerMethods();
  const store = new TradeLedgerStore(sqlite());
  const trade = store.record(t, {
    ...context,
    methods,
    evidence: context.evidence(t.symbol),
  });
  store.archive(
    positionFor(
      t.symbol,
      store.trades(),
      context.today,
      context.calendar,
      context.evidence(t.symbol),
    ).adjustments,
  );
  return trade.id;
}
export async function tradeDashboard() {
  const context = await tradeContext(),
    store = new TradeLedgerStore(sqlite()),
    trades = store.trades();
  const symbols = [...new Set(trades.map((t) => t.symbol))];
  const positions = await Promise.all(
    symbols.map(async (symbol) => {
      let quote: Position["quote"] = null;
      try {
        const bars = (await readSnapshot(settings().tdxRoot, symbol, "day"))
          .bars;
        // Only completed local daily closes, with the quote date always visible.
        const clock = chinaClock(Date.now());
        const last = bars
          .filter(
            (b) =>
              b.date < clock.date ||
              (b.date === clock.date && clock.time >= "15:05"),
          )
          .at(-1);
        if (last && Number.isFinite(last.close) && last.close > 0)
          quote = { price: last.close, date: last.date };
      } catch {
        /* Local prices unavailable; P&L remains blank. */
      }
      const p = positionFor(
        symbol,
        trades,
        context.today,
        context.calendar,
        context.evidence(symbol),
        quote,
      );
      const override = get<{ stop: number }>(`trade-stop-${symbol}`);
      if (override) {
        p.stop = override.stop;
        p.stopDistancePct = quote
          ? ((quote.price - override.stop) / quote.price) * 100
          : null;
      }
      store.archive(p.adjustments);
      return p;
    }),
  );
  const signals = new SignalLedgerStore(sqlite()).rows();
  return {
    today: context.today,
    calendarSource: context.calendarSource,
    trades,
    positions,
    adjustments: store.adjustments(),
    signals: signals.map((s) => ({
      id: s.id,
      symbol: s.symbol,
      date: s.observedDate,
      strategy: s.strategy,
      invalidation: s.invalidation,
    })),
    comparison: tradedSignalComparison(signals, trades),
  };
}
