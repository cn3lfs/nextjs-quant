import { expect, it } from "vitest";
import {
  runPortfolio,
  createPortfolioPreparation,
  type PortfolioRequest,
} from "../src/index.js";
import { preparePortfolioRequest } from "../src/portfolio/preparation.js";

const dates = Array.from({ length: 9 }, (_, i) => `2024-05-${String(10 + i)}`);
const symbols = Array.from({ length: 11 }, (_, i) => `sh${600000 + i}`);
function fixture(
  names: string[],
  sleeves = ["a", "b"],
  calendar = dates,
): PortfolioRequest {
  return {
    market: "cn-equity",
    initial: 100000,
    calendar,
    start: calendar[0]!,
    end: calendar.at(-1)!,
    costs: {
      version: "cost-experiment-1",
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
    sleeves: sleeves.map((id) => ({
      id,
      share: 1 / sleeves.length,
      maxPositions: 15,
      riskPerTrade: 1,
    })),
    strategies: sleeves.map((id) => ({
      id,
      version: 1,
      market: "cn-equity",
      period: "day",
      sleeve: id,
      universe: { kind: "symbols", symbols: names },
      entry: { kind: "external", id, side: "entry" },
      exit: { rule: { kind: "external", id, side: "exit" } },
      sizing: { kind: "weight", weight: 0.1 },
    })),
    instruments: names.map((symbol) => {
      const bars = calendar.map((date) => ({
        date,
        open: 10,
        close: 10,
        high: 11,
        low: 9,
        volume: 100000,
        amount: 1000000,
      }));
      return {
        symbol,
        market: "cn-equity",
        bars,
        signalBars: bars,
        execution: {
          tradable: true,
          minimum: 100,
          step: 100,
          evidence: "fixture",
          limitUp: null,
          limitDown: null,
        },
        external: {
          signals: sleeves.flatMap((id) =>
            calendar.map((date, i) => ({
              id,
              date,
              availableAt: date,
              entry: i === (names.indexOf(symbol) < 9 ? 0 : 2),
              exit: false,
            })),
          ),
        },
      };
    }),
  };
}

it.each(["symbol-ascending", "symbol-descending"] as const)(
  "allocates the tenth distinct name by %s across sleeves, independent of input order",
  (buyTieBreak) => {
    const input = fixture(symbols);
    // Each contender belongs to a different sleeve. Both already own names.
    input.strategies = input.strategies.map((s, i) => ({
      ...s,
      universe: {
        kind: "symbols",
        symbols: i
          ? symbols.slice(5, 9).concat(symbols[9]!)
          : [...symbols.slice(0, 5), symbols[10]!],
      },
    }));
    const req = { ...input, accountMaxUniqueSymbols: 10, buyTieBreak };
    const result = runPortfolio(req);
    expect(
      new Set(
        result.positionSnapshots
          .filter((p) => p.date === dates[1])
          .map((p) => p.symbol),
      ).size,
    ).toBe(9);
    expect(new Set(result.positions.map((p) => p.symbol)).size).toBe(10);
    const winner =
      buyTieBreak === "symbol-descending" ? symbols[10] : symbols[9];
    expect(
      result.fills.filter((f) => f.date === dates[3]).map((f) => f.symbol),
    ).toEqual([winner]);
    expect(result.rejections.map((r) => r.reason)).toContain(
      "账户跨分仓持仓品种上限",
    );
    const reversed = runPortfolio({
      ...req,
      sleeves: [...req.sleeves].reverse(),
      strategies: [...req.strategies].reverse(),
      instruments: [...req.instruments].reverse(),
    });
    expect(reversed.positions.map((p) => p.symbol).sort()).toEqual(
      result.positions.map((p) => p.symbol).sort(),
    );
  },
);

it("clips an existing name across sleeves and refuses an additional tranche at the aggregate weight limit", () => {
  const req = fixture(symbols.slice(0, 1));
  req.accountMaxSymbolWeight = 0.1;
  req.strategies = req.strategies.map((s) => ({
    ...s,
    sizing: { kind: "weight", weight: 0.32, tranches: 2 },
  }));
  const ins = req.instruments[0]!;
  req.instruments = [
    {
      ...ins,
      external: {
        signals: ins.external!.signals!.map((s) => ({
          ...s,
          entry: s.date === dates[0] || s.date === dates[2],
        })),
      },
    },
  ];
  const result = runPortfolio(req);
  expect(result.positions).toHaveLength(2);
  expect(
    result.positions.reduce((sum, p) => sum + p.quantity * p.mark, 0),
  ).toBe(10000);
  expect(
    result.rejections.filter((r) => r.reason === "账户跨分仓单票权重上限"),
  ).toHaveLength(2);
});

it("reserves the buy fee when an exact board lot reaches the pre-fee weight limit", () => {
  const req = fixture(symbols.slice(0, 1), ["a"]);
  req.costs = { ...req.costs!, minimumCommission: 5 };
  const result = runPortfolio({ ...req, accountMaxSymbolWeight: 0.1 });
  expect(result.positions[0]!.quantity).toBe(900);
  expect(result.positionSnapshots.every((p) => p.weight <= 0.1)).toBe(true);
});

it.each(["clip", "reject"] as const)(
  "shares 0.5%% of one symbol's turnover between both sleeves under %s",
  (capacityPolicy) => {
    const req = fixture(symbols.slice(0, 1));
    req.strategies = req.strategies.map((s) => ({
      ...s,
      sizing: { kind: "weight", weight: 0.06 },
    }));
    const result = runPortfolio({
      ...req,
      maxParticipation: 0.005,
      capacityPolicy,
    });
    const amounts = result.fills.map((f) => f.quantity * f.price);
    expect(amounts).toEqual(capacityPolicy === "clip" ? [3000, 2000] : [3000]);
    expect(amounts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
      1000000 * 0.005,
    );
  },
);

it("deducts the prior sleeve's opening sale before filling a same-symbol buy", () => {
  const req = fixture(symbols.slice(0, 1)),
    ins = req.instruments[0]!;
  req.strategies = req.strategies.map((s) => ({
    ...s,
    sizing: { kind: "weight", weight: 0.06 },
  }));
  req.instruments = [
    {
      ...ins,
      external: {
        signals: ins.external!.signals!.map((s) => ({
          ...s,
          entry: s.date === (s.id === "a" ? dates[0] : dates[2]),
          exit: s.id === "a" && s.date === dates[2],
        })),
      },
    },
  ];
  const result = runPortfolio({
    ...req,
    maxParticipation: 0.005,
    capacityPolicy: "clip",
  });
  expect(
    result.fills
      .filter((f) => f.date === dates[3])
      .map((f) => [f.side, f.quantity * f.price]),
  ).toEqual([
    ["sell", 3000],
    ["buy", 2000],
  ]);
});

it("collects exact daily counts for an ordinary strategy only on request", () => {
  const req = fixture(symbols.slice(0, 1), ["a"]);
  expect(runPortfolio(req).dailyDecisionCounts).toBeUndefined();
  expect(
    runPortfolio({ ...req, collectDailyDecisionCounts: true })
      .dailyDecisionCounts,
  ).toEqual(
    dates.map((date, i) => ({
      date,
      strategyId: "a",
      expected: 1,
      entries: i === 0 ? 1 : 0,
      unknown: 0,
    })),
  );
});

function replayExitSignals(
  req: PortfolioRequest,
  halfAt: number,
  fullAt?: number,
) {
  const preparation = createPortfolioPreparation();
  const evaluator = preparePortfolioRequest(req, preparation)
    .instruments.get(symbols[0]!)!
    .evaluators.get("a")!;
  const evaluate = evaluator.evaluate.bind(evaluator);
  evaluator.evaluate = (i, position) => ({
    ...evaluate(i, position),
    exit: i === halfAt || i === fullAt,
    ...(i === halfAt && { exitFraction: 0.5 }),
  });
  return runPortfolio(req, undefined, preparation);
}

function partialReplay(fullExit: boolean, bonus = 0) {
  const calendar = [
    "2024-05-10T09:35:00+08:00",
    "2024-05-10T09:40:00+08:00",
    "2024-05-10T09:45:00+08:00",
    ...["13", "14", "15", "16", "17", "20", "21", "22", "23"].map(
      (d) => `2024-05-${d}T09:35:00+08:00`,
    ),
  ];
  const req = fixture([symbols[0]!], ["a"], calendar);
  req.strategies = [{ ...req.strategies[0]!, period: "5m" }];
  req.maxParticipation = 0.005;
  req.capacityPolicy = "clip";
  const ins = req.instruments[0]!;
  const bars = ins.bars.map((b, i) => ({
    ...b,
    amount: i < 4 ? 2000000 : i === 5 && bonus === 0.1 ? 600000 : 400000,
    ...(i === 3 ? { low: 10, high: 10 } : {}),
  }));
  req.instruments = [
    {
      ...ins,
      bars,
      signalBars: bars,
      execution: (bar) => ({
        tradable: true,
        minimum: 100,
        step: 100,
        evidence: "fixture",
        limitUp: null,
        limitDown: bar?.date === calendar[3] ? 10 : null,
      }),
      actions: bonus
        ? [
            {
              date: calendar[5]!,
              availableAt: calendar[5]!,
              sharesSellableAt: calendar[5]!,
              bonus,
              dividend: 0,
              evidence: "fixture",
            },
          ]
        : [],
    },
  ];
  return replayExitSignals(req, 1, fullExit ? 4 : undefined);
}

it("freezes 500 remaining before a T+1 rejection, limit-down retry and three capacity-limited fills", () => {
  const result = partialReplay(false);
  expect(result.rejections.map((r) => r.reason).join(" ")).toMatch(
    /T\+1.*跌停/,
  );
  expect(result.fills.map((f) => f.holdingAfter)).toEqual([
    1000, 800, 600, 500,
  ]);
  expect(result.orders.filter((o) => o.side === "sell")).toMatchObject([
    { exitFraction: 0.5, targetRemainingQuantity: 500, status: "filled" },
  ]);
});

it("upgrades a partly executed pending reduction when a full exit arrives", () => {
  const result = partialReplay(true);
  expect(result.positions).toHaveLength(0);
  expect(result.orders.filter((o) => o.side === "sell")).toMatchObject([
    { targetRemainingQuantity: 500, exitFraction: 0.5, status: "rejected" },
    { status: "filled" },
  ]);
  expect(
    result.fills
      .filter((f) => f.side === "sell")
      .reduce((n, f) => n + f.quantity, 0),
  ).toBe(1000);
});

it("rescales a pending reduction's frozen share target through a stock dividend", () => {
  const result = partialReplay(false, 1);
  expect(result.corporateActions[0]).toMatchObject({
    before: 800,
    quantity: 1600,
  });
  expect(result.positions[0]?.quantity).toBe(1000);
  expect(result.orders.at(-1)).toMatchObject({
    targetRemainingQuantity: 1000,
    status: "filled",
  });
});

it("rejects a half-sale of one board lot once and keeps all 100 shares", () => {
  const req = fixture([symbols[0]!], ["a"]);
  req.initial = 10000;
  const result = replayExitSignals(req, 1);
  expect(result.positions[0]?.quantity).toBe(100);
  expect(result.fills.map((f) => f.side)).toEqual(["buy"]);
  expect(result.orders.at(-1)).toMatchObject({
    status: "rejected",
    attempts: 1,
    reason: expect.stringContaining("不足最小交易数量"),
  });
});

it("finishes 30 shares above the scaled target after a 10% stock dividend", () => {
  const result = partialReplay(false, 0.1);
  expect(result.corporateActions[0]).toMatchObject({
    before: 800,
    quantity: 880,
  });
  expect(result.fills.map((f) => f.quantity)).toEqual([1000, 200, 300]);
  expect(result.positions[0]?.quantity).toBe(580);
  expect(result.orders.at(-1)).toMatchObject({
    status: "filled",
    targetRemainingQuantity: 550,
    attempts: 4,
  });
});

it("schedules a superseding close exit from its own signal under a one-bar delay", () => {
  const req = fixture([symbols[0]!], ["a"]);
  req.signalDelayBars = 1;
  const result = replayExitSignals(req, 2, 3);
  const sales = result.orders.filter((o) => o.side === "sell");
  expect(sales).toMatchObject([
    { signalAt: dates[2], due: dates[4], attempts: 0, status: "rejected" },
    { signalAt: dates[3], due: dates[5], attempts: 1, status: "filled" },
  ]);
  expect(result.fills.filter((f) => f.side === "sell")).toMatchObject([
    { date: dates[5], orderId: sales[1]!.id, quantity: 1000, holdingAfter: 0 },
  ]);
});

it("lets intraday stop protection preempt a future-due delayed full exit", () => {
  const req = fixture([symbols[0]!], ["a"]);
  req.signalDelayBars = 1;
  req.strategies = [
    {
      ...req.strategies[0]!,
      exit: {
        ...req.strategies[0]!.exit,
        stop: { kind: "fixed", fraction: 0.05 },
      },
    },
  ];
  const bar = req.instruments[0]!.bars[4]!;
  req.instruments = [
    {
      ...req.instruments[0]!,
      bars: req.instruments[0]!.bars.map((row, idx) =>
        idx === 4 ? { ...bar, low: 9.2, close: 9.3 } : { ...row, low: 9.8 },
      ),
      signalBars: req.instruments[0]!.signalBars.map((row, idx) =>
        idx === 4 ? { ...bar, low: 9.2, close: 9.3 } : { ...row, low: 9.8 },
      ),
    },
  ];
  const result = replayExitSignals(req, 2, 3);
  const sellFills = result.fills.filter((f) => f.side === "sell");
  expect(sellFills).toHaveLength(1);
  expect(sellFills[0]).toMatchObject({
    date: dates[4],
    quantity: 1000,
    holdingAfter: 0,
  });
});
