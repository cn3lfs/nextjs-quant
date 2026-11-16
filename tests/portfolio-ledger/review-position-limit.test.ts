import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { strategyObjectSchema } from "trading-strategies";
import { executionCostsSchema } from "trading-strategy-core/costs";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { settingsSchema } from "~/lib/domain";
import type { AccountPosition } from "~/lib/portfolio/account-workspace";
import { migrate } from "~/server/db/migrations";
import { AlertRepository } from "~/server/db/alert-repository";
import { AccountWorkspaceRepository } from "~/server/db/account-workspace-repository";
import { PaperRepository } from "~/server/db/paper-repository";
import type { FrozenCandidate } from "~/server/paper/model";
import { loadAccountBook } from "~/server/portfolio/account-workspace-service";
import { accountWeeklyReview } from "~/server/portfolio/account-review-service";

const connections: Database.Database[] = [];
afterEach(() => connections.splice(0).forEach((db) => db.close()));
const now = Date.parse("2026-11-16T18:00:00+08:00");
async function fixture(maxPositions: number | null = 1) {
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  const repo = new AccountWorkspaceRepository(db),
    alerts = new AlertRepository(db),
    paper = new PaperRepository(db);
  const strategy = strategyObjectSchema.parse({
    id: "same-version-count",
    version: 1,
    market: "cn-equity",
    period: "day",
    sleeve: "swing",
    universe: {
      kind: "symbols",
      symbols: ["sh600001", "sh600002", "sh600003"],
    },
    entry: { kind: "constant", value: false },
    exit: {},
    sizing: { kind: "equal", positions: 99 },
  });
  alerts.strategies.saveStrategy(strategy);
  const candidate: FrozenCandidate = {
    strategy,
    ...(maxPositions === null
      ? {}
      : {
          executionPolicy: {
            initial: 100000,
            sleeves: [
              { id: "swing", share: 1, riskPerTrade: 0.02, maxPositions },
            ],
            costs: executionCostsSchema.parse({}),
          },
        }),
    row: {
      id: strategy.id,
      market: strategy.market,
      sleeve: strategy.sleeve,
      level: "strategy",
      rule: "constant",
      status: "research",
      reasons: [],
      return: null,
      excess: null,
      drawdown: null,
      trades: 0,
      oosWindows: 0,
      positiveWindows: 0,
      bias: {
        universe: "fixture",
        adjustment: "none",
        financial: "none",
        execution: "fixture",
      },
    },
    registration: {
      status: "shadow-candidate",
      active: false,
      trialSharpes: [],
      neighbors: [],
      sizing: "equal",
      completeMarketCycles: 0,
      lowZoneCorroborated: false,
    },
    expectation: { windows: [], holdout: null },
  };
  const account = {
    id: "count-source",
    market: "cn-equity" as const,
    currency: "CNY" as const,
    sleeve: "swing",
    startedAt: now,
    initial: 100000,
    candidates: [candidate],
    mirror: { venue: "off" as const },
    mirrorRevision: "off",
    revision: 0,
    lastBar: null,
    lastRun: null,
    summary: null,
    error: null,
  };
  paper.create(account);
  const context = {
    today: "2026-11-16",
    calendar: ["2026-11-16"],
    calendarSource: "fixture",
    evidence: () => ({
      events: [],
      coverageEnd: "2026-11-16",
      source: "fixture",
    }),
  };
  const book = await loadAccountBook(repo, settingsSchema.parse({}), now, {
    context,
    bars: {},
  });
  const position = (symbol: string): AccountPosition => ({
    id: symbol,
    account: "real",
    kind: "real",
    market: "cn-equity",
    currency: "CNY",
    symbol,
    sleeve: "swing",
    industry: "银行",
    industryGroups: ["银行"],
    quantity: 100,
    cost: 10,
    price: 10,
    value: 1000,
    stop: 9,
    at: "2026-11-16",
    strategyId: strategy.id,
    strategyVersion: 1,
    reasons: [],
  });
  book.positions = [position("sh600001"), position("sh600002")];
  const review = () => accountWeeklyReview(book, "2026-11-16", repo, now);
  return { db, repo, paper, candidate, account, book, review, position };
}

it("uses the frozen sleeve limit rather than equal.positions, and deduplicates held/reserved symbols", async () => {
  const f = await fixture();
  for (const symbol of ["sh600002", "sh600003"])
    f.book.facts.plans.push({
      id: symbol,
      strategyId: f.candidate.strategy.id,
      strategyVersion: 1,
      market: "cn-equity",
      symbol,
      sleeve: "swing",
      triggerKey: "fixture",
      entry: 10,
      stop: 9,
      target: null,
      quantity: 100,
      tranches: 1,
      expiresAt: null,
      status: "open",
    });
  const suggestion = f
    .review()
    .suggestions.find((s) => s.id.endsWith(":positions"));
  expect(suggestion?.action).toBe("reduce");
  expect(suggestion?.reason).toContain("3 > 1");
  expect(f.paper.account(f.account.id)).toEqual(f.account);
});

it("does not charge another sleeve or paper inventory to the real sleeve count", async () => {
  const f = await fixture(2);
  f.book.positions.push(
    { ...f.position("sh600003"), sleeve: "breakout" },
    { ...f.position("sh600004"), kind: "paper" },
  );
  expect(f.review().suggestions.some((s) => s.id.endsWith(":positions"))).toBe(
    false,
  );
  expect(f.review().riskUnknown.some((s) => s.includes("breakout"))).toBe(true);
});

it("reports missing policy without guessing the legacy default or equal.positions", async () => {
  const f = await fixture(null),
    result = f.review();
  expect(result.suggestions.some((s) => s.id.endsWith(":positions"))).toBe(
    false,
  );
  expect(result.riskUnknown.join(";")).toContain("不按默认仓位政策推算");
});

it("can read an older account's actual saved request policy without synthesizing a frozen policy", async () => {
  const f = await fixture(null);
  const bars = ["2026-11-12", "2026-11-13"].map((date) => ({
    date,
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 10000,
    amount: 100000,
  }));
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: f.account.initial,
    start: bars[0]!.date,
    end: bars.at(-1)!.date,
    calendar: bars.map((b) => b.date),
    strategies: [f.candidate.strategy],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 1 }],
    instruments: ["sh600001", "sh600002", "sh600003"].map((symbol) => ({
      symbol,
      market: "cn-equity",
      bars,
      signalBars: bars,
      execution: {
        evidence: "fixture",
        minimum: 100,
        step: 100,
        tradable: true,
        limitUp: null,
        limitDown: null,
      },
    })),
  };
  f.paper.saveState(f.account.id, {
    request,
    result: runPortfolio(request),
    benchmark: bars,
    decisions: [],
  });
  f.book.facts.paper[0]!.state = f.paper.state(f.account.id);
  expect(
    f.review().suggestions.find((s) => s.id.endsWith(":positions"))?.reason,
  ).toContain("2 > 1");
});

it("reports conflicting same-sleeve version policies instead of selecting a convenient limit", async () => {
  const f = await fixture(1);
  const other = strategyObjectSchema.parse({
    ...f.candidate.strategy,
    id: "another-strategy",
  });
  f.book.facts.definitions.push(other);
  f.book.facts.paper.push({
    account: {
      ...f.account,
      id: "another-source",
      candidates: [
        {
          ...f.candidate,
          strategy: other,
          executionPolicy: {
            ...f.candidate.executionPolicy!,
            sleeves: [
              { id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 2 },
            ],
          },
        },
      ],
    },
    state: null,
  });
  f.book.positions[1]!.strategyId = other.id;
  expect(f.review().riskUnknown.join(";")).toContain("上限不一致");
  expect(f.review().suggestions.some((s) => s.id.endsWith(":positions"))).toBe(
    false,
  );
});

it("refuses ambiguous same-version accounts and unassigned real positions", async () => {
  const f = await fixture();
  f.book.facts.paper.push({
    ...f.book.facts.paper[0]!,
    account: { ...f.account, id: "second" },
  });
  expect(f.review().riskUnknown.join(";")).toContain("来源不唯一");
  f.book.facts.paper.pop();
  f.book.positions[0]!.strategyId = null;
  expect(f.review().riskUnknown.join(";")).toContain("缺少唯一策略/版本归属");
  expect(f.review().suggestions.some((s) => s.id.endsWith(":positions"))).toBe(
    false,
  );
});
