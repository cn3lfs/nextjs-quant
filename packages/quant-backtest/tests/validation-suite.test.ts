import { describe, expect, it } from "vitest";
import {
  runPortfolio,
  runValidationSuite,
  validationDefaults,
  type PortfolioRequest,
  type ValidationScore,
} from "../src/index.js";
import { defaultExecutionCosts } from "trading-strategy-core/costs";

function request(): PortfolioRequest {
  const bars = Array.from({ length: 100 }, (_, i) => {
    const close = i < 40 ? 100 + i : 140 - (i - 40);
    return {
      date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
      open: close,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 10000,
      amount: 1000000,
    };
  });
  return {
    market: "crypto",
    start: bars[0]!.date,
    end: bars.at(-1)!.date,
    initial: 10000,
    calendar: bars.map((b) => b.date),
    instruments: [
      {
        symbol: "BTCUSDT",
        market: "crypto",
        bars,
        signalBars: bars,
        execution: {
          minimum: 0.001,
          step: 0.001,
          tradable: true,
          evidence: "fixture",
          limitUp: null,
          limitDown: null,
        },
      },
    ],
    strategies: [
      {
        id: "trend",
        version: 1,
        market: "crypto",
        period: "day",
        universe: { kind: "symbols", symbols: ["BTCUSDT"] },
        entry: { kind: "constant", value: true },
        exit: { maxBars: 3 },
        sizing: { kind: "weight", weight: 1 },
        sleeve: "swing",
      },
    ],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 1, maxPositions: 1 }],
    costs: {
      ...defaultExecutionCosts,
      commissionBps: 10,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 5,
    },
  };
}
const policy = { ...validationDefaults, trainBars: 40, testBars: 10 };
function score(
  result: ReturnType<typeof runPortfolio>,
  req: PortfolioRequest,
): ValidationScore {
  expect(req.instruments[0]!.bars.at(-1)!.date <= req.end).toBe(true);
  let peak = req.initial,
    drawdown = 0,
    previous = req.initial;
  const daily = result.equity.map((p) => {
    peak = Math.max(peak, p.equity);
    drawdown = Math.max(drawdown, 1 - p.equity / peak);
    const r = p.equity / previous - 1;
    previous = p.equity;
    return r;
  });
  const total = result.equity.at(-1)!.equity / req.initial - 1;
  return {
    return: total,
    excess: total,
    drawdown,
    trades: result.fills.filter(
      (f) => f.side === "sell" && f.holdingAfter === 0,
    ).length,
    events: {
      entries: result.observations.filter((o) => o.decision.entry === true)
        .length,
      exits: result.observations.filter((o) => o.decision.exit === true).length,
      orders: result.orders.length,
      fills: result.fills.length,
      rejectionAttempts: result.rejections.length,
    },
    daily,
  };
}
function menu(input = request()) {
  const flat = structuredClone(input);
  flat.strategies = [
    {
      ...flat.strategies[0]!,
      id: "flat",
      entry: { kind: "constant", value: false },
    },
  ];
  return [
    { id: "trend", family: "baseline", request: input },
    { id: "flat", family: "baseline", request: flat },
  ];
}
describe("frozen walk-forward validation", () => {
  it("can pass the declared gates, and a failing cost leg vetoes an otherwise passing candidate", () => {
    const input = request();
    const bars = Array.from({ length: 220 }, (_, i) => ({
      ...input.instruments[0]!.bars[0]!,
      date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
      open: 100 * 1.02 ** i,
      close: 100 * 1.02 ** i,
      high: 100 * 1.02 ** i * 1.02,
      low: 100 * 1.02 ** i * 0.98,
    }));
    input.instruments = [{ ...input.instruments[0]!, bars, signalBars: bars }];
    input.calendar = bars.map((b) => b.date);
    input.end = bars.at(-1)!.date;
    input.strategies = [{ ...input.strategies[0]!, exit: { maxBars: 1 } }];
    const peer = structuredClone(input);
    peer.strategies = [{ ...peer.strategies[0]!, id: "peer" }];
    const candidates = [
      { id: "trend", family: "trend", request: input },
      { id: "peer", family: "trend", request: peer },
    ];
    const passing = runValidationSuite(
      candidates,
      input.calendar,
      { ...policy, testBars: 20 },
      score,
    );
    expect(passing.rows.map((r) => r.reasons)).toEqual([[], []]);
    const stressed = runValidationSuite(
      candidates,
      input.calendar,
      { ...policy, testBars: 20 },
      (result, req) => {
        const value = score(result, req);
        return req.costs!.commissionBps > 10
          ? { ...value, excess: -0.01 }
          : value;
      },
    );
    expect(
      stressed.rows.every(
        (r) => !r.passed && r.reasons.includes("cost-or-delay-stress"),
      ),
    ).toBe(true);
    expect(passing.policy.maximumDrawdown).toBe(
      validationDefaults.maximumDrawdown,
    );
  });
  it("ranks training only, rejects weak OOS, and never supplies future prices to the engine", () => {
    const input = request(),
      dates = input.calendar;
    const suite = runValidationSuite(menu(input), dates, policy, score);
    expect(suite.windows).toHaveLength(6);
    expect(suite.selection[0]!.families[0]!.selectedId).toBe("trend");
    expect(suite.rows[0]!.inSample.return).toBeGreaterThan(0);
    expect(suite.rows[0]!.holdout.base.return).toBeLessThan(0);
    expect(suite.rows[0]!.passed).toBe(false);
    expect(suite.rows[0]!.reasons).toContain("oos-positive-excess-majority");
    const changed = structuredClone(input);
    for (const list of [
      changed.instruments[0]!.bars,
      changed.instruments[0]!.signalBars,
    ])
      for (const b of list.slice(40)) {
        b.open *= 10;
        b.close *= 10;
        b.high *= 10;
        b.low *= 10;
      }
    const future = runValidationSuite(menu(changed), dates, policy, score);
    expect(future.selection[0]).toEqual(suite.selection[0]);
    expect(future.rows[0]!.inSample).toEqual(suite.rows[0]!.inSample);
  });
  it("doubles all costs, delays signals by one bar, and independently fails trade/sample gates", () => {
    const input = request();
    const base = runPortfolio(input),
      delayed = runPortfolio({ ...input, signalDelayBars: 1 });
    expect(base.fills[0]!.date).toBe(input.calendar[1]);
    expect(delayed.fills[0]!.date).toBe(input.calendar[2]);
    const suite = runValidationSuite(
      menu(input),
      input.calendar,
      { ...policy, minimumTrades: 10000 },
      score,
    );
    expect(suite.rows[0]!.holdout.doubledCost.return!).toBeLessThan(
      suite.rows[0]!.holdout.base.return!,
    );
    expect(
      suite.rows.every((r) => r.reasons.includes("insufficient-closed-trades")),
    ).toBe(true);
    expect(() =>
      runValidationSuite(
        menu(input),
        input.calendar,
        { ...policy, trainBars: 100 },
        score,
      ),
    ).toThrow("Invalid");
  });
  it("starts a low-zone sleeve at zero, transfers only idle cash, rejects future targets", () => {
    const input = request();
    const a = input.strategies[0]!,
      b = { ...a, id: "low", sleeve: "low-zone" };
    const result = runPortfolio({
      ...input,
      strategies: [a, b],
      sleeves: [
        input.sleeves[0]!,
        { id: "low-zone", share: 0, riskPerTrade: 1, maxPositions: 1 },
      ],
      rebalance: { everyBars: 20 },
      sleeveTargets: [
        {
          date: input.calendar[5]!,
          availableAt: input.calendar[5]!,
          shares: { swing: 0.6, "low-zone": 0.4 },
        },
      ],
    });
    expect(
      result.curve[0]!.sleeves.find((s) => s.id === "low-zone")!.equity,
    ).toBe(0);
    expect(
      result.fills
        .filter((f) => f.sleeve === "low-zone")
        .every((f) => f.date > input.calendar[5]!),
    ).toBe(true);
    expect(result.transfers.reduce((n, t) => n + t.amount, 0)).toBeCloseTo(
      0,
      8,
    );
    expect(() =>
      runPortfolio({
        ...input,
        sleeveTargets: [
          {
            date: input.calendar[5]!,
            availableAt: input.calendar[6]!,
            shares: { swing: 1 },
          },
        ],
      }),
    ).toThrow("non-causal");
  });
});
