import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { strategyObjectSchema } from "trading-strategies";
import { migrate } from "~/server/db/migrations";
import { PaperRepository } from "~/server/db/paper-repository";
import { AlertRepository } from "~/server/db/alert-repository";
import {
  ForwardReferenceRepository,
  forwardSizingPolicyHash,
} from "~/server/db/forward-reference-repository";
import { forwardExecutionBuildHash } from "~/server/research/forward-identity";
import { assessPaperPortfolio } from "~/server/paper/assessment";
import { strategyLabDetail, actOnLabStrategy } from "~/server/db/strategy-lab";
import { workspaceCandidate } from "~/server/alerts/workspace";
import { alertKey, type AlertEvent } from "~/lib/strategy-facts/alerts";
import type {
  PaperAccount,
  PaperState,
  FrozenCandidate,
} from "~/server/paper/model";
import frozen from "~/server/data/paper-candidates.json";
import {
  portfolioClosedTradeReturns,
  portfolioModelSlippage,
} from "~/lib/backtest/portfolio-forward-distribution";

const connections: Database.Database[] = [];
vi.mock("~/server/research/forward-identity", () => ({
  forwardExecutionBuildHash: () => "d".repeat(64),
}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2025-12-31T00:00:00Z");
});
afterEach(() => {
  connections.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
});
function fixture() {
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  const paper = new PaperRepository(db),
    references = new ForwardReferenceRepository(db),
    alerts = new AlertRepository(db);
  const strategy = strategyObjectSchema.parse({
    id: "forward-fixture",
    version: 1,
    market: "crypto",
    period: "day",
    sleeve: "swing",
    universe: { kind: "symbols", symbols: ["BTCUSDT"] },
    entry: { kind: "constant", value: false },
    exit: {},
    sizing: { kind: "weight", weight: 1 },
  });
  const dates = Array.from({ length: 120 }, (_, i) =>
    new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
  );
  const bars = dates.map((date) => ({
    date,
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
    start: dates[0]!,
    end: dates.at(-1)!,
    calendar: dates,
    strategies: [strategy],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 1 }],
    instruments: [
      {
        symbol: "BTCUSDT",
        market: "crypto",
        bars,
        signalBars: bars,
        execution: {
          evidence: "fixed fixture",
          minimum: 0.001,
          step: 0.001,
          tradable: true,
          limitUp: null,
          limitDown: null,
        },
      },
    ],
  };
  const state: PaperState = {
    request,
    result: runPortfolio(request),
    benchmark: bars,
    decisions: dates.map((date) => ({
      strategyId: strategy.id,
      symbol: "BTCUSDT",
      date,
      entry: false,
      exit: false,
      stop: null,
      observedAt: Date.parse(date) + 86400000 + 60000,
      source: "prospective fixed-clock fixture",
    })),
  };
  const account: PaperAccount = {
    id: "paper:forward-fixture",
    market: "crypto",
    currency: "USDT",
    sleeve: "swing",
    startedAt: Date.parse("2026-01-01T00:00:00Z"),
    initial: request.initial,
    candidates: [
      { ...(frozen.candidates[0] as unknown as FrozenCandidate), strategy },
    ],
    mirror: { venue: "off" },
    mirrorRevision: "fixture",
    revision: 0,
    lastBar: dates.at(-1)!,
    lastRun: null,
    error: null,
    summary: null,
  };
  paper.create(account);
  alerts.strategies.saveStrategy(strategy);
  const buildHash = forwardExecutionBuildHash();
  const freeze = (backtestPassed = true) =>
    references.freeze({
      strategy,
      distribution: {
        days: Array.from({ length: 240 }, (_, i) => ({
          date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
          return: 0,
          signals: 0,
        })),
        tradeReturns: [],
        slippageBps: [],
      },
      inputHash: "a".repeat(64),
      resultHash: "b".repeat(64),
      buildHash,
      initial: request.initial,
      sizingPolicyHash: forwardSizingPolicyHash(request),
      backtestPassed,
      method: "lifecycle-2",
      purpose: "preregistered",
      slippageBasis: "paper-model",
      source:
        "isolated synthetic distribution fixture; not historical performance",
    });
  const now = Date.parse("2026-05-01T00:01:00Z");
  return {
    db,
    paper,
    references,
    alerts,
    strategy,
    state,
    account,
    freeze,
    now,
    buildHash,
  };
}
describe("registered immutable paper conformance", () => {
  it("aggregates a real4h engine checkpoint's bar curve and signals into UTC days", () => {
    const f = fixture();
    const strategy = strategyObjectSchema.parse({
      ...f.strategy,
      period: "4h",
      entry: { kind: "constant", value: true },
      exit: { maxBars: 1 },
    });
    const bars = Array.from({ length: 120 * 6 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, 1, (i + 1) * 4)).toISOString(),
      open: 10,
      high: 11,
      low: 9,
      close: 10,
      volume: 1000,
      amount: 10000,
    }));
    const request: PortfolioRequest = {
      ...f.state.request,
      end: bars.at(-1)!.date.slice(0, 10),
      strategies: [strategy],
      calendar: bars.map((bar) => bar.date),
      instruments: [
        { ...f.state.request.instruments[0]!, bars, signalBars: bars },
      ],
      costs: {
        version: "cost-experiment-1",
        commissionBps: 0,
        minimumCommission: 0,
        sellTaxBps: 0,
        slippageBps: 0,
      },
    };
    const result = runPortfolio(request);
    expect(result.curve).toHaveLength(720);
    const state: PaperState = {
      request,
      result,
      benchmark: bars,
      decisions: bars.map((bar) => ({
        strategyId: strategy.id,
        symbol: "BTCUSDT",
        date: bar.date,
        entry: true,
        exit: false,
        stop: null,
        observedAt: Date.parse(bar.date) + 60000,
        source: "fixed prospective4h fixture",
      })),
    };
    const account = {
      ...f.account,
      candidates: [{ ...f.account.candidates[0]!, strategy }],
    };
    const reference = f.references.freeze({
      strategy,
      distribution: {
        days: Array.from({ length: 240 }, (_, i) => ({
          date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
          return: 0,
          signals: 6,
        })),
        tradeReturns: Array(40).fill(0),
        slippageBps: Array(40).fill(0),
      },
      inputHash: "a".repeat(64),
      resultHash: "b".repeat(64),
      buildHash: f.buildHash,
      initial: request.initial,
      sizingPolicyHash: forwardSizingPolicyHash(request),
      backtestPassed: true,
      method: "lifecycle-2",
      purpose: "preregistered",
      slippageBasis: "paper-model",
      source: "native4h-engine fixture",
    });
    vi.setSystemTime(f.now);
    const context = { reference, buildHash: f.buildHash, calendar: [] };
    const daily = assessPaperPortfolio(account, state, f.now, context);
    const fromCurve = assessPaperPortfolio(
      account,
      { ...state, result: { ...result, equity: result.curve } },
      f.now,
      context,
    );
    expect(fromCurve).toEqual(daily);
    expect(fromCurve.conformance).toMatchObject({
      days: 120,
      verdict: "conforming",
    });
    expect(fromCurve.conformance!.signalRate.observed).toBeCloseTo(6, 12);
    expect(fromCurve.conformance!.equity.lowerPath[0]!.date).toBe("2026-01-01");
    expect(fromCurve.conformance!.equity.lowerPath.at(-1)!.date).toBe(
      "2026-04-30",
    );
    expect(fromCurve.conformance!.entries).toBe(
      result.fills.filter(
        (fill) => fill.side === "buy" && fill.holdingAfter === fill.quantity,
      ).length,
    );
    expect(fromCurve.reasons).toEqual([]);
  });
  it("binds the reference before registration, then requires conforming forward evidence before manual promotion/live", () => {
    const f = fixture(),
      reference = f.freeze();
    vi.setSystemTime(f.account.startedAt);
    f.references.bindPaper(f.account.id, f.strategy, f.account.startedAt);
    vi.setSystemTime(f.now);
    const assessment = assessPaperPortfolio(f.account, f.state, f.now, {
      reference,
      buildHash: f.buildHash,
      calendar: [],
    });
    expect(assessment).toMatchObject({
      verdict: "conforming",
      eligible: true,
      slippageBasis: "paper-model",
      realExecutionVerified: false,
    });
    f.paper.save(
      {
        ...f.account,
        summary: {
          return: 0,
          drawdown: 0,
          trades: 0,
          winRate: null,
          benchmarkReturn: 0,
          signals: 0,
          days: 120,
          assessment,
        },
      },
      0,
    );
    let detail = strategyLabDetail(f.strategy.id, 1, f.alerts);
    expect(detail.eligible).toBe(true);
    expect(detail.live).toBe(false);
    const candidate = {
      strategyId: f.strategy.id,
      version: 1,
      market: f.strategy.market,
      symbol: "BTCUSDT",
      bar: "2026-04-30",
      key: "",
      type: "entry",
      price: 10,
      stop: 9,
      target: null,
      sleeve: f.strategy.sleeve,
      observedAt: f.now,
      mode: "shadow",
      status: "shadow",
      reason: "synthetic prospective fixture",
      source: "fixed fixture",
      wouldSend: false,
      outcomes: [],
    } satisfies AlertEvent;
    candidate.key = alertKey(candidate);
    expect(workspaceCandidate(candidate, f.alerts, f.now).qualification).toBe(
      "research",
    );
    detail = actOnLabStrategy(
      {
        id: f.strategy.id,
        version: 1,
        action: "promote",
        confirmed: true,
        revision: detail.revision,
      },
      f.alerts,
    );
    expect(workspaceCandidate(candidate, f.alerts, f.now).qualification).toBe(
      "promoted",
    );
    detail = actOnLabStrategy(
      {
        id: f.strategy.id,
        version: 1,
        action: "live",
        confirmed: true,
        revision: detail.revision,
      },
      f.alerts,
    );
    expect(detail.live).toBe(true);
    expect(f.alerts.subscriptions()).toEqual([]);
    expect(f.alerts.records.read("settings")).toBeUndefined();
  });
  it("missing/late reference bindings cannot be repaired retrospectively", () => {
    const f = fixture();
    vi.setSystemTime(f.account.startedAt);
    expect(
      f.references.bindPaper(f.account.id, f.strategy, f.account.startedAt)
        .contentHash,
    ).toBeNull();
    vi.setSystemTime(f.now);
    const late = f.freeze();
    expect(
      f.references.bindPaper(f.account.id, f.strategy, f.account.startedAt)
        .contentHash,
    ).toBeNull();
    expect(
      f.references.paper(f.account.id, f.strategy, f.account.startedAt),
    ).toBeNull();
    const assessment = assessPaperPortfolio(f.account, f.state, f.now, {
      reference: null,
      buildHash: f.buildHash,
      calendar: [],
    });
    expect(assessment.verdict).toBe("insufficient");
    expect(assessment.reasons).toContain("missing-frozen-forward-distribution");
    expect(
      assessPaperPortfolio(f.account, f.state, f.now, {
        reference: late,
        buildHash: f.buildHash,
        calendar: [],
      }).reasons,
    ).toContain("reference-not-frozen-before-registration");
  });
  it("conforming shadow cannot pass failed backtest gates; only an explicit warning acknowledgement can enable unvalidated live", () => {
    const f = fixture(),
      reference = f.freeze(false);
    f.references.bindPaper(f.account.id, f.strategy, f.account.startedAt);
    vi.setSystemTime(f.now);
    const assessment = assessPaperPortfolio(f.account, f.state, f.now, {
      reference,
      buildHash: f.buildHash,
      calendar: [],
    });
    expect(assessment).toMatchObject({
      verdict: "conforming",
      eligible: false,
      backtestPassed: false,
    });
    f.paper.save(
      {
        ...f.account,
        summary: {
          return: 0,
          drawdown: 0,
          trades: 0,
          winRate: null,
          benchmarkReturn: 0,
          signals: 0,
          days: 120,
          assessment,
        },
      },
      0,
    );
    const detail = strategyLabDetail(f.strategy.id, 1, f.alerts);
    expect(() =>
      actOnLabStrategy(
        {
          id: f.strategy.id,
          version: 1,
          action: "promote",
          confirmed: true,
          revision: detail.revision,
        },
        f.alerts,
      ),
    ).toThrow("晋级门槛");
    expect(() =>
      actOnLabStrategy(
        {
          id: f.strategy.id,
          version: 1,
          action: "live",
          confirmed: true,
          revision: detail.revision,
        },
        f.alerts,
      ),
    ).toThrow("明确接受");
    expect(
      actOnLabStrategy(
        {
          id: f.strategy.id,
          version: 1,
          action: "live",
          confirmed: true,
          riskAccepted: true,
          revision: detail.revision,
        },
        f.alerts,
      ).live,
    ).toBe(true);
    expect(f.alerts.state(`strategy:${f.strategy.id}:1`)).toMatchObject({
      unvalidatedOverride: true,
    });
  });
  it("old bars observed late remain accounting only, and differing sizing/version evidence is insufficient", () => {
    const f = fixture(),
      reference = f.freeze();
    vi.setSystemTime(f.now);
    const late = {
      ...f.state,
      decisions: f.state.decisions.map((decision) => ({
        ...decision,
        observedAt: f.now,
      })),
    };
    expect(
      assessPaperPortfolio(f.account, late, f.now, {
        reference,
        buildHash: f.buildHash,
        calendar: [],
      }).reasons,
    ).toContain("incomplete-observed-forward-evidence");
    expect(
      assessPaperPortfolio(
        f.account,
        { ...f.state, request: { ...f.state.request, initial: 200000 } },
        f.now,
        { reference, buildHash: f.buildHash, calendar: [] },
      ).reasons,
    ).toContain("forward-sizing-policy-mismatch");
    expect(
      assessPaperPortfolio(f.account, f.state, f.now, {
        reference,
        buildHash: "c".repeat(64),
        calendar: [],
      }).reasons,
    ).toContain("forward-version-mismatch");
  });
  it("verifies immutable bytes and never changes an existing registration binding", () => {
    const f = fixture(),
      first = f.freeze();
    f.references.bindPaper(f.account.id, f.strategy, f.account.startedAt);
    vi.setSystemTime(f.now);
    f.freeze();
    expect(
      f.references.paper(f.account.id, f.strategy, f.account.startedAt)
        ?.contentHash,
    ).toBe(first.contentHash);
    f.db
      .prepare(
        "UPDATE records SET payload=json_set(payload,'$.days[0].return',0.1) WHERE id=?",
      )
      .run(`forward-reference:${first.contentHash}`);
    expect(() => f.references.read(first.contentHash)).toThrow("hash mismatch");
  });
  it("includes fees in trade-return distributions and rejects a stop's bar open as an intended quote", () => {
    const f = fixture();
    const buy = {
      orderId: 1,
      strategyId: f.strategy.id,
      symbol: "BTCUSDT",
      sleeve: "swing",
      side: "buy" as const,
      signalAt: "2026-01-01",
      date: "2026-01-02",
      quantity: 100,
      price: 10,
      fee: 5,
      holdingAfter: 100,
      cashAfter: 98995,
    };
    const sell = {
      ...buy,
      orderId: 2,
      side: "sell" as const,
      date: "2026-01-03",
      price: 11,
      holdingAfter: 0,
      cashAfter: 100090,
    };
    const result = {
      ...f.state.result,
      fills: [buy, sell],
      orders: [
        {
          id: 2,
          strategyId: f.strategy.id,
          symbol: "BTCUSDT",
          sleeve: "swing",
          side: "sell" as const,
          trigger: "stop" as const,
          signalAt: sell.signalAt,
          due: sell.date,
          status: "filled" as const,
          reason: null,
          attempts: 1,
        },
      ],
    };
    expect(portfolioClosedTradeReturns(result)[0]!.return).toBeCloseTo(
      90 / 1005,
      12,
    );
    expect(portfolioModelSlippage(result, f.state.request)).toMatchObject({
      missing: 2,
      samples: [],
    });
  });
});
