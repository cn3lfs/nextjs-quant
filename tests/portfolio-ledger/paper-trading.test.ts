import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import type { StrategyObjectInput } from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import { defaultExecutionCosts } from "trading-strategy-core/costs";
import frozen from "~/server/data/paper-candidates.json";
import { migrate } from "~/server/db/migrations";
import { PaperRepository } from "~/server/db/paper-repository";
import { advancePaper, type PaperInput } from "~/server/paper/advance";
import { recordPaperAlerts } from "~/server/paper/alerts";
import {
  synchronizePaperMirror,
  type MirrorRunner,
} from "~/server/paper/mirror";
import {
  mirrorSettingsSchema,
  type FrozenCandidate,
  type PaperAccount,
} from "~/server/paper/model";
import { registerPaperCandidates } from "~/server/paper/registration";
import { AlertRepository } from "~/server/db/alert-repository";
import { capturePaperDecisions } from "~/server/paper/decisions";
import { selectShadowCandidates } from "~/server/research/shadow-selection";
import type { ScoreboardRow } from "~/server/research/validation-model";
import { SimulatedSpotAdapter } from "~/server/crypto-trading/adapter";
import type { Config } from "~/server/crypto-trading/model";

const connections: Database.Database[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-20T08:00:00Z");
});
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const bar = (date: string, price = 10): Bar => ({
  date,
  open: price,
  high: price + 0.5,
  low: price - 0.5,
  close: price,
  volume: 1000,
  amount: 10000,
});
const days = [
  "2026-10-09",
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
  "2026-10-15",
];
function fixture(market: "cn-equity" | "crypto" = "cn-equity") {
  const db = new Database(":memory:");
  connections.push(db);
  db.pragma("foreign_keys=ON");
  migrate(db);
  const repo = new PaperRepository(db);
  const dates =
    market === "crypto"
      ? ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]
      : days;
  const strategy: StrategyObjectInput = {
    id: "paper-fixture",
    version: 1,
    market,
    period: "day",
    universe: {
      kind: "symbols",
      symbols: [market === "crypto" ? "BTCUSDT" : "sh600000"],
    },
    entry: { kind: "formula", source: "选股:C=10;" },
    exit: { rule: { kind: "formula", source: "退出:C<10;" } },
    sizing: { kind: "weight", weight: 1, tranches: 1 },
    sleeve: "swing",
  };
  const candidate = {
    ...(frozen.candidates[0] as unknown as FrozenCandidate),
    strategy,
  };
  const account: PaperAccount = {
    id: "paper:fixture",
    market,
    currency: market === "crypto" ? "USDT" : "CNY",
    sleeve: "swing",
    startedAt: Date.parse("2026-10-09T00:00:00Z"),
    initial: 10000,
    candidates: [candidate],
    mirror: { venue: "off" },
    mirrorRevision: "first",
    revision: 0,
    lastBar: null,
    lastRun: null,
    error: null,
    summary: null,
  };
  repo.create(account);
  const bars = dates.map((d, i) => bar(d, i >= 2 ? 9 : 10));
  const request: PortfolioRequest = {
    market,
    initial: 10000,
    start: dates[0]!,
    end: dates.at(-1)!,
    calendar: dates,
    instruments: [
      {
        symbol:
          strategy.universe.kind === "symbols"
            ? strategy.universe.symbols[0]!
            : "",
        market,
        bars,
        signalBars: bars,
        execution: {
          evidence: "fixed QA market rule evidence",
          minimum: market === "crypto" ? 0.001 : 100,
          step: market === "crypto" ? 0.001 : 100,
          limitDown: null,
          limitUp: null,
          tradable: true,
        },
      },
    ],
    strategies: [strategy],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 1, maxPositions: 1 }],
    costs: {
      ...defaultExecutionCosts,
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  };
  const input: PaperInput = {
    request,
    benchmark: dates.map((d) => bar(d)),
    readyDates: dates,
    source: "fixed QA fixture, never live evidence",
  };
  return { repo, account, request, input, dates };
}
it.each(["cn-equity", "crypto"] as const)(
  "%s paper and runPortfolio have identical fills, orders, daily equity and positions",
  (market) => {
    const { repo, account, request, input } = fixture(market);
    advancePaper(repo, account.id, input, Date.now());
    const paper = repo.state(account.id)!.result;
    const historical = runPortfolio(request);
    expect(paper.fills).toEqual(historical.fills);
    expect(paper.fills.map((f) => [f.side, f.price, f.quantity])).toEqual([
      ["buy", 10, 1000],
      ["sell", 9, 1000],
    ]);
    expect(paper.orders).toEqual(historical.orders);
    expect(paper.equity).toEqual(historical.equity);
    expect(paper.positions).toEqual(historical.positions);
    expect(repo.page(account.id, "fill").total).toBe(2);
    expect(repo.account(account.id)!.summary).toMatchObject({
      return: 9000 / 10000 - 1,
      drawdown: 1 - 9000 / 10000,
      trades: 1,
      winRate: 0,
    });
  },
);
it("restart after three days equals continuous operation, no duplicate trades or historical notification burst", () => {
  const a = fixture("crypto"),
    b = fixture("crypto");
  const first = {
    ...a.input,
    request: { ...a.request, calendar: a.dates.slice(0, 1) },
  };
  vi.setSystemTime("2026-10-10T00:01:00Z");
  advancePaper(a.repo, a.account.id, first, Date.now());
  advancePaper(
    b.repo,
    b.account.id,
    { ...b.input, request: { ...b.request, calendar: b.dates.slice(0, 1) } },
    Date.now(),
  );
  for (let i = 2; i <= 5; i++) {
    vi.setSystemTime(Date.parse(b.dates[i - 1]!) + 86400000 + 60000);
    advancePaper(
      b.repo,
      b.account.id,
      { ...b.input, request: { ...b.request, calendar: b.dates.slice(0, i) } },
      Date.now(),
    );
  }
  advancePaper(a.repo, a.account.id, a.input, Date.now());
  const restarted = new PaperRepository(a.repo.db);
  expect(restarted.state(a.account.id)!.result).toEqual(
    b.repo.state(b.account.id)!.result,
  );
  expect(advancePaper(restarted, a.account.id, a.input, Date.now())).toEqual({
    advanced: 0,
    fills: 0,
  });
  expect(restarted.page(a.account.id, "fill").total).toBe(2);
  const catchUp = restarted.page(a.account.id, "advance").items[0]!.value;
  expect(catchUp).toMatchObject({
    from: "2026-10-10",
    to: "2026-10-13",
    bars: 4,
    catchUp: true,
    notifications: 0,
  });
  const deliver = vi.fn();
  recordPaperAlerts(restarted, a.account.id, Date.now(), deliver);
  expect(deliver).toHaveBeenCalledTimes(0);
});
it("A-share bonus and dividend preserve T+1; limit-down prevents a sale until a tradable bar", () => {
  const f = fixture();
  f.request.strategies[0]!.exit = { stop: { kind: "fixed", fraction: 0.1 } };
  f.account.candidates[0]!.strategy = f.request.strategies[0]!;
  f.repo.save(f.account, 0);
  const instrument = f.request.instruments[0]!;
  const raw = f.dates.map((d, i) => bar(d, i < 2 ? 10 : 4));
  raw[1] = { ...raw[1]!, low: 8 };
  instrument.bars = raw;
  instrument.signalBars = f.dates.map((d) => bar(d));
  instrument.actions = [
    {
      date: f.dates[2]!,
      availableAt: f.dates[2]!,
      dividend: 0.1,
      bonus: 1,
      sharesSellableAt: f.dates[2]!,
      evidence: "QA ex-date availability scenario",
    },
  ];
  instrument.execution = Object.fromEntries(
    f.dates.map((d, i) => [
      d,
      {
        evidence: "QA explicit limits",
        minimum: 100,
        step: 100,
        limitUp: null,
        limitDown: i === 2 ? 4 : null,
        tradable: true,
      },
    ]),
  );
  advancePaper(f.repo, f.account.id, f.input, Date.now());
  const result = f.repo.state(f.account.id)!.result;
  expect(result.fills).toEqual(runPortfolio(f.request).fills);
  expect(result.corporateActions[0]).toMatchObject({
    before: 1000,
    quantity: 2000,
    cash: 100,
  });
  expect(result.rejections.map((r) => r.reason).join(" ")).toContain("T+1");
  expect(result.rejections.map((r) => r.reason).join(" ")).toContain("跌停");
  expect(result.fills[1]).toMatchObject({
    date: f.dates[3],
    side: "sell",
    quantity: 2000,
    price: 4,
  });
});
it("advances past completed bars without receipts but keeps current dates and pre-registration history gated", () => {
  const f = fixture();
  vi.setSystemTime("2026-10-12T06:00:00Z");
  expect(
    advancePaper(
      f.repo,
      f.account.id,
      { ...f.input, readyDates: [] },
      Date.now(),
    ).advanced,
  ).toBe(1);
  advancePaper(
    f.repo,
    f.account.id,
    { ...f.input, readyDates: [f.dates[0]!, f.dates[2]!, f.dates[3]!] },
    Date.now(),
  );
  expect(f.repo.account(f.account.id)!.lastBar).toBe(f.dates[0]);
  expect(f.repo.state(f.account.id)!.result.fills).toEqual([]);
  const g = fixture("crypto");
  const changed = {
    ...g.account,
    startedAt: Date.parse("2026-10-12T12:00:00Z"),
  };
  g.repo.save(changed, 0);
  vi.setSystemTime("2026-10-14T01:00:00Z");
  advancePaper(g.repo, g.account.id, g.input, Date.now());
  expect(g.repo.state(g.account.id)!.request.calendar).toEqual([
    "2026-10-12",
    "2026-10-13",
  ]);
  expect(g.repo.account(g.account.id)!.summary!.days).toBe(2);
});
it("first-observed decisions survive revised historical quotes; a forged immutable fill cannot overwrite facts", () => {
  const f = fixture();
  advancePaper(f.repo, f.account.id, f.input, Date.now());
  const prior = f.repo.page(f.account.id, "fill");
  expect(() =>
    f.repo.fact(
      f.account.id,
      "fill",
      { id: "0", date: f.dates[1]!, value: { quantity: 999 } },
      true,
    ),
  ).toThrow("历史事实冲突");
  expect(f.repo.page(f.account.id, "fill")).toEqual(prior);
});
it("streamed decision capture keeps indicator warmup and exactly matches nonzero fees/slippage and ATR protection", () => {
  const f = fixture("crypto");
  f.request.strategies[0]!.exit = {
    stop: { kind: "atr", period: 2, multiple: 2 },
    trailing: 0.1,
    takeProfit: 0.2,
  };
  f.account.candidates[0]!.strategy = f.request.strategies[0]!;
  f.repo.save(f.account, 0);
  f.request.costs = {
    ...defaultExecutionCosts,
    commissionBps: 10,
    minimumCommission: 0,
    sellTaxBps: 5,
    slippageBps: 3,
  };
  const instrument = f.request.instruments[0]!;
  const history = [bar("2026-10-07"), bar("2026-10-08"), ...instrument.bars];
  instrument.bars = history;
  instrument.signalBars = history;
  const captured = capturePaperDecisions(
    f.request.strategies,
    instrument,
    f.dates,
    Date.now(),
    "QA fixed warmup",
  );
  const streamed = {
    ...instrument,
    bars: history.filter((b) => f.dates.includes(b.date)),
    signalBars: history.filter((b) => f.dates.includes(b.date)),
    external: {},
  };
  advancePaper(
    f.repo,
    f.account.id,
    {
      ...f.input,
      request: { ...f.request, instruments: [streamed] },
      decisions: captured,
    },
    Date.now(),
  );
  expect(f.repo.state(f.account.id)!.result.fills).toEqual(
    runPortfolio(f.request).fills,
  );
  expect(f.repo.state(f.account.id)!.result.fills[0]!.fee).toBeGreaterThan(0);
  expect(f.repo.state(f.account.id)!.decisions[0]!.stop).toBe(8);
});
it("revised past input cannot replace a captured raw bar or an earlier fill", () => {
  const f = fixture("crypto");
  advancePaper(
    f.repo,
    f.account.id,
    { ...f.input, request: { ...f.request, calendar: f.dates.slice(0, 2) } },
    Date.now(),
  );
  const previous = f.repo.state(f.account.id)!.result.fills;
  const changed = f.request.instruments[0]!;
  changed.bars = changed.bars.map((b, i) => (i === 1 ? bar(b.date, 100) : b));
  advancePaper(f.repo, f.account.id, f.input, Date.now());
  expect(
    f.repo.state(f.account.id)!.result.fills.slice(0, previous.length),
  ).toEqual(previous);
  expect(
    f.repo.state(f.account.id)!.request.instruments[0]!.bars[1]!.open,
  ).toBe(10);
});
it("a missing crypto weekend candle refuses to jump the gap", () => {
  const f = fixture("crypto");
  expect(() =>
    advancePaper(
      f.repo,
      f.account.id,
      {
        ...f.input,
        request: { ...f.request, calendar: f.dates.filter((_, i) => i !== 1) },
      },
      Date.now(),
    ),
  ).toThrow("存在缺口");
  expect(f.repo.state(f.account.id)).toBeNull();
});
it("missing frozen distributions stay insufficient after60 days instead of rerunning historical gates", () => {
  const f = fixture("crypto");
  const dates = Array.from({ length: 70 }, (_, i) =>
    new Date(Date.parse(f.dates[0]!) + i * 86400000).toISOString().slice(0, 10),
  );
  const bars = dates.map((d, i) => bar(d, i < 2 ? 10 : 9));
  f.request.calendar = dates;
  f.request.end = dates.at(-1)!;
  f.request.instruments = [
    { ...f.request.instruments[0]!, bars, signalBars: bars },
  ];
  vi.setSystemTime(Date.parse(dates.at(-1)!) + 86400000 + 60000);
  advancePaper(
    f.repo,
    f.account.id,
    { ...f.input, request: f.request, benchmark: dates.map((d) => bar(d)) },
    Date.now(),
  );
  expect(f.repo.account(f.account.id)!.summary).toMatchObject({
    days: 70,
    assessment: {
      recommendation: "证据不足；继续模拟观察",
      method: "forward-conformance-1",
      verdict: "insufficient",
      eligible: false,
    },
  });
  expect(f.repo.account(f.account.id)!.summary!.assessment!.reasons).toContain(
    "missing-frozen-forward-distribution",
  );
});
it("frozen ranking selects the five audited candidates; registration is idempotent, starts now, and defaults mirror off", () => {
  const f = fixture();
  const selected = selectShadowCandidates(frozen.ranking as ScoreboardRow[])
    .map((r) => r.id)
    .sort();
  expect(selected).toEqual(frozen.candidates.map((c) => c.strategy.id).sort());
  expect(selected).toHaveLength(5);
  const first = registerPaperCandidates(f.repo, Date.now());
  expect(first.created).toBe(5);
  expect(registerPaperCandidates(f.repo, Date.now() + 86400000).created).toBe(
    0,
  );
  for (const id of f.repo.ids().filter((id) => id !== f.account.id))
    expect(f.repo.account(id)).toMatchObject({
      startedAt: Date.now(),
      mirror: { venue: "off" },
      lastBar: null,
    });
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  const repo = new PaperRepository(db);
  expect(
    registerPaperCandidates(repo, Date.now(), { grouping: "sleeve" }).created,
  ).toBe(3);
});
it.each([
  ["2026-10-12T17:05:00+08:00", "shadow"],
  ["2026-10-13T08:30:00+08:00", "shadow"],
  ["2026-10-13T09:00:00+08:00", "missed"],
])("paper fills use the next-session close window at %s", (time, status) => {
  const f = fixture();
  advancePaper(
    f.repo,
    f.account.id,
    {
      ...f.input,
      request: { ...f.request, calendar: f.dates.slice(0, 1) },
    },
    Date.parse("2026-10-09T17:05:00+08:00"),
  );
  vi.setSystemTime(time);
  advancePaper(
    f.repo,
    f.account.id,
    {
      ...f.input,
      request: { ...f.request, calendar: f.dates.slice(0, 2) },
    },
    Date.now(),
  );
  const alerts = new AlertRepository(f.repo.db);
  alerts.records.calendar(f.dates, "fixture calendar", Date.now());
  const deliver = vi.fn();
  recordPaperAlerts(f.repo, f.account.id, Date.now(), deliver);
  expect(
    alerts.history({ page: 0, size: 20, symbol: "", strategyId: "" }).items[0],
  ).toMatchObject({
    type: "paper-fill",
    status,
    wouldSend: status === "shadow",
  });
  expect(deliver).not.toHaveBeenCalled();
});
it("shadow paper-fill events have zero delivery and distinct identities from strategy-entry events", () => {
  const f = fixture("crypto");
  vi.setSystemTime("2026-10-11T00:01:00Z");
  advancePaper(
    f.repo,
    f.account.id,
    { ...f.input, request: { ...f.request, calendar: f.dates.slice(0, 1) } },
    Date.parse("2026-10-10T00:01:00Z"),
  );
  advancePaper(
    f.repo,
    f.account.id,
    { ...f.input, request: { ...f.request, calendar: f.dates.slice(0, 2) } },
    Date.now(),
  );
  const deliver = vi.fn();
  recordPaperAlerts(f.repo, f.account.id, Date.now(), deliver);
  recordPaperAlerts(f.repo, f.account.id, Date.now(), deliver);
  expect(deliver).toHaveBeenCalledTimes(0);
  expect(
    new AlertRepository(f.repo.db).history({
      page: 0,
      size: 20,
      symbol: "",
      strategyId: "",
    }).total,
  ).toBe(1);
});
it("new promoted versions get a new prospective account and registration never downgrades a promotion", () => {
  const f = fixture();
  registerPaperCandidates(f.repo, Date.now());
  const alerts = new AlertRepository(f.repo.db);
  const original = frozen.candidates[0]!.strategy;
  alerts.records.save(
    "strategy-qualification",
    `strategy-qualification-${original.id}`,
    { status: "live-candidate", reasons: [] },
  );
  const newer = {
    ...f.account.candidates[0]!.strategy,
    id: "new-promoted",
    version: 2,
  };
  alerts.strategies.saveStrategy(newer);
  alerts.records.save(
    "strategy-qualification",
    `strategy-qualification-${newer.id}`,
    { status: "live-candidate", reasons: [] },
  );
  expect(registerPaperCandidates(f.repo, Date.now() + 1000).created).toBe(1);
  expect(alerts.records.read(`strategy-qualification-${original.id}`)).toEqual({
    status: "live-candidate",
    reasons: [],
  });
  expect(f.repo.account("paper:new-promoted:v2")).toMatchObject({
    startedAt: Date.now() + 1000,
    lastBar: null,
  });
  expect(registerPaperCandidates(f.repo, Date.now() + 2000).created).toBe(0);
});
it("mirrors default off; enablement uses one attempt and reconciles unknowns without resubmission", async () => {
  const f = fixture("crypto");
  vi.setSystemTime("2026-10-11T00:01:00Z");
  advancePaper(
    f.repo,
    f.account.id,
    { ...f.input, request: { ...f.request, calendar: f.dates.slice(0, 1) } },
    Date.parse("2026-10-10T00:01:00Z"),
  );
  advancePaper(
    f.repo,
    f.account.id,
    { ...f.input, request: { ...f.request, calendar: f.dates.slice(0, 2) } },
    Date.now(),
  );
  const place = vi.fn().mockRejectedValue(new Error("unknown"));
  const reconcile = vi.fn().mockResolvedValue(null);
  const runner: MirrorRunner = async (_account, work) =>
    work({
      revision: "QA",
      snapshot: async () => ({ balances: [], openOrders: [] }),
      prepare: async (o) => o,
      place,
      reconcile,
    });
  await synchronizePaperMirror(f.repo, f.account.id, Date.now(), runner);
  expect(place).toHaveBeenCalledTimes(0);
  const account = f.repo.account(f.account.id)!;
  f.repo.save(
    {
      ...account,
      mirror: { venue: "binance", network: "demo" },
      mirrorSince: Date.parse("2026-10-09"),
    },
    account.revision,
  );
  await synchronizePaperMirror(f.repo, f.account.id, Date.now(), runner);
  await synchronizePaperMirror(f.repo, f.account.id, Date.now(), runner);
  expect(place).toHaveBeenCalledTimes(1);
  expect(reconcile).toHaveBeenCalledTimes(1);
  const sent = place.mock.calls[0]![0];
  reconcile.mockResolvedValue({
    ...sent,
    state: "FILLED",
    executedQuantity: "1000",
    fills: [
      {
        id: "QA1",
        quantity: "1000",
        price: "10.1",
        fee: "1",
        feeAsset: "USDT",
      },
    ],
  });
  await synchronizePaperMirror(f.repo, f.account.id, Date.now(), runner);
  expect(f.repo.page(f.account.id, "mirror").items[0]!.value).toMatchObject({
    phase: "settled",
    difference: {
      quantity: 0,
      price: expect.closeTo(0.1, 8),
      fees: { USDT: "1" },
    },
  });
  expect(f.repo.state(f.account.id)!.result.fills[0]!.price).toBe(10);
  expect(() =>
    mirrorSettingsSchema.parse({ venue: "binance", network: "mainnet" }),
  ).toThrow();
  expect(() =>
    mirrorSettingsSchema.parse({
      venue: "binance",
      network: "demo",
      baseUrl: "https://api.binance.com",
    }),
  ).toThrow();
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  expect(
    () =>
      new SimulatedSpotAdapter(
        { venue: "binance", network: "mainnet" } as unknown as Config,
        { apiKey: "QA", apiSecret: "QA" },
      ),
  ).toThrow();
  expect(network).toHaveBeenCalledTimes(0);
});

it("historical accounting does not jump across a missing benchmark bar", () => {
  const f = fixture();
  const input = {
    ...f.input,
    readyDates: [],
    benchmark: f.input.benchmark.filter((b) => b.date !== f.dates[1]),
  };
  const result = advancePaper(f.repo, f.account.id, input, Date.now());
  expect(result.advanced).toBe(1);
  expect(f.repo.account(f.account.id)!.lastBar).toBe(f.dates[0]);
});
