import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { AlertRepository } from "../../src/server/db/alert-repository";
import { AccountWorkspaceRepository } from "../../src/server/db/account-workspace-repository";
import { settingsSchema } from "../../src/lib/domain";
import { defaultBacktestCosts } from "../../src/lib/backtest/backtest-costs";
import { alertKey, type AlertEvent } from "../../src/lib/strategy-facts/alerts";
import { strategyObjectSchema } from "trading-strategies";
import { accountTradeFingerprint } from "../../src/lib/portfolio/account-workspace";
import daily from "../fixtures/breakout-valid.json";

/** Synthetic QA observations only, never natural forward or profitability evidence. */
export function seedR3bFixture(db: Database.Database) {
  const repo = new AlertRepository(db),
    accounts = new AccountWorkspaceRepository(db);
  const now = Date.now(),
    first = daily.bars[0]!.date;
  const strategy = strategyObjectSchema.parse({
    id: "QA-r3b-decay",
    version: 1,
    market: "cn-equity",
    period: "day",
    sleeve: "swing",
    universe: { kind: "symbols", symbols: ["sh600000"] },
    entry: { kind: "constant", value: true },
    exit: {},
    sizing: { kind: "weight", weight: 1 },
  });
  const config = settingsSchema.parse(accounts.record("settings"));
  config.alerts.capital["cn-equity"] = 1000000;
  db.prepare("UPDATE records SET payload=? WHERE id='settings'").run(
    JSON.stringify(config),
  );
  repo.strategies.saveStrategy(strategy);
  const identity = {
    type: "entry" as const,
    price: 100,
    strategyId: strategy.id,
    version: 1,
    market: "cn-equity" as const,
    symbol: "sh600000",
    bar: first,
  };
  const event: AlertEvent = {
    ...identity,
    key: alertKey(identity),
    stop: 90,
    target: 200,
    sleeve: "swing",
    observedAt: Date.parse(first) - 86400000,
    mode: "shadow",
    status: "shadow",
    reason: "QA synthetic",
    source: "fixed QA",
    wouldSend: false,
    outcomes: [],
  };
  repo.record(strategy, event);
  repo.savePlan(
    {
      id: "QA-r3b-plan",
      strategyId: strategy.id,
      strategyVersion: 1,
      market: "cn-equity",
      symbol: "sh600000",
      sleeve: "swing",
      triggerKey: event.key,
      entry: 100,
      stop: 90,
      target: 200,
      quantity: 3000,
      tranches: 1,
      status: "closed",
      expiresAt: null,
      createdAt: event.observedAt,
    },
    event.observedAt,
  );
  for (let i = 0; i < 30; i++) {
    const date = daily.bars[i]!.date,
      id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
    db.prepare("INSERT INTO trade_ledger VALUES(?,?,?,?)").run(
      id,
      "sh600000",
      date,
      JSON.stringify({
        id,
        symbol: "sh600000",
        date,
        side: "buy",
        price: 100,
        quantity: 100,
        lowerLimit: 1,
        upperLimit: 200,
        limitSource: "QA",
        signalId: null,
        stop: 90,
        note: "QA",
        createdAt: Date.parse(date),
        methods: [],
        costs: defaultBacktestCosts,
        fees: { commission: 0, tax: 0, slippage: 0, total: 0 },
      }),
    );
    accounts.link({
      tradeId: `local:${id}`,
      planId: "QA-r3b-plan",
      alertKey: event.key,
      strategyId: strategy.id,
      strategyVersion: 1,
      sleeve: "swing",
      linkedAt: now,
      tradeFingerprint: accountTradeFingerprint({
        id: `local:${id}`,
        account: "手工账本",
        kind: "real",
        market: "cn-equity",
        symbol: "sh600000",
        side: "buy",
        date,
        price: 100,
        quantity: 100,
      }),
    });
    const copy = {
      ...event,
      bar: date,
      key: alertKey({ ...identity, bar: date }),
      observedAt: Date.parse(date),
      outcomes: [
        {
          horizon: 20 as const,
          settled: true,
          entryDate: date,
          exitDate: daily.bars.at(-1)!.date,
          entry: 100,
          exit: 80,
          returnPct: -20,
          action: "区间无除权" as const,
          reasons: [],
          calendarSource: "QA",
          actionSource: "QA",
        },
      ],
    };
    repo.record(strategy, copy);
    repo.outcomes(copy.key, copy.outcomes);
  }
  accounts.freezeExpectation({
    strategyId: strategy.id,
    version: 1,
    strategyHash: createHash("sha256")
      .update(JSON.stringify(strategy))
      .digest("hex"),
    source: "QA fixed strategy distribution",
    horizon: 20,
    basis: "raw-entry-20-close",
    samples: Array.from({ length: 40 }, (_, i) => 0.01 + i / 1000),
    excluded: 0,
    capturedAt: now,
    limitations: ["Synthetic fixture only"],
  });
  repo.saveState("holding-risk", [
    {
      market: "cn-equity",
      symbol: "sh600000",
      account: "sh600000",
      quantity: 3000,
      price: daily.bars.at(-1)!.close,
      cost: 100,
      stop: 90,
      bar: daily.bars.at(-1)!.date,
      observedAt: now,
      sleeve: "swing",
    },
  ]);
}
