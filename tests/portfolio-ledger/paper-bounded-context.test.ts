import Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
  prepareStrategyRulePoints,
  type StrategyObjectInput,
} from "trading-strategies";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { executionCostsSchema } from "trading-strategy-core/costs";
import { advancePaper, boundedPaperRequest } from "~/server/paper/advance";
import { migrate } from "~/server/db/migrations";
import { PaperRepository } from "~/server/db/paper-repository";
import type { FrozenCandidate, PaperAccount } from "~/server/paper/model";
import frozen from "~/server/data/paper-candidates.json";
const hash = "a".repeat(64);
const costs = executionCostsSchema.parse({
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  slippageBps: 0,
});
function request(): PortfolioRequest {
  const calendar = Array.from({ length: 190 }, (_, i) =>
    new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10),
  ).filter((date) => ![0, 6].includes(new Date(date).getUTCDay()));
  const strategy: StrategyObjectInput = {
    id: "bounded-native",
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: ["sh600000"] },
    entry: { kind: "constant", value: true },
    exit: {
      stop: { kind: "atr", period: 14, multiple: 2 },
      chandelier: { period: 14, multiple: 3 },
    },
    sizing: { kind: "weight", weight: 0.1 },
    sleeve: "swing",
  };
  const bars = calendar.map((date) => ({
    date,
    open: 10,
    high: 10.1,
    low: 9.9,
    close: 10,
    volume: 10000,
    amount: 100000,
  }));
  const signalBars = bars.map((b) => ({
    ...b,
    open: b.open * 2,
    high: b.high * 2,
    low: b.low * 2,
    close: b.close * 2,
  }));
  return {
    market: "cn-equity",
    initial: 100000,
    start: calendar[90]!,
    end: calendar[95]!,
    calendar,
    strategies: [strategy],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 1 }],
    costs,
    instruments: [
      {
        symbol: "sh600000",
        market: "cn-equity",
        bars,
        signalBars,
        execution: {
          evidence: "synthetic grid",
          tradable: true,
          limitUp: null,
          limitDown: null,
        },
      },
    ],
  };
}
it("bounded warmup preserves original forward fills/equity and converts genuine signal stops only once across ticks", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const repo = new PaperRepository(db),
      q = request(),
      strategy = q.strategies[0]!;
    const policy = { initial: q.initial, sleeves: q.sleeves, costs: q.costs };
    const account: PaperAccount = {
      id: "bounded-test",
      market: "cn-equity",
      currency: "CNY",
      sleeve: "swing",
      startedAt: Date.parse(`${q.start}T00:00:00+08:00`),
      initial: q.initial,
      candidates: [
        {
          ...(frozen.candidates[0] as unknown as FrozenCandidate),
          strategy,
          executionPolicy: policy,
        },
      ],
      mirror: { venue: "off" },
      mirrorRevision: "fixed",
      revision: 0,
      lastBar: null,
      lastRun: null,
      error: null,
      summary: null,
    };
    repo.create(account);
    const full = runPortfolio(q),
      raw = q.instruments[0]!;
    const dates = q.calendar.filter((d) => d >= q.start && d <= q.end);
    const group = prepareStrategyRulePoints(
      strategy,
      raw.signalBars,
      {},
      dates,
      {
        definitionHash: hash,
        buildHash: hash,
        sourceHashes: { baseline: hash },
      },
    );
    const compiled = {
      ...q,
      instruments: [{ ...raw, external: { preparedRules: [group] } }],
    };
    const input = {
      request: compiled,
      contextVersion: "cn-book-1" as const,
      sourceIdentity: { method: "fixture", raw: hash },
      benchmark: [...raw.bars],
      readyDates: [...dates],
      source: "full-history genuine rule fixture",
    };
    advancePaper(
      repo,
      account.id,
      input,
      Date.parse(`${dates[1]}T17:00:00+08:00`),
    );
    const before = repo.state(account.id)!;
    expect(before.request.calendar.filter((d) => d < q.start)).toHaveLength(60);
    expect(before.contextVersion).toBe("cn-book-1");
    expect(before.request.observationDetail).toBe("counts");
    expect(before.result.observations).toEqual([]);
    expect(before.decisions[0]!.stop).toBeCloseTo(9.6, 12);
    advancePaper(
      repo,
      account.id,
      input,
      Date.parse(`${dates.at(-1)}T17:00:00+08:00`),
    );
    const after = repo.state(account.id)!;
    expect(after.result.fills).toEqual(full.fills);
    expect(after.result.curve).toEqual(full.curve);
    expect(after.result.fills.slice(0, before.result.fills.length)).toEqual(
      before.result.fills,
    );
    const changed = {
      ...input,
      readyDates: [...dates, q.calendar[96]!],
      request: {
        ...compiled,
        instruments: compiled.instruments.map((i) => ({
          ...i,
          external: {
            preparedRules: [
              {
                ...group,
                points: group.points.map((p, index) =>
                  index === 0
                    ? { ...p, sourceHashes: { different: "b".repeat(64) } }
                    : p,
                ),
              },
            ],
          },
        })),
      },
    };
    expect(() =>
      advancePaper(
        repo,
        account.id,
        changed,
        Date.parse(`${q.calendar[96]}T17:00:00+08:00`),
      ),
    ).toThrow("冻结预热或决策来源变化");
  } finally {
    db.close();
  }
});
it("a pure prior-selection seed matches historical weekly retention without bringing warmup capital or DD", () => {
  const q = request(),
    calendar = ["2026-01-02", "2026-01-09", "2026-01-12"];
  const strategy: StrategyObjectInput = {
    ...q.strategies[0]!,
    id: "seed-buffer",
    exit: {},
    universe: { kind: "symbols", symbols: ["sh600000", "sh600001"] },
    rank: { kind: "rps-composite", periods: [20] },
    overlay: { symbolWeight: 0.15 },
    rebalance: {
      kind: "ranked-weekly",
      top: 1,
      retentionMultiple: 2,
      weighting: "equal",
    },
  };
  const instruments = ["sh600000", "sh600001"].map((symbol, k) => {
    const bars = calendar.map((date) => ({
      ...q.instruments[0]!.bars[0]!,
      date,
    }));
    return {
      ...q.instruments[0]!,
      symbol,
      bars,
      signalBars: bars,
      external: {
        rps: calendar.map((date, i) => ({
          date,
          periods: [20],
          values: [{ return: 0.1, rank: 1, rps: (i === 0 ? !k : k) ? 90 : 80 }],
        })),
      },
    };
  });
  const original: PortfolioRequest = {
    ...q,
    start: calendar[2]!,
    end: calendar[2]!,
    calendar,
    strategies: [strategy],
    instruments,
    bookFacts: { [strategy.id]: {} },
    bookSeeds: [
      {
        strategyId: strategy.id,
        date: calendar[1]!,
        availableAt: calendar[1]!,
        selectionFrom: calendar[0],
      },
    ],
  };
  const full = runPortfolio(original);
  const slim: PortfolioRequest = {
    ...boundedPaperRequest(original, original.start),
    calendar: calendar.slice(1),
    instruments: instruments.map((s) => ({
      ...s,
      bars: s.bars.slice(1),
      signalBars: s.signalBars.slice(1),
    })),
    bookSeeds: [
      {
        strategyId: strategy.id,
        date: calendar[1]!,
        availableAt: calendar[1]!,
        previousSelected: {
          date: calendar[0]!,
          availableAt: calendar[0]!,
          symbols: ["sh600000"],
          sourceHash: hash,
        },
      },
    ],
  };
  const projected = runPortfolio(slim);
  expect(projected.fills).toEqual(full.fills);
  expect(projected.fills[0]?.symbol).toBe("sh600000");
  expect(projected.curve).toEqual(full.curve);
  expect(projected.bookStates![strategy.id]!.overlay?.nav).toBe(1);
  const missedOpen = runPortfolio({
    ...slim,
    bookSeeds: slim.bookSeeds!.map((seed) => ({ ...seed, emitOrders: false })),
  });
  expect(missedOpen.fills).toEqual([]);
  expect(missedOpen.bookStates![strategy.id]!.selected).toEqual(["sh600000"]);
  expect(missedOpen.curve[0]!.equity).toBe(q.initial);
  expect(() =>
    runPortfolio({
      ...slim,
      bookSeeds: slim.bookSeeds!.map((s) => ({
        ...s,
        previousSelected: { ...s.previousSelected!, date: s.date },
      })),
    }),
  ).toThrow("prior weekly selection");
});
