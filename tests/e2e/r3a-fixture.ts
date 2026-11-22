import type Database from "better-sqlite3";
import { AlertRepository } from "../../src/server/db/alert-repository";
import { settingsSchema } from "../../src/lib/domain";
import { alertKey, type AlertEvent } from "../../src/lib/strategy-facts/alerts";
import type { StrategyObjectInput } from "trading-strategies";
import daily from "../fixtures/breakout-valid.json";
import { seedDailyProtection } from "./lifecycle-daily-fixture";

export function seedR3aFixture(db: Database.Database) {
  const repo = new AlertRepository(db);
  const now = Date.now();
  const bar = daily.bars.at(-1)!;
  const record = db
    .prepare("SELECT payload FROM records WHERE id='settings'")
    .get() as { payload: string };
  const config = settingsSchema.parse(JSON.parse(record.payload));
  config.alerts.capital["cn-equity"] = 100000;
  db.prepare("UPDATE records SET payload=? WHERE id='settings'").run(
    JSON.stringify(config),
  );
  const strategy: StrategyObjectInput = {
    id: "r3a-shadow-qa",
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: ["sh600000"] },
    entry: { kind: "constant", value: true },
    exit: { stop: { kind: "fixed", fraction: 0.1 }, takeProfit: 0.3 },
    sizing: { kind: "weight", weight: 1 },
    sleeve: "swing",
  };
  repo.saveState(`shadow:${strategy.id}:1`, {
    active: true,
    startedAt: now,
    status: "shadow-candidate",
  });
  const identity = {
    type: "entry" as const,
    price: bar.close,
    strategyId: strategy.id,
    version: 1,
    market: "cn-equity" as const,
    symbol: "sh600000",
    bar: bar.date,
  };
  const event: AlertEvent = {
    ...identity,
    key: alertKey(identity),
    stop: bar.close * 0.9,
    target: bar.close * 1.3,
    sleeve: "swing",
    observedAt: now,
    mode: "shadow",
    status: "shadow",
    wouldSend: false,
    outcomes: [],
    reason: "R3a合成日常路径候选，不是真实信号",
    source: "breakout-valid fixed fixture",
  };
  repo.record(strategy, event);
  repo.saveState(`candidate-scan:cn-equity:${strategy.id}:1`, {
    bar: bar.date,
    observedAt: now,
  });
  repo.saveState("exposure", [
    { market: "cn-equity", sleeve: "__checked__", value: 0, at: now },
  ]);
  repo.saveState("holding-risk", [
    {
      market: "cn-equity",
      symbol: "sh600000",
      account: "QA",
      quantity: 100,
      price: bar.close,
      cost: bar.close * 0.95,
      stop: bar.close * 0.9,
      bar: bar.date,
      observedAt: now,
      sleeve: "swing",
    },
  ]);
  for (const [market, symbol] of [
    ["cn-equity", "sh000300"],
    ["cn-equity", "sz399006"],
    ["crypto", "BTCUSDT"],
    ["crypto", "ETHUSDT"],
  ])
    repo.saveState(`regime:${market}:${symbol}`, {
      trend: "up",
      temperature: 65,
      zone: "normal",
      basis: "QA fixed synthetic regime",
      bar: bar.date,
      observedAt: now,
      source: "QA fixture",
      ...(market === "cn-equity"
        ? { low: { depth: 0, confidence: "price-only" } }
        : {}),
    });
  repo.saveState("runtime", { lastCheck: now, lastPhase: "fixture" });
  seedDailyProtection(db, now);
}
