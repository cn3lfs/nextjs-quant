import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { strategyObjectSchema } from "trading-strategies";
import { migrate } from "~/server/db/migrations";
import { PaperRepository } from "~/server/db/paper-repository";
import { StrategyRepository } from "~/server/db/strategy-repository";
import {
  ForwardReferenceRepository,
  forwardSizingPolicyHash,
} from "~/server/db/forward-reference-repository";
import { assessPaperPortfolio } from "~/server/paper/assessment";
import {
  paperAccountRead,
  paperAccountsRead,
  currentPaperAssessment,
} from "~/server/paper/read-projection";
import type {
  FrozenCandidate,
  PaperAccount,
  PaperState,
} from "~/server/paper/model";
import frozen from "~/server/data/paper-candidates.json";

const runtime = vi.hoisted(() => ({ hash: "d".repeat(64), available: true }));
vi.mock("~/server/research/forward-identity", () => ({
  forwardExecutionBuildHash: () => {
    if (!runtime.available) throw new Error("missing manifest");
    return runtime.hash;
  },
}));
const databases: Database.Database[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2025-12-31T00:00:00Z");
  runtime.hash = "d".repeat(64);
  runtime.available = true;
});
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
});
function fixture(backtestPassed = true) {
  const db = new Database(":memory:");
  databases.push(db);
  migrate(db);
  const repo = new PaperRepository(db);
  const strategy = strategyObjectSchema.parse({
    id: "read-account",
    version: 2,
    market: "crypto",
    period: "day",
    sleeve: "swing",
    universe: { kind: "symbols", symbols: ["BTCUSDT"] },
    entry: { kind: "constant", value: false },
    exit: {},
    sizing: { kind: "weight", weight: 1 },
  });
  new StrategyRepository(db).saveStrategy(strategy);
  const bars = Array.from({ length: 120 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 1000,
    amount: 10000,
  }));
  const request: PortfolioRequest = {
    market: "crypto",
    initial: 100000,
    start: bars[0]!.date,
    end: bars.at(-1)!.date,
    calendar: bars.map((bar) => bar.date),
    strategies: [strategy],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 1 }],
    instruments: [
      {
        symbol: "BTCUSDT",
        market: "crypto",
        bars,
        signalBars: bars,
        execution: {
          evidence: "tiny read fixture",
          minimum: 0.001,
          step: 0.001,
          tradable: true,
          limitUp: null,
          limitDown: null,
        },
      },
    ],
  };
  const references = new ForwardReferenceRepository(db);
  const reference = references.freeze({
    strategy,
    inputHash: "a".repeat(64),
    resultHash: "b".repeat(64),
    buildHash: runtime.hash,
    initial: request.initial,
    sizingPolicyHash: forwardSizingPolicyHash(request),
    backtestPassed,
    method: "lifecycle-2",
    purpose: "preregistered",
    slippageBasis: "paper-model",
    source: "tiny read fixture",
    distribution: {
      days: Array.from({ length: 240 }, (_, i) => ({
        date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
        return: 0,
        signals: 0,
      })),
      tradeReturns: [],
      slippageBps: [],
    },
  });
  const account: PaperAccount = {
    id: "paper:read-account",
    market: "crypto",
    currency: "USDT",
    sleeve: "swing",
    startedAt: Date.parse("2026-01-01T00:00:00Z"),
    initial: request.initial,
    candidates: [
      { ...frozen.candidates[0], strategy } as unknown as FrozenCandidate,
    ],
    mirror: { venue: "off" },
    mirrorRevision: "fixture",
    revision: 0,
    lastBar: request.end,
    lastRun: null,
    error: null,
    summary: null,
  };
  references.bindPaper(account.id, strategy, account.startedAt);
  const state: PaperState = {
    request,
    result: runPortfolio(request),
    benchmark: bars,
    decisions: bars.map((bar) => ({
      strategyId: strategy.id,
      symbol: "BTCUSDT",
      date: bar.date,
      entry: false,
      exit: false,
      stop: null,
      observedAt: Date.parse(bar.date) + 86400000 + 60000,
      source: "fixed clock",
    })),
  };
  vi.setSystemTime("2026-05-01T12:00:00Z");
  account.summary = {
    return: 0,
    drawdown: 0,
    trades: 0,
    winRate: null,
    benchmarkReturn: 0,
    signals: 0,
    days: 120,
    assessment: assessPaperPortfolio(account, state, Date.now(), {
      reference,
      buildHash: runtime.hash,
      calendar: [],
    }),
  };
  repo.create(account);
  return { repo, account, state };
}

it("projects a real same-account conformance without reading state or modifying financial history", () => {
  const f = fixture();
  const bytes = f.repo.db.prepare("SELECT payload FROM paper_accounts").get();
  const prepare = vi.spyOn(f.repo.db, "prepare");
  const list = paperAccountsRead(f.repo);
  const detail = paperAccountRead(f.account.id, f.repo);
  expect(detail.currentAssessment).toMatchObject({
    verdict: "conforming",
    eligible: true,
    days: 120,
  });
  expect(list[0]!.currentAssessment).toEqual(detail.currentAssessment);
  expect(list[0]).not.toHaveProperty("candidates");
  expect(detail.summary).toMatchObject({ return: 0, trades: 0, days: 120 });
  expect(detail.summary).not.toHaveProperty("assessment");
  expect(
    prepare.mock.calls.every(([sql]) => !sql.includes("paper_state")),
  ).toBe(true);
  expect(f.repo.db.prepare("SELECT payload FROM paper_accounts").get()).toEqual(
    bytes,
  );
});

it("hides legacy positive recommendations while retaining the original record", () => {
  const f = fixture();
  f.account.summary!.assessment = {
    recommendation: "OLD POSITIVE LIVE RECOMMENDATION",
    eligible: true,
    reasons: [],
  };
  f.repo.save(f.account, 0);
  const detail = paperAccountRead(f.account.id, f.repo);
  expect(detail.currentAssessment).toMatchObject({
    verdict: "insufficient",
    eligible: false,
  });
  expect(JSON.stringify(detail)).not.toContain("OLD POSITIVE");
  expect(
    f.repo.account(f.account.id)!.summary!.assessment!.recommendation,
  ).toContain("OLD POSITIVE");
});

it.each([
  "build",
  "reference",
  "definition",
  "version",
  "runtime",
  "missing-conformance",
])("rejects %s evidence mismatch", (mode) => {
  const f = fixture();
  if (mode === "build") runtime.hash = "e".repeat(64);
  if (mode === "reference")
    f.account.summary!.assessment!.referenceHash = "f".repeat(64);
  if (mode === "definition")
    f.account.candidates[0]!.strategy.entry = { kind: "constant", value: true };
  if (mode === "version") f.account.candidates[0]!.strategy.version = 3;
  if (mode === "runtime") runtime.available = false;
  if (mode === "missing-conformance")
    delete f.account.summary!.assessment!.conformance;
  f.repo.save(f.account, 0);
  expect(paperAccountsRead(f.repo)[0]!.currentAssessment).toMatchObject({
    verdict: "insufficient",
    eligible: false,
  });
});

it("does not borrow conformance from another account with the same strategy version", () => {
  const f = fixture();
  f.repo.create({ ...f.account, id: "paper:unbound-same-version" });
  const rows = paperAccountsRead(f.repo);
  expect(
    rows.find((a) => a.id === f.account.id)!.currentAssessment.eligible,
  ).toBe(true);
  expect(
    rows.find((a) => a.id !== f.account.id)!.currentAssessment,
  ).toMatchObject({
    verdict: "insufficient",
    eligible: false,
    reasons: expect.arrayContaining(["missing-same-account-forward-reference"]),
  });
});

it("requires backtest AND conforming and treats contradictory persisted eligibility as insufficient", () => {
  const f = fixture(false);
  expect(currentPaperAssessment(f.account, f.repo)).toMatchObject({
    verdict: "conforming",
    eligible: false,
  });
  f.account.summary!.assessment!.eligible = true;
  expect(currentPaperAssessment(f.account, f.repo)).toMatchObject({
    verdict: "insufficient",
    eligible: false,
    reasons: expect.arrayContaining(["inconsistent-current-paper-conformance"]),
  });
});
