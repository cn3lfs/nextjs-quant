import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import { defaultExecutionCosts } from "trading-strategy-core/costs";
import type { StrategyObjectInput } from "trading-strategies";
import { scanStrategy } from "~/server/strategies/drivers/scan";
import { watchStrategy } from "~/server/strategies/drivers/watch";
import { paperStrategy } from "~/server/strategies/drivers/paper";
import { backtestStrategy } from "~/server/strategies/drivers/backtest";
import validBreakout from "../fixtures/breakout-valid.json";

const network = vi.fn(() => {
  throw new Error("Golden drivers must not request the network");
});
beforeEach(() => vi.stubGlobal("fetch", network));
afterEach(() => {
  expect(network).toHaveBeenCalledTimes(0);
  vi.unstubAllGlobals();
});

const zero = {
  ...defaultExecutionCosts,
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  slippageBps: 0,
};
const bar = (date: string, close: number): Bar => ({
  date,
  open: close,
  close,
  high: close,
  low: close,
  volume: 1000000,
  amount: close * 1000000,
});
const execution = (market: "cn-equity" | "crypto") => ({
  evidence: "fixed golden, no venue requests",
  minimum: market === "crypto" ? 0.001 : 100,
  step: market === "crypto" ? 0.001 : 100,
  limitUp: null,
  limitDown: null,
  tradable: true,
});
function strategy(
  market: "cn-equity" | "crypto",
  entry: StrategyObjectInput["entry"],
  id: string,
): StrategyObjectInput {
  return {
    id,
    version: 1,
    market,
    period: "day",
    universe: {
      kind: "symbols",
      symbols: [market === "crypto" ? "BTCUSDT" : "sh600000"],
    },
    entry,
    exit: {},
    sizing: { kind: "weight", weight: 1 },
    sleeve: "swing",
  };
}
const small = [
  bar("2026-10-12", 10),
  bar("2026-10-13", 10),
  bar("2026-10-14", 10),
  bar("2026-10-15", 10),
  bar("2026-10-16", 12),
];
for (const market of ["cn-equity", "crypto"] as const) {
  describe(`${market} fixed cross-driver golden`, () => {
    const formula = strategy(
      market,
      { kind: "formula", source: "选股:CROSS(C,MA(C,3));" },
      `${market}-formula`,
    );
    const staged = {
      ...strategy(
        market,
        { kind: "formula", source: "选股:C>11;" },
        `${market}-staged`,
      ),
      exit: {
        stop: { kind: "fixed" as const, fraction: 0.1 },
        takeProfit: 0.2,
      },
      sizing: { kind: "risk" as const, fraction: 0.05, tranches: 2 },
    };
    const third =
      market === "cn-equity"
        ? strategy(
            market,
            { kind: "double-breakout", side: "entry" },
            "equity-breakout",
          )
        : strategy(
            market,
            { kind: "dual-ma", fast: 2, slow: 4, side: "entry" },
            "crypto-ma",
          );
    for (const definition of [formula, staged, third])
      it(`${definition.id}: scan = replay signal = watch = paper, future prefix invariant`, () => {
        const bars =
          definition.entry.kind === "double-breakout"
            ? validBreakout.bars
            : small;
        const symbol = market === "crypto" ? "BTCUSDT" : "sh600000";
        const asOf = bars.at(-1)!.date;
        const series = { market, symbol, bars };
        const run = (inputBars: readonly Bar[]) => {
          const inputSeries = { ...series, bars: inputBars };
          const candidates = scanStrategy(definition, [inputSeries], asOf, {
            capital: {
              equity: 100000,
              cash: 100000,
              riskPerTrade: 0.05,
              ...execution(market),
            },
          });
          const replay = backtestStrategy({
            market,
            initial: 100000,
            start: asOf,
            end: asOf,
            costs: zero,
            observationDetail: "full",
            calendar: inputBars.map((b) => b.date),
            instruments: [
              {
                ...inputSeries,
                signalBars: inputBars,
                execution: execution(market),
              },
            ],
            strategies: [definition],
            sleeves: [
              { id: "swing", share: 1, riskPerTrade: 0.05, maxPositions: 1 },
            ],
          });
          const events = watchStrategy(definition, inputSeries, asOf);
          const intents = paperStrategy(definition, inputSeries, asOf);
          expect(
            candidates.map((c) => [c.strategy.id, c.symbol, c.bar]),
          ).toEqual([[definition.id, symbol, asOf]]);
          expect(replay.observations).toEqual([
            {
              date: asOf,
              strategyId: definition.id,
              symbol,
              decision: {
                entry: true,
                exit: false,
                stopLevel: definition.exit.stop
                  ? bars.at(-1)!.close * 0.9
                  : definition.entry.kind === "double-breakout"
                    ? 23.8 // Confirmed swing low in the fixed equity fixture.
                    : null,
              },
            },
          ]);
          expect(
            events.map((e) => [e.strategyId, e.symbol, e.bar, e.type]),
          ).toEqual([[definition.id, symbol, asOf, "entry"]]);
          expect(intents).toEqual(events.map((e) => ({ ...e, side: "BUY" })));
          expect(
            replay.orders.map((o) => [
              o.strategyId,
              o.symbol,
              o.signalAt,
              o.side,
            ]),
          ).toEqual([[definition.id, symbol, asOf, "buy"]]);
          expect(candidates[0]!.quantity).toBeGreaterThan(0);
          if (definition.id.endsWith("staged")) {
            // 100000*5% / (12-10.8) = 4166.66; 2 tranches cap first budget at 50000.
            expect(candidates[0]).toMatchObject({
              tranches: 2,
              sleeve: "swing",
              stop: 10.8,
              target: 14.399999999999999,
            });
            expect(candidates[0]!.quantity).toBe(
              market === "cn-equity" ? 4100 : 4166.666,
            );
          }
          return {
            candidates,
            events,
            intents,
            observations: replay.observations,
          };
        };
        const before = run(bars);
        const future = new Date(Date.parse(asOf) + 86400000)
          .toISOString()
          .slice(0, 10);
        expect(run([...bars, bar(future, 1000)])).toEqual(before);
        // Negative control changes the rule, so a fabricated shared empty output cannot pass.
        expect(
          scanStrategy(
            { ...definition, entry: { kind: "formula", source: "选股:C<0;" } },
            [series],
            asOf,
          ),
        ).toEqual([]);
      });
  });
}

it("stop wins over target, raw protection and next-open entry agree with replay", () => {
  const definition = {
    ...strategy("crypto", { kind: "constant", value: true }, "protected"),
    exit: { stop: { kind: "fixed" as const, fraction: 0.1 }, takeProfit: 0.2 },
  };
  const bars = [
    bar("2026-10-12", 10),
    { ...bar("2026-10-13", 10), low: 8, high: 13 },
  ];
  const replay = backtestStrategy({
    market: "crypto",
    initial: 1000,
    start: bars[0]!.date,
    end: bars[1]!.date,
    costs: zero,
    calendar: bars.map((b) => b.date),
    instruments: [
      {
        market: "crypto",
        symbol: "BTCUSDT",
        bars,
        signalBars: bars,
        execution: execution("crypto"),
      },
    ],
    strategies: [definition],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 1, maxPositions: 1 }],
  });
  const position = {
    quantity: 100,
    stop: 9,
    target: 12,
    high: 10,
    bars: 0,
    tranches: 1,
  };
  const events = watchStrategy(
    definition,
    { market: "crypto", symbol: "BTCUSDT", bars },
    bars[1]!.date,
    { position },
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "stop", price: 9 });
  expect(
    replay.fills.filter((f) => f.side === "sell").map((f) => [f.date, f.price]),
  ).toEqual([[bars[1]!.date, 9]]);
  expect(
    paperStrategy(
      definition,
      { market: "crypto", symbol: "BTCUSDT", bars },
      bars[1]!.date,
      { position },
    ),
  ).toEqual(events.map((e) => ({ ...e, side: "SELL" })));
});

it("completed-bar exit suppresses entry and universe absence never means all-market", () => {
  const definition = {
    ...strategy("crypto", { kind: "constant", value: true }, "exit"),
    exit: { rule: { kind: "formula" as const, source: "退出:C>11;" } },
  };
  const series = { market: "crypto" as const, symbol: "BTCUSDT", bars: small };
  expect(scanStrategy(definition, [series], small.at(-1)!.date)).toEqual([]);
  expect(
    watchStrategy(definition, series, small.at(-1)!.date).map((e) => e.type),
  ).toEqual(["exit"]);
  expect(
    paperStrategy(definition, series, small.at(-1)!.date).map((e) => e.side),
  ).toEqual(["SELL"]);
  expect(() =>
    scanStrategy(
      { ...definition, exit: {}, universe: { kind: "pool", id: "missing" } },
      [series],
      small.at(-1)!.date,
    ),
  ).toThrow("membership");
});

it("native monitor strategy consumes confirmed observations with first-run and seen-key baselines", () => {
  const definition = strategy(
    "cn-equity",
    { kind: "czsc-monitor", config: 1100 },
    "native-observation",
  );
  const asOf = small.at(-1)!.date;
  const observations = [
    {
      date: asOf,
      availableAt: asOf,
      endpointDate: small[0]!.date,
      config: 1100,
      key: "native-3",
      kind: 3,
      quality: 1,
    },
    {
      date: asOf,
      availableAt: asOf,
      endpointDate: small[0]!.date,
      config: 1100,
      key: "observation-only",
      kind: 1,
      quality: 3,
    },
  ];
  const series = {
    symbol: "sh600000",
    market: "cn-equity" as const,
    bars: small,
    external: { monitorCzsc: { observations, seenKeys: [] as string[] } },
  };
  expect(scanStrategy(definition, [series], asOf)).toHaveLength(1);
  expect(watchStrategy(definition, series, asOf)).toHaveLength(1);
  expect(paperStrategy(definition, series, asOf).map((e) => e.side)).toEqual([
    "BUY",
  ]);
  series.external.monitorCzsc.seenKeys.push("native-3");
  expect(watchStrategy(definition, series, asOf)).toEqual([]);
  expect(
    watchStrategy(
      definition,
      { ...series, external: { monitorCzsc: { observations } } },
      asOf,
    ),
  ).toEqual([]);
  expect(() =>
    watchStrategy(
      definition,
      {
        ...series,
        external: {
          monitorCzsc: {
            observations: [{ ...observations[0]!, availableAt: "2026-10-17" }],
            seenKeys: [],
          },
        },
      },
      asOf,
    ),
  ).toThrow("non-causal");
});
