import { describe, expect, it } from "vitest";
import {
  runPortfolio,
  type PortfolioInstrument,
  type PortfolioRequest,
} from "quant-backtest";
import {
  prepareStrategy,
  strategyObjectSchema,
  factorStrategyPresets,
  strategyForMethod,
  type FrozenChanObservation,
  type StrategyObjectInput,
} from "trading-strategies";
import { defaultExecutionCosts } from "trading-strategy-core/costs";
import type { Bar } from "trading-strategy-core/bars";

const zero = {
  ...defaultExecutionCosts,
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  slippageBps: 0,
};
const dates = [
  "2026-10-09",
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
  "2026-10-15",
];
const bar = (date: string, price = 10): Bar => ({
  date,
  open: price,
  close: price,
  high: price + 1,
  low: price - 1,
  volume: 1000,
  amount: 10000,
});
function strategy(
  market: "cn-equity" | "crypto" = "cn-equity",
): StrategyObjectInput {
  return {
    id: "test",
    version: 1,
    market,
    period: "day",
    universe: { kind: "symbols", symbols: ["A", "B"] },
    entry: { kind: "formula", source: "选股:C=10;" },
    exit: { rule: { kind: "formula", source: "离场:C<10;" } },
    sizing: { kind: "weight", weight: 1 },
    sleeve: "swing",
  };
}
function instrument(
  market: "cn-equity" | "crypto" = "cn-equity",
  symbol = "A",
): PortfolioInstrument {
  const bars = dates.map((d) => bar(d));
  return {
    symbol,
    market,
    bars,
    signalBars: structuredClone(bars),
    execution: {
      evidence: "fixed test scenario",
      minimum: market === "crypto" ? 0.001 : 100,
      step: market === "crypto" ? 0.001 : 100,
      limitUp: null,
      limitDown: null,
      tradable: true,
    },
  };
}
function request(
  market: "cn-equity" | "crypto" = "cn-equity",
): PortfolioRequest {
  return {
    market,
    initial: 10000,
    start: dates[0]!,
    end: dates.at(-1)!,
    calendar: dates,
    instruments: [instrument(market)],
    strategies: [strategy(market)],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 1, maxPositions: 2 }],
    costs: zero,
  };
}

describe("one portfolio event engine", () => {
  it("buys exactly one affordable lot at the fee boundary without binary64 under-sizing", () => {
    const input = request(),
      s = strategy();
    s.entry = { kind: "constant", value: true };
    s.exit = {};
    input.strategies = [s];
    input.initial = 1.001;
    input.costs = { ...zero, commissionBps: 10 };
    const bars = dates.map((date) => ({
      ...bar(date),
      open: 0.01,
      high: 0.02,
      low: 0.005,
      close: 0.01,
    }));
    input.instruments = [{ ...instrument(), bars, signalBars: bars }];
    // 100 * 0.01 + 10bp commission = exactly 1.001; no spare cash is required.
    const result = runPortfolio(input);
    expect(result.fills.map((f) => [f.quantity, f.fee, f.cashAfter])).toEqual([
      [100, 0.001, 0],
    ]);
  });
  it("risk limits include fees already paid by earlier tranches and the future exit fee", () => {
    const input = request("crypto"),
      s = strategy("crypto");
    s.sizing = { kind: "risk", fraction: 0.01, tranches: 2 };
    s.exit = { stop: { kind: "fixed", fraction: 0.1 } };
    input.strategies = [s];
    input.costs = { ...zero, commissionBps: 100 };
    input.sleeves = [
      { id: "swing", share: 1, riskPerTrade: 0.01, maxPositions: 1 },
    ];
    const bars = dates.map((d) => ({ ...bar(d), high: 10.5, low: 9.5 }));
    input.instruments = [{ ...instrument("crypto"), bars, signalBars: bars }];
    const result = runPortfolio(input);
    const buys = result.fills.filter((f) => f.side === "buy");
    const quantity = buys.reduce((n, f) => n + f.quantity, 0);
    const paidFees = buys.reduce((n, f) => n + f.fee, 0);
    // Loss to the known 9-dollar stop + paid entry fees + 1% exit fee <= $100.
    expect(
      quantity * (10 - 9) + paidFees + quantity * 9 * 0.01,
    ).toBeLessThanOrEqual(100 + 1e-8);
  });
  it("cross-market hand calculation uses the same serialized rule, raw fills, and venue quantity", () => {
    for (const market of ["cn-equity", "crypto"] as const) {
      const input = request(market),
        source = instrument(market);
      const timeline =
        market === "crypto"
          ? [
              "2026-10-09",
              "2026-10-10",
              "2026-10-11",
              "2026-10-12",
              "2026-10-13",
            ]
          : dates;
      input.calendar = timeline;
      input.end = timeline.at(-1)!;
      const raw = timeline.map((d, i) => bar(d, i >= 2 ? 9 : 10));
      // A 2:1 split on day three: 1000 shares -> 2000 at 4.5 raw,
      // signals remain 9. Crypto has no split and trades every calendar day.
      const actionDate = timeline[2]!;
      const bars =
        market === "cn-equity"
          ? raw.map((b, i) =>
              i >= 2
                ? {
                    ...b,
                    open: b.open / 2,
                    high: b.high / 2,
                    low: b.low / 2,
                    close: b.close / 2,
                  }
                : b,
            )
          : raw;
      input.instruments = [
        {
          ...source,
          bars,
          signalBars: raw,
          ...(market === "cn-equity"
            ? {
                actions: [
                  {
                    date: actionDate,
                    dividend: 0,
                    bonus: 1,
                    evidence: "split fixture",
                    availableAt: actionDate,
                    sharesSellableAt: actionDate,
                  },
                ],
              }
            : {}),
        },
      ];
      input.initial = market === "crypto" ? 100.05 : 10000;
      input.costs = market === "crypto" ? { ...zero, commissionBps: 10 } : zero;
      const result = runPortfolio(
        JSON.parse(JSON.stringify(input)) as PortfolioRequest,
      );
      expect(result.fills.map((f) => [f.side, f.date])).toEqual([
        ["buy", timeline[1]],
        ["sell", timeline[3]],
      ]);
      if (market === "cn-equity") {
        expect(result.fills.map((f) => [f.quantity, f.price, f.fee])).toEqual([
          [1000, 10, 0],
          [2000, 4.5, 0],
        ]);
        expect(result.equity.at(-1)!.equity).toBe(9000);
      } else {
        // 9.995 * 10 + 0.09995 = 100.04995; sell at 9, fee 0.089955.
        expect(result.fills[0]).toMatchObject({
          quantity: 9.995,
          fee: 0.09995,
        });
        expect(result.fills[1]).toMatchObject({
          quantity: 9.995,
          price: 9,
          fee: 0.089955,
        });
        expect(result.equity.at(-1)!.equity).toBeCloseTo(89.865095, 8);
      }
    }
  });
  it("gap stops use raw open, T+1 blocks same-day inventory, crypto T+0 closes it", () => {
    for (const market of ["cn-equity", "crypto"] as const) {
      const input = request(market),
        s = strategy(market);
      s.exit = { stop: { kind: "fixed", fraction: 0.1 } };
      input.strategies = [s];
      const bars = [
        bar(dates[0]!),
        { ...bar(dates[1]!), low: 8 },
        bar(dates[2]!, 8),
        bar(dates[3]!, 8),
        bar(dates[4]!, 8),
      ];
      input.instruments = [{ ...instrument(market), bars, signalBars: bars }];
      const result = runPortfolio(input);
      expect(result.fills[1]).toMatchObject({
        side: "sell",
        date: dates[market === "cn-equity" ? 2 : 1],
        price: market === "cn-equity" ? 8 : 9,
      });
      expect(result.rejections.some((x) => x.reason.includes("T+1"))).toBe(
        market === "cn-equity",
      );
    }
  });
  it("blocks upper-limit buys and lower-limit exits; missing bars are not synthetic fills", () => {
    const input = request();
    input.instruments = [
      {
        ...instrument(),
        execution: Object.fromEntries(
          dates.map((d) => [
            d,
            {
              evidence: "daily limits",
              limitUp: 10,
              limitDown: 9,
              tradable: true,
            },
          ]),
        ),
      },
    ];
    const blocked = runPortfolio(input);
    expect(blocked.fills).toEqual([]);
    expect(blocked.rejections[0]!.reason).toContain("涨停");
    input.instruments = [
      {
        ...instrument(),
        bars: instrument().bars.filter((b) => b.date !== dates[1]),
        signalBars: instrument().bars.filter((b) => b.date !== dates[1]),
      },
    ];
    const missing = runPortfolio(input);
    expect(missing.orders[0]).toMatchObject({
      status: "rejected",
      attempts: 1,
    });
    expect(missing.rejections[0]!.reason).toContain("缺少");
    expect(missing.fills[0]!.signalAt).toBe(dates[2]);
  });
  it("sleeve shares, position limits, tranches, risk and transfers conserve total cash", () => {
    const input = request(),
      s = strategy();
    s.sizing = { kind: "risk", fraction: 0.02, tranches: 2 };
    s.exit = { stop: { kind: "fixed", fraction: 0.1 } };
    input.strategies = [s];
    input.sleeves = [
      { id: "swing", share: 0.6, riskPerTrade: 0.01, maxPositions: 1 },
      { id: "long", share: 0.4, riskPerTrade: 0.01, maxPositions: 2 },
    ];
    input.instruments = [instrument(), instrument("cn-equity", "B")];
    input.rebalance = { everyBars: 1, drift: 0.05 };
    // 60 risk dollars is less than one lot's 100-dollar risk: no invented lot.
    expect(runPortfolio(input).fills).toEqual([]);
    s.sizing = { kind: "weight", weight: 1, tranches: 2 };
    s.exit = {};
    const result = runPortfolio(input);
    expect(result.fills.map((f) => f.quantity)).toEqual([300, 300]);
    expect(result.rejections.some((r) => r.reason.includes("持仓上限"))).toBe(
      true,
    );
    for (const row of result.equity)
      expect(row.sleeves.reduce((n, s) => n + s.equity, 0)).toBe(row.equity);
    expect(result.equity.at(-1)!.equity).toBe(10000);
    expect(result.transfers.reduce((n, t) => n + t.amount, 0)).toBeCloseTo(
      0,
      10,
    );
  });
  it("stop before target in an ambiguous bar; trailing uses the prior known high", () => {
    const input = request("crypto"),
      s = strategy("crypto");
    s.exit = { stop: { kind: "fixed", fraction: 0.1 }, takeProfit: 0.1 };
    input.strategies = [s];
    const bars = dates.map((d) => bar(d));
    bars[1] = { ...bar(dates[1]!), high: 12, low: 8 };
    input.instruments = [{ ...instrument("crypto"), bars, signalBars: bars }];
    const result = runPortfolio(input);
    expect(result.fills[1]!.price).toBe(9);
    expect(result.orders[1]!.trigger).toBe("stop");
    s.exit = { trailing: 0.1 };
    bars[1] = { ...bar(dates[1]!), high: 20, low: 10 };
    bars[2] = { ...bar(dates[2]!, 19), low: 17 };
    const trailing = runPortfolio(input);
    expect(trailing.fills[1]).toMatchObject({ date: dates[2], price: 18 });
  });
  it("rejects unknown venue steps, future universes and unproven bonus shares", () => {
    const input = request("crypto");
    input.instruments = [
      {
        ...instrument("crypto"),
        execution: {
          evidence: "no step evidence",
          limitUp: null,
          limitDown: null,
          tradable: true,
        },
      },
    ];
    expect(runPortfolio(input).fills).toEqual([]);
    input.memberships = [
      {
        strategyId: "test",
        date: dates[0]!,
        availableAt: dates[1]!,
        symbols: ["A"],
      },
    ];
    expect(() => runPortfolio(input)).toThrow("PIT");
    input.memberships = [];
    input.instruments = [
      {
        ...instrument("crypto"),
        actions: [
          {
            date: dates[2]!,
            dividend: 0,
            bonus: 1,
            evidence: "missing sale date",
            availableAt: dates[2]!,
          },
        ],
      },
    ];
    expect(() => runPortfolio(input)).toThrow("corporate action");
  });
  it("drift rebalancing transfers only idle cash and preserves combined wealth", () => {
    const input = request(),
      s = strategy();
    s.sizing = { kind: "weight", weight: 0.5 };
    input.strategies = [s];
    input.sleeves = [
      { id: "swing", share: 0.6, riskPerTrade: 1, maxPositions: 1 },
      { id: "long", share: 0.4, riskPerTrade: 1, maxPositions: 1 },
    ];
    input.rebalance = { drift: 0.05 };
    const bars = dates.map((d, i) => bar(d, i < 2 ? 10 : 20));
    input.instruments = [{ ...instrument(), bars, signalBars: bars }];
    const result = runPortfolio(input);
    expect(result.transfers).toEqual([
      { date: dates[2], sleeve: "swing", amount: -1200 },
      { date: dates[2], sleeve: "long", amount: 1200 },
    ]);
    expect(result.equity.at(-1)!.equity).toBe(13000);
    expect(result.equity.at(-1)!.sleeves.map((s) => s.equity)).toEqual([
      7800, 5200,
    ]);
  });
});

describe("strategy serialization and causal decisions", () => {
  it("ATR and structural stops preserve unknown values and reject future structural evidence", () => {
    const bars = dates.map((d) => bar(d)),
      s = strategy();
    s.exit = { stop: { kind: "atr", period: 2, multiple: 2 } };
    const atr = prepareStrategy(s, bars);
    expect(atr.evaluate(0).stopLevel).toBeNull();
    // Two complete TR values of 2: 10 - 2 * ATR(2) = 6.
    expect(atr.evaluate(2).stopLevel).toBe(6);
    s.exit = { stop: { kind: "structure", field: "support" } };
    expect(prepareStrategy(s, bars).evaluate(2).stopLevel).toBeNull();
    const levels = [
      { date: dates[2]!, availableAt: dates[2]!, field: "support", value: 8 },
    ];
    expect(prepareStrategy(s, bars, { levels }).evaluate(2).stopLevel).toBe(8);
    levels[0]!.availableAt = dates[3]!;
    expect(() => prepareStrategy(s, bars, { levels }).evaluate(2)).toThrow(
      "Non-causal",
    );
  });
  it("RPS thresholds retain equality, unknown observations, and future isolation", () => {
    const bars = dates.map((d) => bar(d)),
      s = strategy();
    s.entry = { kind: "rps", period: 20, minimum: 80 };
    const rps = dates.map((date, i) => ({
      date,
      periods: [20],
      values: [{ rps: i === 0 ? 79.99 : 80, rank: 1, return: 0.1 }],
    }));
    const rule = prepareStrategy(s, bars, { rps });
    expect(rule.evaluate(0).entry).toBe(false);
    expect(rule.evaluate(1).entry).toBe(true);
    expect(prepareStrategy(s, bars).evaluate(1).entry).toBeNull();
    expect(
      prepareStrategy(s, bars.slice(0, 2), { rps: rps.slice(0, 2) }).evaluate(
        1,
      ),
    ).toEqual(rule.evaluate(1));
  });
  it("formula, MA, factor, breakout, and RPS decisions retain every earlier prefix", () => {
    const bars = Array.from({ length: 85 }, (_, i) =>
      bar(
        new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
        10 + Math.sin(i / 3),
      ),
    );
    const entries: StrategyObjectInput["entry"][] = [
      { kind: "formula", source: "选股:CROSS(MA(C,5),MA(C,20));" },
      { kind: "dual-ma", fast: 5, slow: 20, side: "entry" },
      { kind: "factor", strategy: factorStrategyPresets[0]!, side: "entry" },
      { kind: "double-breakout", side: "entry" },
      { kind: "rps", period: 20, minimum: 80 },
    ];
    for (const entry of entries) {
      const s = { ...strategy(), entry };
      const full = prepareStrategy(
        JSON.parse(JSON.stringify(s)) as StrategyObjectInput,
        bars,
      );
      const short = prepareStrategy(s, bars.slice(0, 70));
      for (let i = 60; i < 70; i++)
        expect(full.evaluate(i)).toEqual(short.evaluate(i));
    }
  });
  it("known violations prove the future-function, schema, and external causality gates", () => {
    const s = strategy();
    s.entry = { kind: "formula", source: "X:=REFX(C,1);选股:C>0;" };
    expect(() => prepareStrategy(s, [])).toThrow("REFX");
    expect(
      strategyObjectSchema.safeParse({ ...strategy(), version: 2 }).success,
    ).toBe(false);
    s.entry = { kind: "external", id: "native", side: "entry" };
    expect(() =>
      prepareStrategy(
        s,
        dates.map((d) => bar(d)),
        {
          signals: [
            {
              id: "native",
              date: dates[0]!,
              availableAt: dates[1]!,
              entry: true,
              exit: false,
            },
          ],
        },
      ),
    ).toThrow("non-causal");
  });
  it("native three-buy binding consumes only confirmed serial-worker observations and rejects future metadata", () => {
    const bars = Array.from({ length: 143 }, (_, i) =>
      bar(new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10)),
    );
    const identity = {
      dllHash: "a".repeat(64),
      apiVersion: 22,
      buildCommit: "fixture",
      configId: "fixture",
      config: 0 as const,
      anchor: 1 as const,
    };
    const observations: FrozenChanObservation[] = [139, 140, 141, 142].map(
      (i, n) => ({
        date: bars[i]!.date,
        prefixHash: "b".repeat(64),
        identity,
        baseline: n === 0,
        signals:
          n === 1
            ? [
                {
                  key: `${bars[138]!.date}:3`,
                  endpointIndex: 138,
                  endpointDate: bars[138]!.date,
                  confirmedAt: 140,
                  confirmedDate: bars[140]!.date,
                  centerId: 1,
                  center: {
                    start: 130,
                    end: 137,
                    startDate: bars[130]!.date,
                    endDate: bars[137]!.date,
                    ZD: 8,
                    ZG: 9,
                    confirmedAt: -1,
                    established: 137,
                  },
                },
              ]
            : [],
        gaps: [],
      }),
    );
    const s = strategyForMethod("CH03", {
      id: "native",
      market: "cn-equity",
      universe: { kind: "symbols", symbols: ["A"] },
      sizing: { kind: "weight", weight: 1 },
      sleeve: "swing",
      firstIndex: 140,
    });
    const full = prepareStrategy(s, bars, { chan: observations });
    const prefix = prepareStrategy(s, bars.slice(0, 141), {
      chan: observations.slice(0, 2),
    });
    expect(full.evaluate(139).entry).toBe(false);
    expect(full.evaluate(140).entry).toBe(true);
    expect(full.evaluate(140)).toEqual(prefix.evaluate(140));
    const invalid = structuredClone(observations);
    invalid[1]!.signals[0]!.confirmedAt = 142;
    expect(() =>
      prepareStrategy(s, bars, { chan: invalid }).evaluate(140),
    ).toThrow("前缀");
    expect(() => strategyForMethod("SW01", { ...s, firstIndex: 140 })).toThrow(
      "reference-only",
    );
  });
});
