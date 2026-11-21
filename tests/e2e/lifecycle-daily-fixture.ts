import type Database from "better-sqlite3";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { strategyObjectSchema } from "trading-strategies";
import { AlertRepository } from "../../src/server/db/alert-repository";
import { PaperRepository } from "../../src/server/db/paper-repository";
import { HoldingProtectionRepository } from "../../src/server/db/holding-protection-repository";
import { alertKey, type AlertEvent } from "../../src/lib/strategy-facts/alerts";
import {
  holdingTradeFingerprint,
  observeHoldingProtection,
  protectionPositionKey,
  type HoldingProtectionBinding,
} from "../../src/lib/portfolio/holding-protection";
import type { AccountTrade } from "../../src/lib/portfolio/account-workspace";
import type { FrozenCandidate } from "../../src/server/paper/model";
import frozen from "../../src/server/data/paper-candidates.json";

/** Synthetic paper cash and a real engine fill. Never prospective evidence. */
export function seedDailyProtection(db: Database.Database, now: number) {
  const strategy = strategyObjectSchema.parse({
    id: "QA-lifecycle-protection",
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: ["sh600000"] },
    entry: { kind: "constant", value: true },
    exit: {
      stop: { kind: "fixed", fraction: 0.1 },
      trailing: 0.1,
      takeProfit: 0.3,
    },
    sizing: { kind: "weight", weight: 0.1 },
    sleeve: "swing",
  });
  const calendar = ["2025-03-06", "2025-03-07"];
  const bars = calendar.map((date) => ({
    date,
    open: 10,
    high: 10.3,
    low: 9.8,
    close: 10,
    volume: 100000,
    amount: 1000000,
  }));
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: 100000,
    start: calendar[0]!,
    end: calendar[1]!,
    calendar,
    instruments: [
      {
        symbol: "sh600000",
        market: "cn-equity",
        bars,
        signalBars: bars,
        execution: {
          tradable: true,
          limitDown: null,
          limitUp: null,
          evidence: "fixed synthetic QA",
        },
      },
    ],
    strategies: [strategy],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.01, maxPositions: 1 }],
  };
  const result = runPortfolio(request);
  if (result.fills.length !== 1 || result.positions.length !== 1)
    throw new Error("Lifecycle fixture requires one open engine round");
  const fill = result.fills[0]!;
  const alerts = new AlertRepository(db),
    paper = new PaperRepository(db);
  const accountId = "paper:QA-lifecycle-protection",
    planId = "QA-lifecycle-stop-plan";
  const eventIdentity = {
    type: "entry" as const,
    price: fill.price,
    strategyId: strategy.id,
    version: 1,
    market: "cn-equity" as const,
    symbol: fill.symbol,
    bar: fill.date,
    paperFillId: `${accountId}:0`,
  };
  const event: AlertEvent = {
    ...eventIdentity,
    key: alertKey(eventIdentity),
    planId,
    stop: 9,
    target: 13,
    sleeve: "swing",
    observedAt: now,
    mode: "shadow",
    status: "shadow",
    wouldSend: false,
    outcomes: [],
    reason: "合成 QA 纸面成交，不是真实前推",
    source: "fixed synthetic QA",
  };
  alerts.strategies.saveStrategy(strategy);
  const protection = {
    version: "plan-protection-1" as const,
    exitSpec: strategy.exit,
    initialStop: 9,
    target: 13,
    entryReference: 10,
    asOf: calendar[0]!,
    matchesStrategy: true,
  };
  alerts.savePlan(
    {
      id: planId,
      strategyId: strategy.id,
      strategyVersion: 1,
      market: "cn-equity",
      symbol: fill.symbol,
      sleeve: "swing",
      triggerKey: event.key,
      entry: 10,
      stop: 9,
      target: 13,
      quantity: fill.quantity,
      tranches: 1,
      status: "closed",
      expiresAt: null,
      createdAt: Date.parse("2025-03-06T00:00:00+08:00"),
      protection,
    },
    now,
  );
  alerts.record(strategy, event);
  paper.create({
    id: accountId,
    market: "cn-equity",
    currency: "CNY",
    sleeve: "swing",
    startedAt: Date.parse("2025-03-06T00:00:00+08:00"),
    initial: request.initial,
    candidates: [
      { ...frozen.candidates[0], strategy } as unknown as FrozenCandidate,
    ],
    mirror: { venue: "off" },
    mirrorRevision: "QA",
    revision: 0,
    lastBar: calendar[1]!,
    lastRun: now,
    error: null,
    summary: null,
  });
  paper.saveState(accountId, {
    request,
    result,
    benchmark: bars,
    decisions: [],
  });
  const trade: AccountTrade = {
    id: `paper:${accountId}:0`,
    account: accountId,
    kind: "paper",
    market: "cn-equity",
    symbol: fill.symbol,
    side: fill.side,
    date: fill.date,
    time: Date.parse(`${fill.date}T00:00:00+08:00`),
    price: fill.price,
    quantity: fill.quantity,
    strategyId: strategy.id,
    strategyVersion: 1,
    sleeve: "swing",
    planId,
    alertKey: event.key,
  };
  const binding: HoldingProtectionBinding = {
    id: protectionPositionKey("paper", accountId, "cn-equity", fill.symbol),
    kind: "paper",
    account: accountId,
    market: "cn-equity",
    symbol: fill.symbol,
    strategyId: strategy.id,
    version: 1,
    planId,
    sleeve: "swing",
    trades: [{ id: trade.id, fingerprint: holdingTradeFingerprint(trade) }],
    entryDate: fill.date,
    entryTime: null,
    entryPrice: fill.price,
    boundAt: now,
    protection,
    status: "active",
    reason: null,
  };
  new HoldingProtectionRepository(db).save(binding);
  alerts.saveState(
    `holding-protection:${binding.id}`,
    observeHoldingProtection(binding, bars, [...calendar, "2025-03-10"], now),
  );
}
