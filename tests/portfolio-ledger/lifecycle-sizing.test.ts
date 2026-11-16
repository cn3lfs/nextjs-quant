import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  runPortfolio,
  sizePortfolioEntry,
  portfolioExecutionFee,
  sizePortfolioTargetEntry,
} from "quant-backtest";
import type { StrategyObjectInput } from "trading-strategies";
import { marketRules } from "trading-strategy-core/market-rules";
import { executionCostsSchema } from "trading-strategy-core/costs";
import { migrate } from "~/server/db/migrations";
import { AlertRepository } from "~/server/db/alert-repository";
import { PaperRepository } from "~/server/db/paper-repository";
import { createAlertPlan, previewAlertPlan } from "~/server/alerts/plans";
import { planSizingPolicy } from "~/server/alerts/plan-sizing";
import { settingsSchema } from "~/lib/domain";
import { alertKey, type AlertEvent } from "~/lib/strategy-facts/alerts";
import { runPaperPortfolio } from "~/server/strategies/drivers/paper";
import frozen from "~/server/data/paper-candidates.json";
import type { FrozenCandidate, PaperAccount } from "~/server/paper/model";
import type { AccountPosition } from "~/lib/portfolio/account-workspace";

const connections: Database.Database[] = [];
afterEach(() => connections.splice(0).forEach((db) => db.close()));
const equityCosts = executionCostsSchema.parse(marketRules["cn-equity"].costs);
const now = Date.parse("2026-11-16T10:00:00+08:00");
const config = settingsSchema.parse({
  alerts: {
    capital: { "cn-equity": 100000, crypto: 100000 },
    sleeves: [
      { id: "swing", market: "cn-equity", share: 1, risk: 0.02 },
      { id: "swing", market: "crypto", share: 1, risk: 0.02 },
    ],
  },
});
const strategy: StrategyObjectInput = {
  id: "sizing-parity",
  version: 1,
  market: "cn-equity",
  period: "day",
  sleeve: "swing",
  universe: { kind: "symbols", symbols: ["sh600000"] },
  entry: { kind: "constant", value: true },
  exit: { stop: { kind: "fixed", fraction: 0.08 }, trailing: 0.1, maxBars: 20 },
  sizing: { kind: "equal", positions: 10 },
};

it("rejects ambiguous or absent real book policy instead of guessing a frozen 20-slot limit, while custom unlinked sizing stays available", () => {
  const user = setup();
  expect(
    planSizingPolicy(strategy, user.event, config, user.repo).source,
  ).toContain("用户配置");
  const definition: StrategyObjectInput = {
    ...strategy,
    id: "l3-missing-policy",
    rank: { kind: "rps-composite", periods: [20] },
    rebalance: { kind: "ranked-weekly", top: 20, weighting: "equal" },
  };
  const f = setup(definition),
    paper = new PaperRepository(f.db);
  const policy = {
    initial: 100000,
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 20 }],
    costs: equityCosts,
  };
  const candidate = {
    ...frozen.candidates[0],
    strategy: definition,
    executionPolicy: policy,
  } as unknown as FrozenCandidate;
  const account: PaperAccount = {
    id: "one-policy",
    market: "cn-equity",
    currency: "CNY",
    sleeve: "swing",
    startedAt: now - 86400000,
    initial: 100000,
    candidates: [candidate],
    mirror: { venue: "off" },
    mirrorRevision: "fixture",
    revision: 0,
    lastBar: null,
    lastRun: null,
    error: null,
    summary: null,
  };
  paper.create(account);
  expect(() => planSizingPolicy(definition, f.event, config, f.repo)).toThrow(
    "真实纸面执行上下文",
  );
  f.db
    .prepare("INSERT INTO paper_state VALUES(?,?)")
    .run(
      account.id,
      JSON.stringify({ request: { ...policy, strategies: [definition] } }),
    );
  expect(() => planSizingPolicy(definition, f.event, config, f.repo)).toThrow(
    "完整组合准入权重",
  );
  paper.create({ ...account, id: "second-policy" });
  expect(() => planSizingPolicy(definition, f.event, config, f.repo)).toThrow(
    "来源不唯一",
  );
});

it("keeps known industry evidence for earlier unfilled plans when checking the next plan", () => {
  const f = setup({
    ...strategy,
    universe: { kind: "symbols", symbols: ["sh600000", "sh600001"] },
  });
  const admission = {
    positions: [],
    industry: () => "银行",
    assertCurrent: () => {},
  };
  createAlertPlan(f.input, config, now, f.repo, admission);
  const second = { ...f.event, symbol: "sh600001" };
  second.key = alertKey(second);
  f.repo.record(
    f.repo.strategies.strategy(strategy.id, strategy.version)!,
    second,
  );
  const plan = createAlertPlan(
    { ...f.input, eventKey: second.key },
    config,
    now,
    f.repo,
    admission,
  );
  expect(plan.exposureAudit?.overridden).toBe(false);
  expect(plan.exposureAudit?.violations).toEqual([]);
  expect(f.repo.plans(true)).toHaveLength(2);
});
function setup(s = strategy) {
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  const repo = new AlertRepository(db);
  repo.strategies.saveStrategy(s);
  repo.saveState("exposure", [
    { market: s.market, sleeve: "__checked__", value: 0, at: now },
  ]);
  const symbol =
    s.universe.kind === "symbols" ? s.universe.symbols[0]! : "sh600000";
  const event: AlertEvent = {
    key: "",
    strategyId: s.id,
    version: s.version,
    market: s.market,
    symbol,
    bar: "2026-11-13",
    type: "entry",
    price: 10,
    sleeve: "swing",
    stop: 9.2,
    target: null,
    observedAt: now,
    mode: "shadow",
    status: "shadow",
    reason: "fixture",
    source: "fixed",
    wouldSend: false,
    outcomes: [],
  };
  event.key = alertKey(event);
  repo.record(s, event);
  return {
    db,
    repo,
    event,
    input: {
      eventKey: event.key,
      stages: [10],
      stop: 9.2,
      target: null,
      expiresAt: "2026-11-17T00:00:00Z",
    },
  };
}
it("uses exactly the backtest and paper quantity including lot rounding and fees", () => {
  const f = setup();
  const plan = createAlertPlan(f.input, config, now, f.repo, {
    positions: [],
    industry: () => "fixture-industry",
    assertCurrent: () => {},
  });
  const quote = {
    evidence: "fixed",
    minimum: 100,
    step: 100,
    limitUp: null,
    limitDown: null,
    tradable: true,
  };
  const b = (date: string) => ({
    date,
    open: 10 / (1 + equityCosts.slippageBps / 10000),
    high: 11,
    low: 9.5,
    close: 10,
    volume: 10000,
    amount: 100000,
  });
  const bars = [b("2026-11-13"), b("2026-11-16")];
  const request = {
    market: "cn-equity" as const,
    initial: 100000,
    start: "2026-11-13",
    end: "2026-11-16",
    calendar: bars.map((x) => x.date),
    instruments: [
      {
        symbol: "sh600000",
        market: "cn-equity" as const,
        bars,
        signalBars: bars,
        execution: quote,
      },
    ],
    strategies: [strategy],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 10 }],
  };
  const result = runPortfolio(request),
    paper = runPaperPortfolio(request);
  expect(result.fills[0]!.quantity).toBe(900);
  expect(plan.quantity).toBe(result.fills[0]!.quantity);
  expect(paper.fills).toEqual(result.fills);
  expect(plan.protection).toMatchObject({ exitSpec: strategy.exit });
  expect(plan.sizingAudit?.estimatedFees).toBe(result.fills[0]!.fee);
});
it("keeps minimum commissions, accumulated risk and missing cash inside one sizing boundary", () => {
  const input = {
    sizing: { kind: "equal" as const, positions: 10 },
    equity: 100000,
    cash: 100000,
    price: 10,
    stop: 9.2,
    riskPerTrade: 0.02,
    quantityRules: { minimum: 100, step: 100, maximum: 1e12 },
    costs: equityCosts,
  };
  expect(sizePortfolioEntry(input).quantity).toBe(900);
  expect(sizePortfolioEntry({ ...input, cash: 100 }).quantity).toBe(0);
  expect(
    sizePortfolioEntry({
      ...input,
      existing: { quantity: 3000, cost: 10, stop: 9.2 },
    }).quantity,
  ).toBe(0);
  expect(portfolioExecutionFee(100, 10, "buy", input.costs)).toBe(5);
});
it("requires an audited confirmation for overrides and cannot override cash or risk", () => {
  const f = setup();
  expect(() =>
    previewAlertPlan({ ...f.input, stop: 9 }, config, now, f.repo),
  ).toThrow("明确确认");
  const input = {
    ...f.input,
    overrideSizing: {
      confirmed: true as const,
      reason: "lower size",
      quantities: [800],
    },
  };
  const plan = createAlertPlan(input, config, now, f.repo, {
    positions: [],
    industry: () => "fixture-industry",
    assertCurrent: () => {},
  });
  expect(plan.quantity).toBe(800);
  expect(plan.sizingAudit).toMatchObject({
    overridden: true,
    reason: "lower size",
    expectedQuantities: [900],
    actualQuantities: [800],
  });
  const g = setup();
  expect(() =>
    previewAlertPlan(
      {
        ...g.input,
        overrideSizing: {
          confirmed: true,
          reason: "too large",
          quantities: [100000],
        },
      },
      config,
      now,
      g.repo,
    ),
  ).toThrow("硬约束");
});
it("refuses missing same-day volatility evidence, then consumes the frozen paper ceiling", () => {
  const candidate = frozen.candidates.find(
    (c) => c.registration.sizing === "volatility",
  ) as unknown as FrozenCandidate;
  const f = setup(candidate.strategy);
  expect(() =>
    previewAlertPlan(
      {
        ...f.input,
        quantityRules: { step: 0.000001, minimum: 0.000001, source: "fixed" },
      },
      config,
      now,
      f.repo,
    ),
  ).toThrow("波动率权重证据");
  const account: PaperAccount = {
    id: "paper-volatility",
    market: "crypto",
    currency: "USDT",
    sleeve: "swing",
    startedAt: now - 86400000,
    initial: 100000,
    candidates: [candidate],
    mirror: { venue: "off" },
    mirrorRevision: "fixed",
    revision: 0,
    lastBar: null,
    lastRun: null,
    error: null,
    summary: null,
  };
  const paper = new PaperRepository(f.db);
  paper.create(account);
  // Only the sizing projection is read; no invented backtest curve is executed.
  f.db.prepare("INSERT INTO paper_state VALUES(?,?)").run(
    account.id,
    JSON.stringify({
      request: {
        sleeves: [
          { id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 2 },
        ],
        positionWeights: [
          {
            strategyId: candidate.strategy.id,
            symbol: f.event.symbol,
            date: f.event.bar,
            availableAt: f.event.bar,
            weight: 0.1,
          },
        ],
      },
    }),
  );
  const plan = previewAlertPlan(
    {
      ...f.input,
      quantityRules: { step: 0.000001, minimum: 0.000001, source: "fixed" },
    },
    config,
    now,
    f.repo,
  );
  expect(plan.sizingAudit.weightCeiling).toBe(0.1);
  expect(plan.stages[0]!.quantity * 10).toBeLessThanOrEqual(100000 * 0.1);
});
it("rebalance plans add only the verified gap to a target and match the actual second-week engine/paper fill", () => {
  const definition: StrategyObjectInput = {
    ...strategy,
    id: "weekly-plan-gap",
    sizing: { kind: "weight", weight: 1 },
    rank: { kind: "rps-composite", periods: [20] },
    rebalance: {
      kind: "ranked-weekly",
      top: 1,
      retentionMultiple: 1.5,
      weighting: "equal",
    },
  };
  const f = setup(definition);
  const calendar = Array.from({ length: 15 }, (_, i) =>
    new Date(Date.UTC(2026, 10, 2 + i)).toISOString().slice(0, 10),
  ).filter((d) => ![0, 6].includes(new Date(d).getUTCDay()));
  const bars = calendar.map((date) => ({
    date,
    open: 10,
    high: 10.1,
    low: 9.9,
    close: 10,
    volume: 10000,
    amount: 100000,
  }));
  const quote = {
    evidence: "fixed fixture",
    minimum: 100,
    step: 100,
    limitUp: null,
    limitDown: null,
    tradable: true,
  };
  const request = {
    market: "cn-equity" as const,
    initial: 100000,
    start: calendar[0]!,
    end: calendar.at(-1)!,
    calendar,
    instruments: [
      {
        symbol: "sh600000",
        market: "cn-equity" as const,
        bars,
        signalBars: bars,
        external: {
          rps: calendar.map((date) => ({
            date,
            periods: [20],
            values: [{ return: 0.1, rank: 1, rps: 100 }],
          })),
        },
        execution: Object.fromEntries(
          calendar.map((date) => [
            date,
            { ...quote, maximum: date <= "2026-11-09" ? 800 : 1e12 },
          ]),
        ),
      },
    ],
    strategies: [definition],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 1 }],
    costs: executionCostsSchema.parse({
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    }),
  };
  const result = runPortfolio(request);
  expect(runPaperPortfolio(request)).toEqual(result);
  expect(result.fills.map((fill) => [fill.date, fill.quantity])).toEqual([
    ["2026-11-09", 800],
    ["2026-11-16", 700],
  ]);
  const candidate = {
    ...frozen.candidates[0],
    strategy: definition,
    registration: { ...frozen.candidates[0]!.registration, sizing: "equal" },
  } as unknown as FrozenCandidate;
  const paper = new PaperRepository(f.db);
  paper.create({
    id: "paper-book-gap",
    market: "cn-equity",
    currency: "CNY",
    sleeve: "swing",
    startedAt: now - 20 * 86400000,
    initial: 100000,
    candidates: [candidate],
    mirror: { venue: "off" },
    mirrorRevision: "fixed",
    revision: 0,
    lastBar: "2026-11-13",
    lastRun: now,
    error: null,
    summary: null,
  });
  f.db
    .prepare("INSERT INTO paper_state VALUES(?,?)")
    .run("paper-book-gap", JSON.stringify({ request, result }));
  const positions: AccountPosition[] = [
    {
      id: "real-held",
      account: "real",
      kind: "real",
      market: "cn-equity",
      currency: "CNY",
      symbol: "sh600000",
      sleeve: "swing",
      industry: "银行",
      quantity: 800,
      cost: 10,
      price: 10,
      value: 8000,
      stop: 9.2,
      at: f.event.bar,
      strategyId: definition.id,
      strategyVersion: definition.version,
      reasons: [],
    },
  ];
  const plan = previewAlertPlan(f.input, config, now, f.repo, positions);
  expect(plan.quantity).toBe(700);
  expect(plan.quantity).toBe(result.fills[1]!.quantity);
  expect(plan.sizingAudit.bookSizing).toEqual({
    date: "2026-11-13",
    targetWeight: 0.15,
    currentWeight: 0.08,
    deltaWeight: 0.06999999999999999,
    actualHeldQuantity: 800,
    actualHeldValue: 8000,
  });
  expect(plan.sizingAudit.estimatedFees).toBe(result.fills[1]!.fee);
  expect(() => previewAlertPlan(f.input, config, now, f.repo)).toThrow(
    "真实同版本持仓快照",
  );
});
it("target sizing rejects nonfinite/out-of-range weights and treats zero as no additional purchase", () => {
  const input = {
    sizing: { kind: "weight" as const, weight: 1 },
    equity: 100000,
    cash: 100000,
    price: 10,
    stop: 9.2,
    riskPerTrade: 0.02,
    costs: equityCosts,
    quantityRules: { minimum: 100, step: 100, maximum: 1e12 },
  };
  for (const targetWeight of [NaN, Infinity, -0.1, 1.1])
    expect(() => sizePortfolioTargetEntry({ ...input, targetWeight })).toThrow(
      "Invalid portfolio target weight",
    );
  expect(sizePortfolioTargetEntry({ ...input, targetWeight: 0 }).quantity).toBe(
    0,
  );
});
