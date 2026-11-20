import type Database from "better-sqlite3";
import type { PortfolioRequest } from "quant-backtest";
import { PaperRepository } from "../../src/server/db/paper-repository";
import { registerPaperCandidates } from "../../src/server/paper/registration";
import { advancePaper } from "../../src/server/paper/advance";
import frozen from "../../src/server/data/paper-candidates.json";
import type {
  FrozenCandidate,
  PaperAccount,
} from "../../src/server/paper/model";
import type { StrategyObjectInput } from "trading-strategies";

/** Fixed synthetic QA data. These records are never natural forward evidence. */
export function seedR2cFixture(db: Database.Database) {
  const repo = new PaperRepository(db);
  const now = Date.parse("2026-11-16T00:01:00Z");
  registerPaperCandidates(repo, now, {}, { allowLegacyFixtures: true });
  const strategy: StrategyObjectInput = {
    id: "QA-r2c",
    version: 1,
    market: "crypto",
    period: "day",
    sleeve: "swing",
    universe: { kind: "symbols", symbols: ["BTCUSDT"] },
    entry: { kind: "formula", source: "选股:C=10;" },
    exit: { rule: { kind: "formula", source: "退出:C<10;" } },
    sizing: { kind: "weight", weight: 1, tranches: 1 },
  };
  const candidate = {
    ...(frozen.candidates[3] as unknown as FrozenCandidate),
    strategy,
  };
  const account: PaperAccount = {
    id: "paper:QA-r2c",
    market: "crypto",
    currency: "USDT",
    sleeve: "swing",
    startedAt: Date.parse("2026-11-10T00:00:00Z"),
    initial: 10000,
    candidates: [candidate],
    mirror: { venue: "off" },
    mirrorRevision: "QA",
    revision: 0,
    lastBar: null,
    lastRun: null,
    error: null,
    summary: null,
  };
  repo.create(account);
  const dates = Array.from({ length: 6 }, (_, i) =>
    new Date(Date.parse("2026-11-10") + i * 86400000)
      .toISOString()
      .slice(0, 10),
  );
  const bars = dates.map((date, i) => ({
    date,
    open: i === 2 || i === 3 ? 9 : 10,
    close: i === 2 || i === 3 ? 9 : 10,
    high: 11,
    low: 8,
    volume: 1000,
    amount: 10000,
  }));
  const request: PortfolioRequest = {
    market: "crypto",
    initial: account.initial,
    start: dates[0]!,
    end: dates.at(-1)!,
    calendar: dates,
    instruments: [
      {
        symbol: "BTCUSDT",
        market: "crypto",
        bars,
        signalBars: bars,
        execution: {
          evidence: "QA fixed venue grid",
          minimum: 0.001,
          step: 0.001,
          limitDown: null,
          limitUp: null,
          tradable: true,
        },
      },
    ],
    strategies: [strategy],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 1, maxPositions: 1 }],
  };
  advancePaper(
    repo,
    account.id,
    {
      request,
      benchmark: bars,
      source: "fixed synthetic QA; not live forward results",
      readyDates: dates,
    },
    now,
  );
}
