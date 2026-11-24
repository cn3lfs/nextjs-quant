import { expect, it } from "vitest";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { evaluatePerformance } from "quant-performance";
import { computeSleeveAttribution } from "~/server/research/diagnose/sleeve-attribution";

function request(length: number, rebalance = false) {
  const dates = Array.from({ length }, (_, i) =>
    new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
  );
  const ids = ["a", "b", "hedge", "cash"];
  const initial = 400000;
  const req: PortfolioRequest = {
    market: "cn-equity",
    start: dates[0]!,
    end: dates.at(-1)!,
    calendar: dates,
    initial,
    costs: {
      version: "cost-experiment-1",
      minimumCommission: 0,
      commissionBps: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
    sleeves: ids.map((id) => ({
      id,
      share: 0.25,
      riskPerTrade: 1,
      maxPositions: 1,
    })),
    strategies: ids.map((id, i) => ({
      id,
      sleeve: id,
      market: "cn-equity",
      version: 1,
      period: "day",
      universe: { kind: "symbols", symbols: [`sh60000${i}`] },
      entry: { kind: "constant", value: id !== "cash" },
      exit: { rule: { kind: "constant", value: false } },
      sizing: { kind: "weight", weight: 0.5 },
    })),
    instruments: ids.map((id, i) => {
      const bars = dates.map((date, j) => {
        const change = j < 10 ? j : 10 - (j - 10) * 0.7;
        const close = 50 + (id === "hedge" ? -0.4 : 1) * change;
        return {
          date,
          open: close,
          close,
          low: close - 1,
          high: close + 1,
          volume: 100000,
          amount: 1e7,
        };
      });
      return {
        symbol: `sh60000${i}`,
        market: "cn-equity",
        bars,
        signalBars: bars,
        execution: {
          tradable: true,
          evidence: "fixture",
          limitUp: null,
          limitDown: null,
          minimum: 100,
          step: 100,
        },
      };
    }),
    ...(rebalance && { rebalance: { everyBars: 17 } }),
  };
  return req;
}

const replay = (length: number, rebalance = false) =>
  runPortfolio(request(length, rebalance));

it("includes first-open losses and opening-day transfers in the official daily drawdown", () => {
  const req = request(6);
  const seed = req.calendar[4]!,
    first = req.calendar[5]!;
  req.start = first;
  req.strategies = req.strategies.slice(0, 1).map((s) => ({
    ...s,
    rank: { kind: "rps-composite", periods: [20] },
    rebalance: {
      kind: "ranked-weekly",
      top: 1,
      retentionMultiple: 1.5,
      weighting: "equal",
    },
  }));
  req.bookSeeds = [{ strategyId: "a", date: seed, availableAt: seed }];
  req.rebalance = { everyBars: 1 };
  req.instruments = req.instruments.slice(0, 1).map((ins) => {
    const bars = ins.bars.map((b) =>
      b.date === first ? { ...b, open: 60, high: 61, close: 50, low: 49 } : b,
    );
    return {
      ...ins,
      bars,
      signalBars: bars,
      external: {
        rps: [
          {
            date: seed,
            periods: [20],
            values: [{ return: 0.1, rank: 1, rps: 90 }],
          },
        ],
      },
    };
  });
  const result = runPortfolio(req);
  expect(result.fills[0]).toMatchObject({
    date: first,
    side: "buy",
    price: 60,
  });
  expect(result.transfers.some((t) => t.date === first && t.amount > 0)).toBe(
    true,
  );
  const official = evaluatePerformance(
    req.initial,
    result.equity.map((p) => ({ date: p.date, value: p.equity })),
  );
  const attribution = computeSleeveAttribution(result);
  expect(official.maxDrawdown.value).toBeGreaterThan(0);
  expect(attribution.peakEquity).toBe(req.initial);
  expect(attribution.sleeves.map((s) => s.initialEquity)).toEqual([
    100000, 100000, 100000, 100000,
  ]);
  expect(
    Math.abs(attribution.contributionSum - official.maxDrawdown.value!),
  ).toBeLessThan(1e-12);
});

it("measures all six daily correlations and attributes the observed portfolio peak-to-trough loss including the profitable hedge", () => {
  const result = replay(40),
    attribution = computeSleeveAttribution(result);
  expect(attribution.correlations).toHaveLength(6);
  expect(
    attribution.correlations.find(
      (pair) => pair.left === "a" && pair.right === "b",
    )?.correlation,
  ).toBeCloseTo(1, 12);
  expect(
    attribution.correlations.find(
      (pair) => pair.left === "a" && pair.right === "hedge",
    )?.correlation,
  ).toBeLessThan(-0.9);
  for (const p of attribution.correlations.filter((pair) =>
    [pair.left, pair.right].includes("cash"),
  ))
    expect(p).toMatchObject({
      overlap: 39,
      correlation: null,
      reason: "分仓日收益零方差",
    });
  expect(attribution.peakDate).toBe(result.curve[10]!.date);
  expect(attribution.troughDate).toBe(result.curve[39]!.date);
  expect(
    attribution.sleeves.find((s) => s.id === "hedge")!.drawdownContribution,
  ).toBeLessThan(0);
  const peak = result.curve[10]!,
    trough = result.curve.at(-1)!;
  const maximum = (peak.equity - trough.equity) / peak.equity;
  expect(attribution.contributionSum).toBeCloseTo(maximum, 12);
  for (const s of attribution.sleeves) {
    const valueAt = (row: typeof peak) =>
      row.sleeves.find((v) => v.id === s.id)!.equity;
    expect(s.drawdownContribution).toBe(
      (valueAt(peak) - valueAt(trough)) / peak.equity,
    );
    expect(s.trades).toBe(result.fills.filter((f) => f.sleeve === s.id).length);
    expect(s.return).toBe(valueAt(trough) / 100000 - 1);
    expect(s.averageWeight).toBeCloseTo(
      result.curve.reduce((n, p) => n + valueAt(p) / p.equity, 0) / 40,
      12,
    );
  }
});

it("requires 20 overlapping daily returns, then checks variance independently", () => {
  const short = computeSleeveAttribution(replay(20));
  expect(
    short.correlations.every(
      (p) =>
        p.overlap === 19 &&
        p.correlation === null &&
        p.reason === "重叠有效交易日不足 20 天",
    ),
  ).toBe(true);
  expect(computeSleeveAttribution(replay(21)).correlations[0]).toMatchObject({
    overlap: 20,
    correlation: 1,
  });
});

it("reconciles signed equity contributions through internal cash transfers", () => {
  const result = replay(40, true);
  const attribution = computeSleeveAttribution(result);
  expect(
    result.transfers.some(
      (t) =>
        t.date > attribution.peakDate &&
        t.date <= attribution.troughDate &&
        t.amount > 0,
    ),
  ).toBe(true);
  expect(
    Math.abs(attribution.contributionSum - attribution.maxDrawdown),
  ).toBeLessThan(1e-12);
  expect(attribution.transferBasis).toContain("内部现金划转");
});
