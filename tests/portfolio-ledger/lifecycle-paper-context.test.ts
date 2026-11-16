import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { executionCostsSchema } from "trading-strategy-core/costs";
import {
  strategyObjectSchema,
  type StrategyObjectInput,
} from "trading-strategies";
import type { PortfolioRequest } from "quant-backtest";
import { migrate } from "~/server/db/migrations";
import { PaperRepository } from "~/server/db/paper-repository";
import { advancePaper, type PaperInput } from "~/server/paper/advance";
import { loadPaperInput } from "~/server/paper/inputs";
import { capturePaperDecisions } from "~/server/paper/decisions";
import {
  runPaperPortfolio,
  paperStrategy,
} from "~/server/strategies/drivers/paper";
import { backtestStrategy } from "~/server/strategies/drivers/backtest";
import { scanStrategy } from "~/server/strategies/drivers/scan";
import { watchStrategy } from "~/server/strategies/drivers/watch";
import { evaluateDriverBook } from "~/server/strategies/drivers/book";
import type { PaperAccount, FrozenCandidate } from "~/server/paper/model";
import frozen from "~/server/data/paper-candidates.json";
import { settingsSchema } from "~/lib/domain";
import * as settingsService from "~/server/infra/settings";
import * as barReader from "~/server/market/bar-store/read-bars";
import * as actionReader from "~/server/market/bar-store/corporate-actions";
import * as calendarReader from "~/server/market/data-health";

const connections: Database.Database[] = [];
afterEach(() => {
  connections.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
});
const costs = executionCostsSchema.parse({
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  slippageBps: 0,
});
function accountFor(
  strategy: StrategyObjectInput,
  request: PortfolioRequest,
  startedAt: number,
) {
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  const repo = new PaperRepository(db);
  const policy = {
    initial: request.initial,
    sleeves: request.sleeves,
    costs: request.costs,
  };
  const candidate: FrozenCandidate = {
    ...(frozen.candidates[0] as unknown as FrozenCandidate),
    strategy,
    executionPolicy: policy,
  };
  const account: PaperAccount = {
    id: `paper:${strategy.id}`,
    market: strategy.market,
    currency: strategy.market === "crypto" ? "USDT" : "CNY",
    sleeve: strategy.sleeve,
    startedAt,
    initial: request.initial,
    candidates: [candidate],
    mirror: { venue: "off" },
    mirrorRevision: "fixed",
    revision: 0,
    lastBar: null,
    lastRun: null,
    error: null,
    summary: null,
  };
  repo.create(account);
  return { repo, account };
}
function weekly() {
  const calendar = Array.from({ length: 170 }, (_, i) =>
    new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10),
  ).filter((date) => ![0, 6].includes(new Date(date).getUTCDay()));
  const first = calendar[80]!;
  expect(new Date(first).getUTCDay()).toBe(1);
  const strategy = strategyObjectSchema.parse({
    id: "paper-native-weekly",
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: ["sh600000", "sh600001"] },
    entry: { kind: "constant", value: true },
    exit: {
      stop: { kind: "atr", period: 14, multiple: 2 },
      chandelier: { period: 14, multiple: 3 },
    },
    sizing: { kind: "weight", weight: 1 },
    sleeve: "swing",
    rank: { kind: "rps-composite", periods: [20] },
    overlay: { volatilityTarget: 0.15, symbolWeight: 0.15 },
    rebalance: { kind: "ranked-weekly", top: 1, weighting: "equal" },
  });
  const instruments =
    strategy.universe.kind === "symbols"
      ? strategy.universe.symbols.map((symbol, k) => {
          const signalBars = calendar.map((date, i) => {
            const close = 10 + k + Math.sin(i / 3) * 0.03;
            return {
              date,
              open: close,
              high: close + 0.1,
              low: close - 0.1,
              close,
              volume: 10000,
              amount: close * 10000,
            };
          });
          return {
            symbol,
            market: "cn-equity" as const,
            signalBars,
            bars: signalBars.map((bar) => ({
              ...bar,
              open: bar.open * 2,
              high: bar.high * 2,
              low: bar.low * 2,
              close: bar.close * 2,
            })),
            execution: {
              evidence: "fixed local OHLC fixture",
              tradable: true,
              limitUp: null,
              limitDown: null,
            },
            external: {
              rps: calendar.map((date) => ({
                date,
                periods: [20],
                values: [{ return: 0.1, rank: k + 1, rps: k ? 20 : 95 }],
              })),
            },
          };
        })
      : [];
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: 100000,
    start: first,
    end: calendar[84]!,
    calendar,
    strategies: [strategy],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 1 }],
    costs,
    instruments,
    bookFacts: { [strategy.id]: {} },
    bookSeeds: [
      {
        strategyId: strategy.id,
        date: calendar[79]!,
        availableAt: calendar[79]!,
      },
    ],
  };
  const readyDates = calendar.slice(80, 85);
  const input: PaperInput = {
    request,
    benchmark: instruments[0]!.bars,
    readyDates,
    source: "complete frozen raw/adjusted/native book fixture",
  };
  const state = accountFor(
    strategy,
    request,
    Date.parse(`${first}T00:00:00+08:00`),
  );
  return { ...state, request, input, calendar, strategy, first };
}

function mockNativeSource(f: ReturnType<typeof weekly>) {
  vi.spyOn(settingsService, "settings").mockReturnValue(
    settingsSchema.parse({ tdxRoot: "D:/synthetic-paper/tdx" }),
  );
  vi.spyOn(barReader, "readBars").mockImplementation(async (input) => {
    const source =
      f.request.instruments.find(
        (instrument) => instrument.symbol === input.instrument.symbol,
      ) ?? f.request.instruments[0]!;
    return {
      bars: input.adjustment === "forward" ? source.signalBars : source.bars,
      rawBars: source.bars,
      source: "synthetic completed native source",
      hash: "synthetic-source",
      adjustment: input.adjustment,
      barStore: { formingDates: [] },
    } as unknown as Awaited<ReturnType<typeof barReader.readBars>>;
  });
  vi.spyOn(actionReader, "corporateActions").mockResolvedValue({
    events: new Map(),
    fingerprint: "synthetic-complete-action-source",
  } as unknown as Awaited<ReturnType<typeof actionReader.corporateActions>>);
  vi.spyOn(calendarReader, "localCalendarReference").mockResolvedValue({
    days: f.calendar,
    source: "synthetic exchange calendar",
  } as Awaited<ReturnType<typeof calendarReader.localCalendarReference>>);
}

it("keeps full native warmup and one causal pre-start seed without warmup fills/P&L, then preserves the prefix", () => {
  const f = weekly(),
    cutoff = f.calendar[81]!,
    now = Date.parse(`${cutoff}T17:00:00+08:00`);
  const before = f.request.instruments[0]!.signalBars[0]!;
  const raw = capturePaperDecisions(
    [f.strategy],
    f.request.instruments[0]!,
    [f.first],
    now,
    "raw rule fixture",
  );
  expect(raw[0]).toMatchObject({ entry: true, exit: false });
  expect(raw[0]!.stop).not.toBeNull();
  advancePaper(f.repo, f.account.id, f.input, now);
  const state = f.repo.state(f.account.id)!;
  expect(state.request.start).toBe(f.first);
  expect(state.request.calendar[0]).toBe(f.calendar[0]);
  expect(state.request.instruments[0]!.signalBars[0]).toEqual(before);
  expect(state.request.instruments[0]!.bars[0]!.close).toBe(before.close * 2);
  expect(state.request.instruments[0]!.external!.rps).toHaveLength(82);
  expect(state.result.curve[0]!.date).toBe(f.first);
  expect(state.result.fills[0]).toMatchObject({
    date: f.first,
    signalAt: f.calendar[79],
  });
  expect(state.result.fills.every((fill) => fill.date >= f.first)).toBe(true);
  expect(state.decisions.every((decision) => decision.date >= f.first)).toBe(
    true,
  );
  expect(state.result.dailyDecisionCounts).toHaveLength(2);
  expect(state.result.bookDecisions?.length).toBeGreaterThan(0);
  const direct = backtestStrategy({ ...f.request, end: cutoff });
  expect(state.result.fills).toEqual(direct.fills);
  expect(state.result.curve).toEqual(direct.curve);
  const last = f.calendar[84]!;
  advancePaper(
    f.repo,
    f.account.id,
    f.input,
    Date.parse(`${last}T17:00:00+08:00`),
  );
  expect(
    f.repo
      .state(f.account.id)!
      .result.curve.slice(0, state.result.curve.length),
  ).toEqual(state.result.curve);
  expect(
    f.repo
      .state(f.account.id)!
      .result.fills.slice(0, state.result.fills.length),
  ).toEqual(state.result.fills);
});

it("raw rule capture is independent from the shared four-driver book admission", () => {
  const f = weekly(),
    date = f.calendar[79]!;
  const universe = f.request.instruments.map((instrument) => ({
    symbol: instrument.symbol,
    market: instrument.market,
    bars: instrument.signalBars,
    rawBars: instrument.bars,
    external: instrument.external,
  }));
  const admission = evaluateDriverBook(f.strategy, universe, date, {
    calendar: f.calendar,
    equity: f.request.initial,
    initial: f.request.initial,
    maxPositions: 1,
    holdings: [],
    reentries: {},
    facts: {},
  });
  const names = scanStrategy(f.strategy, universe, date, { admission }).map(
    (row) => row.symbol,
  );
  expect(names).toEqual(["sh600000"]);
  expect(
    watchStrategy(f.strategy, universe[0]!, date, { admission }),
  ).toMatchObject([{ type: "entry" }]);
  expect(
    paperStrategy(f.strategy, universe[0]!, date, { admission }),
  ).toMatchObject([{ side: "BUY" }]);
  expect(
    capturePaperDecisions(
      [f.strategy],
      f.request.instruments[1]!,
      [date],
      Date.parse(`${date}T17:00:00+08:00`),
      "raw second-ranked rule",
    )[0]!.entry,
  ).toBe(true);
  expect(runPaperPortfolio(f.request).fills).toEqual(
    backtestStrategy(f.request).fills,
  );
});

it("rejects changes to frozen adjusted warmup and policy without touching the accounting state", () => {
  const f = weekly(),
    cutoff = f.calendar[81]!;
  advancePaper(
    f.repo,
    f.account.id,
    f.input,
    Date.parse(`${cutoff}T17:00:00+08:00`),
  );
  const before = JSON.stringify(f.repo.state(f.account.id)),
    revision = f.repo.account(f.account.id)!.revision;
  const changed = {
    ...f.request,
    instruments: f.request.instruments.map((i, n) =>
      n
        ? i
        : {
            ...i,
            signalBars: i.signalBars.map((bar, index) =>
              index ? bar : { ...bar, close: bar.close * 1.01 },
            ),
          },
    ),
  };
  expect(() =>
    advancePaper(
      f.repo,
      f.account.id,
      { ...f.input, request: changed },
      Date.parse(`${f.calendar[84]}T17:00:00+08:00`),
    ),
  ).toThrow("已冻结预热");
  expect(() =>
    advancePaper(
      f.repo,
      f.account.id,
      {
        ...f.input,
        request: { ...f.request, costs: { ...costs, commissionBps: 1 } },
      },
      Date.parse(`${f.calendar[84]}T17:00:00+08:00`),
    ),
  ).toThrow("executionPolicy");
  expect(JSON.stringify(f.repo.state(f.account.id))).toBe(before);
  expect(f.repo.account(f.account.id)!.revision).toBe(revision);
});

it("starts a 4h account at the first actual END bar and preserves unknown external rules", () => {
  const bars = Array.from({ length: 40 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 0, 1, (i + 1) * 4)).toISOString();
    return {
      date,
      open: 10,
      high: 10.1,
      low: 9.9,
      close: 10,
      volume: 1000,
      amount: 10000,
    };
  });
  const strategy = strategyObjectSchema.parse({
    id: "paper-native-4h",
    version: 1,
    market: "crypto",
    period: "4h",
    universe: { kind: "symbols", symbols: ["BTCUSDT"] },
    entry: { kind: "external", id: "raw", side: "entry" },
    exit: {
      rule: { kind: "external", id: "raw", side: "exit" },
      stop: { kind: "atr", period: 14, multiple: 2 },
      chandelier: { period: 14, multiple: 3 },
    },
    sizing: { kind: "weight", weight: 1 },
    sleeve: "breakout",
  });
  const first = bars[30]!.date,
    last = bars[33]!.date;
  const request: PortfolioRequest = {
    market: "crypto",
    initial: 100000,
    start: first,
    end: last,
    calendar: bars.map((bar) => bar.date),
    strategies: [strategy],
    sleeves: [
      { id: "breakout", share: 1, riskPerTrade: 0.02, maxPositions: 1 },
    ],
    costs,
    instruments: [
      {
        symbol: "BTCUSDT",
        market: "crypto",
        bars,
        signalBars: bars,
        external: {
          signals: bars.map((bar, i) => ({
            id: "raw",
            date: bar.date,
            availableAt: bar.date,
            entry: i === 30 ? null : true,
            exit: false,
          })),
        },
        execution: {
          evidence: "fixed crypto grid",
          minimum: 0.001,
          step: 0.001,
          tradable: true,
          limitUp: null,
          limitDown: null,
        },
      },
    ],
  };
  const f = accountFor(strategy, request, Date.parse(first) - 3600000);
  advancePaper(
    f.repo,
    f.account.id,
    {
      request,
      benchmark: bars,
      readyDates: bars.slice(30, 34).map((bar) => bar.date),
      source: "full native 4h fixture",
    },
    Date.parse(last) + 60000,
  );
  const state = f.repo.state(f.account.id)!;
  expect(state.request.start).toBe(first);
  expect(state.result.curve.map((point) => point.date)).toEqual(
    bars.slice(30, 34).map((bar) => bar.date),
  );
  expect(state.result.fills[0]!.date).toBe(bars[32]!.date);
  expect(state.result.orders.every((order) => order.signalAt >= first)).toBe(
    true,
  );
  expect(
    state.request.instruments[0]!.external!.signals!.find(
      (point) => point.date === first,
    )!.entry,
  ).toBeNull();
  expect(state.decisions.find((point) => point.date === first)).toMatchObject({
    entry: null,
    exit: false,
  });
});

it("new paper loading refuses a missing frozen execution policy before obtaining market data", async () => {
  const f = weekly();
  await expect(
    loadPaperInput(
      {
        ...f.account,
        candidates: f.account.candidates.map((candidate) => ({
          ...candidate,
          executionPolicy: undefined,
        })),
      },
      Date.parse(`${f.calendar[81]}T17:00:00+08:00`),
    ),
  ).rejects.toThrow("executionPolicy");
});

it("native loader consumes complete supplied book facts and exact policy while retaining raw/adjusted warmup", async () => {
  const f = weekly();
  mockNativeSource(f);
  const now = Date.parse(`${f.calendar[81]}T17:00:00+08:00`);
  const input = await loadPaperInput(f.account, now, {
    bookFacts: f.request.bookFacts,
    bookSeeds: f.request.bookSeeds,
    externalBySymbol: Object.fromEntries(
      f.request.instruments.map((instrument) => [
        instrument.symbol,
        instrument.external!,
      ]),
    ),
  });
  expect(input).not.toBeNull();
  expect(input!.request.start).toBe(f.first);
  expect(input!.request.sleeves).toEqual(f.request.sleeves);
  expect(input!.request.costs).toEqual(costs);
  expect(input!.request.instruments[0]!.signalBars[0]).toEqual(
    f.request.instruments[0]!.signalBars[0],
  );
  expect(input!.request.instruments[0]!.bars[0]).toEqual(
    f.request.instruments[0]!.bars[0],
  );
  expect(input!.request.instruments[0]!.external!.rps).toEqual(
    f.request.instruments[0]!.external!.rps,
  );
  expect(input!.decisions).toBeUndefined();
  advancePaper(f.repo, f.account.id, input!, now);
  expect(f.repo.state(f.account.id)!.result.curve[0]!.date).toBe(f.first);
});

it("native loader reports missing same-pool ranking and classic evidence instead of inventing a source", async () => {
  const f = weekly();
  mockNativeSource(f);
  const now = Date.parse(`${f.calendar[81]}T17:00:00+08:00`);
  await expect(loadPaperInput(f.account, now)).rejects.toThrow(
    "同一冻结证券池",
  );
  const classic = {
    ...f.account,
    candidates: f.account.candidates.map((candidate) => ({
      ...candidate,
      strategy: {
        ...candidate.strategy,
        rank: { kind: "classic" as const, model: "classic-five" as const },
      },
    })),
  };
  await expect(loadPaperInput(classic, now)).rejects.toThrow("classic");
});

it("standalone time-reentry uses native warmup without trading it or immediately reopening after the time exit", () => {
  const dates = Array.from({ length: 9 }, (_, i) =>
    new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
  );
  const bars = dates.map((date) => ({
    date,
    open: 10,
    high: 10.1,
    low: 9.9,
    close: 10,
    volume: 1000,
    amount: 10000,
  }));
  const strategy = strategyObjectSchema.parse({
    id: "paper-time-only",
    version: 1,
    market: "crypto",
    period: "day",
    universe: { kind: "symbols", symbols: ["BTCUSDT"] },
    entry: { kind: "external", id: "raw", side: "entry" },
    exit: {
      maxBars: 1,
      timeReentry: { cooldownBars: 1, requireNewSignal: true },
    },
    sizing: { kind: "weight", weight: 0.1 },
    sleeve: "breakout",
  });
  const request: PortfolioRequest = {
    market: "crypto",
    initial: 100000,
    start: dates[3]!,
    end: dates[8]!,
    calendar: dates,
    strategies: [strategy],
    sleeves: [
      { id: "breakout", share: 1, riskPerTrade: 0.02, maxPositions: 1 },
    ],
    costs,
    instruments: [
      {
        symbol: "BTCUSDT",
        market: "crypto",
        bars,
        signalBars: bars,
        external: {
          signals: dates.map((date, i) => ({
            id: "raw",
            date,
            availableAt: date,
            entry: i !== 6,
            exit: false,
          })),
        },
        execution: {
          evidence: "fixed crypto grid",
          minimum: 0.001,
          step: 0.001,
          tradable: true,
          limitUp: null,
          limitDown: null,
        },
      },
    ],
  };
  const f = accountFor(strategy, request, Date.parse(dates[3]!));
  advancePaper(
    f.repo,
    f.account.id,
    {
      request,
      benchmark: bars,
      readyDates: dates.slice(3),
      source: "complete standalone time-reentry fixture",
    },
    Date.parse(dates[8]!) + 86400000 + 60000,
  );
  const state = f.repo.state(f.account.id)!;
  expect(state.request.start).toBe(dates[3]);
  expect(state.request.calendar[0]).toBe(dates[0]);
  expect(state.result.fills.map((fill) => [fill.side, fill.date])).toEqual([
    ["buy", dates[4]],
    ["sell", dates[5]],
    ["buy", dates[8]],
  ]);
});
