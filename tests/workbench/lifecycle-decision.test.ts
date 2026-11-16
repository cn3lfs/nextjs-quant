import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, it } from "vitest";
import type { StrategyObjectInput } from "trading-strategies";
import { settingsSchema } from "~/lib/domain";
import { alertKey, type AlertEvent } from "~/lib/strategy-facts/alerts";
import { migrate } from "~/server/db/migrations";
import { AlertRepository } from "~/server/db/alert-repository";
import { RpsStore } from "~/server/db/rps-store";
import { candidateScanWatermark } from "~/server/alerts/candidate-scan";
import { cryptoRiskSummary } from "~/server/crypto-trading/risk-summary";
import { rpsDay } from "../helpers/rps-fixture";

const now = Date.parse("2026-11-16T17:00:00+08:00");
const alpha: StrategyObjectInput = {
  id: "decision-alpha",
  version: 1,
  market: "cn-equity",
  period: "day",
  universe: { kind: "all-market" },
  entry: { kind: "constant", value: true },
  exit: {},
  sizing: { kind: "weight", weight: 0.1 },
  sleeve: "swing",
};
let db: Database.Database, repo: AlertRepository;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  repo = new AlertRepository(db);
});
afterEach(() => db.close());
function record(
  strategy: StrategyObjectInput,
  symbol: string,
  bar = "2026-11-16",
) {
  const identity = {
    strategyId: strategy.id,
    version: strategy.version,
    market: strategy.market,
    symbol,
    bar,
  };
  const event: AlertEvent = {
    ...identity,
    key: alertKey(identity),
    type: "entry",
    price: 10,
    stop: 9,
    target: null,
    sleeve: strategy.sleeve,
    observedAt: now,
    mode: "shadow",
    status: "shadow",
    reason: `规则${strategy.entry.kind}已由完成bar求值`,
    source: "fixed fixture",
    wouldSend: false,
    outcomes: [],
  };
  repo.record(strategy, event);
  return event;
}
function scan(strategy = alpha, date = "2026-11-16") {
  const state = candidateScanWatermark(strategy, now, date);
  repo.saveState(state.id, state.value);
}
it("merges current scan sources by market and symbol before pagination and never keeps the prior scan after an empty run", () => {
  const beta = { ...alpha, id: "decision-beta" };
  record(alpha, "sh600000", "2026-11-13");
  record(alpha, "sh600001");
  record(beta, "sh600001");
  scan(alpha);
  scan(beta);
  const page = repo.candidatePage({ page: 0 });
  expect(page.total).toBe(1);
  expect(page.items[0]?.sources.map((s) => s.strategyId)).toEqual([
    alpha.id,
    beta.id,
  ]);
  expect(page.items[0]?.symbol).toBe("sh600001");
  scan(alpha, "2026-11-17");
  scan(beta, "2026-11-17");
  expect(repo.candidatePage({ page: 0 })).toEqual({ total: 0, items: [] });
});
it("server ranking precedes pagination and stable order uses symbol when RPS is unavailable", () => {
  const beta = { ...alpha, id: "decision-beta" };
  for (let i = 0; i < 25; i++) {
    const symbol = `sh${600000 + i}`;
    record(alpha, symbol);
    record(beta, symbol);
  }
  scan(alpha);
  scan(beta);
  const first = repo.candidatePage({ page: 0 }),
    second = repo.candidatePage({ page: 1 });
  expect(first.total).toBe(25);
  expect(first.items).toHaveLength(20);
  expect(second.items).toHaveLength(5);
  expect(first.items[0]?.symbol).toBe("sh600000");
  expect(second.items[4]?.symbol).toBe("sh600024");
  expect(
    new Set([...first.items, ...second.items].map((r) => r.symbol)).size,
  ).toBe(25);
  const published = rpsDay();
  new RpsStore(db).saveDay(published.day, published.rows);
  record(alpha, "sz000000");
  record(alpha, "sz000009");
  const ranked = repo.candidatePage({ page: 0 });
  expect(ranked.items[0]?.symbol).toBe("sz000009");
  expect(ranked.items[1]?.symbol).toBe("sz000000");
  expect(
    repo.candidatePage({ page: 0, minimumRps: 80 }).items.map((r) => r.symbol),
  ).toEqual(["sz000009"]);
});
it("watermarks use period-specific UTC completed bars for crypto and the receipt date for delayed A-share scans", () => {
  const crypto = { ...alpha, market: "crypto" as const };
  expect(
    candidateScanWatermark(crypto, Date.parse("2026-11-16T02:00:00Z")).value
      .bar,
  ).toBe("2026-11-15");
  expect(
    candidateScanWatermark(
      { ...crypto, period: "4h" },
      Date.parse("2026-11-16T10:00:00Z"),
    ).value.bar,
  ).toBe("2026-11-16T08:00:00+00:00");
  expect(
    candidateScanWatermark(
      alpha,
      Date.parse("2026-11-17T08:30:00+08:00"),
      "2026-11-16",
    ).value.bar,
  ).toBe("2026-11-16");
});
it("bot risk uses only strategy inventory and explicitly keeps unvalidated bots separate from idle breakout capital", () => {
  repo.records.save("crypto-bot", "crypto-bot-binance-demo", {
    id: "binance-demo",
    status: "running",
    positions: { BTCUSDT: "2", ETHUSDT: "0" },
    updatedAt: now,
  });
  repo.records.save(
    "crypto-account-credential-revision",
    "crypto-account-credential-revision-binance-demo",
    "fixture",
  );
  repo.records.save(
    "crypto-account-snapshot",
    "crypto-account-snapshot-binance-demo-fixture",
    {
      at: now,
      balances: [{ asset: "USDT", total: "99999", free: "99999" }],
      positions: [
        { symbol: "BTCUSDT", total: "100", price: "10", marketValue: "1000" },
      ],
      warnings: [],
    },
  );
  const config = settingsSchema.parse({
    alerts: { capital: { crypto: 1000 } },
  });
  expect(cryptoRiskSummary(repo, config)).toMatchObject({
    bots: [{ id: "binance-demo", validated: false, exposure: 20 }],
    breakout: { share: 0.25, budget: 250, idle: true },
  });
  repo.records.save(
    "crypto-account-snapshot",
    "crypto-account-snapshot-binance-demo-fixture",
    { at: now, positions: [{ symbol: "BTCUSDT", price: null }] },
  );
  expect(cryptoRiskSummary(repo, config).bots[0]?.exposure).toBeNull();
});
