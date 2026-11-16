import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  prepareStrategy,
  prepareStrategyRulePoints,
  strategyObjectSchema,
  type StrategyObjectInput,
} from "trading-strategies";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { executionCostsSchema } from "trading-strategy-core/costs";
import { settingsSchema, type Bar } from "~/lib/domain";
import { migrate } from "~/server/db/migrations";
import { AlertRepository } from "~/server/db/alert-repository";
import { PaperRepository } from "~/server/db/paper-repository";
import { evaluateAlertInputs } from "~/server/alerts/inputs";
import * as settingsService from "~/server/infra/settings";
import * as accountService from "~/server/portfolio/account-workspace-service";
import { HoldingProtectionRepository } from "~/server/db/holding-protection-repository";
import {
  holdingTradeFingerprint,
  protectionPositionKey,
  type HoldingProtectionBinding,
  type HoldingProtectionProjection,
} from "~/lib/portfolio/holding-protection";
import type {
  AccountTrade,
  AccountPosition,
} from "~/lib/portfolio/account-workspace";
import type { FrozenCandidate, PaperAccount } from "~/server/paper/model";
import frozen from "~/server/data/paper-candidates.json";
import valid from "../fixtures/breakout-valid.json";
const live = vi.hoisted(() => ({ bars: [] as Bar[], mismatch: false }));
vi.mock("~/server/market/bar-store/read-bars", () => ({
  readBars: vi.fn(async () => ({
    bars: live.bars.map((bar, i) =>
      live.mismatch && i === live.bars.length - 1
        ? { ...bar, close: bar.close + 0.01 }
        : bar,
    ),
    source: "latest-forward-fixture",
    adjustment: "forward",
    hash: "fixture",
    barStore: { formingDates: [] },
  })),
}));
vi.mock("~/server/portfolio/trade-ledger-service", () => ({
  tradePositionState: async () => ({ positions: [] }),
}));
vi.mock("~/server/infra/runtime-errors", () => ({
  recordRuntimeError: vi.fn(),
}));
vi.mock("~/server/market/security-trading-status", () => ({
  verifySecurityTradingStatus: async (symbol: string) => ({
    version: "security-trading-status-1",
    symbol,
    status: "trading",
    asOf: "2025-03-07",
    fetchedAt: Date.parse("2025-03-07T07:06:00Z"),
    source: "fixture",
    reason: "fixture",
    evidence: { row: {}, columns: [] },
    evidenceHash: "fixed",
  }),
}));
vi.mock("~/server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/server/db")>()),
  get: () => undefined,
  readRecordSnapshot: (_kind: string, read: (rows: unknown[]) => unknown) =>
    read([]),
}));
const connections: Database.Database[] = [];
afterEach(() => {
  connections.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
});
function fixture(withExit = false) {
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  const repo = new AlertRepository(db),
    paper = new PaperRepository(db);
  // A synthetic close on the real fixture's OHLC axis exposes the scale-
  // dependent round rung: latest qfq 27.66 fails, fixed basis round55 passes.
  live.bars = valid.bars.map((bar, i) => ({
    ...bar,
    ...(i === valid.bars.length - 1 ? { close: 27.6 } : {}),
  }));
  live.mismatch = false;
  const bars = live.bars,
    signal = bars.map((bar) => ({
      ...bar,
      open: bar.open * 2,
      high: bar.high * 2,
      low: bar.low * 2,
      close: bar.close * 2,
    })),
    date = bars.at(-1)!.date;
  const strategy: StrategyObjectInput = {
    id: "frozen-watch-db",
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: ["sh600000", "sh600001"] },
    entry: { kind: "double-breakout", side: "entry" },
    exit: {
      stop: { kind: "atr", period: 14, multiple: 3 },
      ...(withExit
        ? {
            rule: { kind: "double-breakout" as const, side: "entry" as const },
            chandelier: { period: 14, multiple: 3 },
          }
        : {}),
    },
    sizing: { kind: "weight", weight: 0.1 },
    sleeve: "swing",
    overlay: { symbolWeight: 0.15 },
  };
  const group = prepareStrategyRulePoints(strategy, signal, {}, [date], {
    definitionHash: "a".repeat(64),
    buildHash: "b".repeat(64),
    sourceHashes: { original: "c".repeat(64) },
  });
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: 100000,
    start: date,
    end: date,
    calendar: bars.map((bar) => bar.date),
    strategies: [strategy],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 2 }],
    costs: executionCostsSchema.parse({}),
    instruments: ["sh600000", "sh600001"].map((symbol) => ({
      symbol,
      market: "cn-equity",
      bars,
      signalBars: signal,
      external: { preparedRules: [group] },
      execution: {
        evidence: "fixed grid",
        tradable: true,
        limitUp: null,
        limitDown: null,
      },
    })),
  };
  const result = runPortfolio(request);
  repo.strategies.saveStrategy(strategy);
  repo.saveState(`strategy:${strategy.id}:1`, { live: true });
  const policy = {
    initial: request.initial,
    sleeves: request.sleeves,
    costs: request.costs,
  };
  const account: PaperAccount = {
    id: "paper-frozen-watch",
    market: "cn-equity",
    currency: "CNY",
    sleeve: "swing",
    initial: request.initial,
    startedAt: Date.parse(`${date}T00:00:00+08:00`),
    candidates: [
      {
        ...(frozen.candidates[0] as unknown as FrozenCandidate),
        strategy,
        executionPolicy: policy,
      },
    ],
    revision: 0,
    lastBar: date,
    lastRun: null,
    error: null,
    summary: null,
    mirror: { venue: "off" },
    mirrorRevision: "fixed",
  };
  paper.create(account);
  paper.saveState(account.id, {
    request,
    result,
    benchmark: bars,
    decisions: [],
  });
  vi.spyOn(settingsService, "settings").mockReturnValue(
    settingsSchema.parse({ tdxRoot: "D:/synthetic-watch", calendar: [date] }),
  );
  return {
    repo,
    paper,
    account,
    strategy,
    signal,
    bars,
    date,
    now: Date.parse(`${date}T15:06:00+08:00`),
  };
}
it("natural watch/why use same-bar genuine fixed-basis evidence and parse a shared checkpoint once", async () => {
  const f = fixture();
  expect(
    prepareStrategy(f.strategy, f.bars).evaluate(f.bars.length - 1).entry,
  ).toBe(false);
  expect(
    prepareStrategy(f.strategy, f.signal).evaluate(f.signal.length - 1).entry,
  ).toBe(true);
  const read = vi.spyOn(PaperRepository.prototype, "state");
  const result = await evaluateAlertInputs("close", f.now, f.repo, f.date);
  expect(read).toHaveBeenCalledTimes(1);
  expect(result.proposals.map((p) => p.event.symbol)).toEqual([
    "sh600000",
    "sh600001",
  ]);
  const expectedStop =
    prepareStrategy(f.strategy, f.signal).evaluate(f.signal.length - 1)
      .stopLevel! / 2;
  for (const proposal of result.proposals) {
    expect(proposal.event.reason).toContain("关键位 55");
    expect(proposal.event.reason).not.toContain("关键位 27.66");
    expect(proposal.event.source).toContain("Frozen paper");
    expect(proposal.event.price).toBe(27.6);
    expect(proposal.event.stop).toBe(expectedStop);
  }
});
it.each(["missing", "stale", "raw-mismatch"])(
  "reports an explicit gap for %s paper evidence",
  async (mode) => {
    const f = fixture(),
      state = f.paper.state(f.account.id)!;
    if (mode === "missing")
      state.request = {
        ...state.request,
        instruments: state.request.instruments.map((instrument) => ({
          ...instrument,
          external: {},
        })),
      };
    if (mode === "stale")
      state.request = { ...state.request, end: f.bars.at(-2)!.date };
    if (mode === "raw-mismatch") live.mismatch = true;
    f.paper.saveState(f.account.id, state);
    const result = await evaluateAlertInputs("close", f.now, f.repo, f.date);
    expect(result.proposals).toEqual([]);
    expect(
      result.states.filter(
        (row) =>
          row.id.startsWith("data-gap:") &&
          !(row.value as { resolved?: boolean }).resolved,
      ),
    ).toHaveLength(2);
  },
);

function holdingFixture() {
  const f = fixture(true),
    entryDate = f.bars.at(-2)!.date;
  const trade: AccountTrade = {
    id: "held-buy",
    account: "manual-fixture",
    kind: "real",
    market: "cn-equity",
    symbol: "sh600000",
    side: "buy",
    date: entryDate,
    time: Date.parse(`${entryDate}T09:30:00+08:00`),
    timePrecision: "instant",
    price: f.bars.at(-2)!.close,
    quantity: 100,
    strategyId: f.strategy.id,
    strategyVersion: 1,
    sleeve: "swing",
    planId: "held-plan",
    alertKey: null,
  };
  const binding: HoldingProtectionBinding = {
    id: protectionPositionKey(
      trade.kind,
      trade.account,
      trade.market,
      trade.symbol,
    ),
    kind: trade.kind,
    account: trade.account,
    market: trade.market,
    symbol: trade.symbol,
    strategyId: f.strategy.id,
    version: 1,
    planId: "held-plan",
    sleeve: "swing",
    trades: [{ id: trade.id, fingerprint: holdingTradeFingerprint(trade) }],
    entryDate,
    entryTime: trade.time,
    entryPrice: trade.price,
    boundAt: trade.time,
    protection: {
      version: "plan-protection-1",
      exitSpec: strategyObjectSchema.parse(f.strategy).exit,
      initialStop: 10,
      target: null,
      entryReference: trade.price,
      asOf: entryDate,
      initialStopEvidence: {
        bar: entryDate,
        source: "synthetic raw ATR evidence",
        level: 10,
      },
    },
    status: "active",
    reason: null,
  };
  const position: AccountPosition = {
    id: binding.id,
    account: trade.account,
    kind: trade.kind,
    market: trade.market,
    currency: "CNY",
    symbol: trade.symbol,
    sleeve: "swing",
    industry: "",
    quantity: 100,
    cost: trade.price,
    price: 27.6,
    value: 2760,
    stop: 10,
    at: f.date,
    strategyId: f.strategy.id,
    strategyVersion: 1,
    reasons: [],
  };
  const book = {
    positions: [position],
    trades: [trade],
    calendar: [entryDate, f.date, "2025-03-10"],
    context: { evidence: () => ({ events: [] as { date: string }[] }) },
  };
  vi.spyOn(accountService, "loadAccountBook").mockResolvedValue(
    book as unknown as Awaited<
      ReturnType<typeof accountService.loadAccountBook>
    >,
  );
  const protections = new HoldingProtectionRepository(f.repo.db);
  f.repo.savePlan(
    {
      id: binding.planId,
      strategyId: f.strategy.id,
      strategyVersion: 1,
      symbol: binding.symbol,
      sleeve: "swing",
      triggerKey: "synthetic-link",
      entry: trade.price,
      tranches: 1,
      quantity: 100,
      stop: 10,
      target: null,
      expiresAt: null,
      status: "open",
      protection: binding.protection,
    },
    f.now,
  );
  protections.save(binding);
  return { ...f, binding, protections, book };
}
it("linked real holdings reuse the genuine fixed-basis exit and chandelier without recompiling a replacement entry", async () => {
  const f = holdingFixture();
  const old = prepareStrategy(f.strategy, f.bars).evaluate(f.bars.length - 1),
    genuine = prepareStrategy(f.strategy, f.signal).evaluate(
      f.signal.length - 1,
    );
  expect(old.exit).toBe(false);
  expect(genuine.exit).toBe(true);
  const read = vi.spyOn(PaperRepository.prototype, "state");
  const result = await evaluateAlertInputs("close", f.now, f.repo, f.date);
  expect(read).toHaveBeenCalledTimes(1);
  const projection = result.states.find(
    (row) => row.id === `holding-protection:${f.binding.id}`,
  )!.value as HoldingProtectionProjection;
  expect(projection.task.status).toBe("rule-exit");
  expect(projection.task.newStop).toBe(genuine.chandelierStop! / 2);
});
it.each(["missing", "manual-exit", "duplicate", "action", "unit"])(
  "keeps the prior real protection and requires review for %s",
  async (mode) => {
    const f = holdingFixture();
    if (mode === "missing") {
      const state = f.paper.state(f.account.id)!;
      state.request = {
        ...state.request,
        instruments: state.request.instruments.map((instrument) => ({
          ...instrument,
          external: {},
        })),
      };
      f.paper.saveState(f.account.id, state);
    }
    if (
      mode === "manual-exit" &&
      f.binding.protection.version === "plan-protection-1"
    )
      f.protections.save({
        ...f.binding,
        protection: { ...f.binding.protection, exitSpec: {} },
      });
    if (mode === "duplicate") {
      f.paper.create({ ...f.account, id: "second-same-version" });
      f.paper.saveState("second-same-version", f.paper.state(f.account.id)!);
    }
    if (mode === "action")
      f.book.context.evidence = () => ({ events: [{ date: f.date }] });
    if (mode === "unit") f.book.positions[0]!.reasons = ["单位须人工核验"];
    const result = await evaluateAlertInputs("close", f.now, f.repo, f.date);
    const projection = result.states.find(
      (row) => row.id === `holding-protection:${f.binding.id}`,
    )!.value as HoldingProtectionProjection;
    expect(projection.task.status).toBe("needs-review");
    expect(projection.backupStop).toBe(10);
    if (mode === "duplicate")
      expect(projection.task.reason).toContain("不唯一");
    if (mode === "manual-exit")
      expect(projection.task.reason).toContain("人工退出规则");
    if (mode === "action") expect(projection.task.reason).toContain("公司行动");
    if (mode === "unit")
      expect(projection.task.reason).toContain("单位未获认证");
  },
);
