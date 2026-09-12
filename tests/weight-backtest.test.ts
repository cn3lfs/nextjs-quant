import { expect, it, vi } from "vitest";
// The existing admission fixture imports a hash helper through dataset code.
// Prohibit all database access and networking, including accidental new paths.
vi.mock(
  "../src/server/db",
  () =>
    new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === "then") return undefined;
          throw new Error(`U7a must not access database: ${String(key)}`);
        },
      },
    ),
);
import { backtestCostsSchema } from "../src/lib/backtest-costs";
import {
  closeReturns,
  projectResearchWeights,
  weightBacktest,
} from "../src/lib/weight-backtest";
import { admissionResearchFixture } from "./strategy-admission-fixture";
import {
  absoluteSummary,
  compareProjection,
  projectionAnchor,
} from "./weight-equivalence-fixture";

const zero = backtestCostsSchema.parse({
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  slippageBps: 0,
});
const days = ["2024-01-02", "2024-01-03", "2024-01-04"];
const weights = days.flatMap((dt, i) => [
  { dt, symbol: "A", weight: [0.6, 0.2, 0][i]! },
  { dt, symbol: "B", weight: [0.4, 0.8, 1][i]! },
]);
const returns = days.flatMap((dt) => [
  { dt, symbol: "A", value: 0.1 },
  { dt, symbol: "B", value: -0.05 },
]);

it("matches two-symbol three-day hand calculations", () => {
  const actual = weightBacktest(days, weights, returns, {
    ...zero,
    commissionBps: 10,
  });
  // Day 1: 0 - 1*.001; day 2: .6*.1+.4*(-.05)-.8*.001;
  // day 3: .2*.1+.8*(-.05)-.4*.001. Full snapshots, initial cash.
  [-0.001, 0.0392, -0.0204].forEach((value, i) =>
    expect(actual[i]!.netReturn).toBeCloseTo(value, 12),
  );
  [1, 0.8, 0.4].forEach((value, i) =>
    expect(actual[i]!.turnover).toBeCloseTo(value, 12),
  );
});

it("today's weight jump cannot earn today's return; future edits preserve the prefix", () => {
  const changed = weights.map((row) =>
    row.dt === days[1] ? { ...row, weight: row.symbol === "A" ? 1 : 0 } : row,
  );
  const a = weightBacktest(days, weights, returns, zero),
    b = weightBacktest(days, changed, returns, zero);
  expect(a[1]!.netReturn).toBeCloseTo(0.04, 12);
  expect(b[1]!.netReturn).toBe(a[1]!.netReturn);
  expect(b[0]).toEqual(a[0]);
  expect(b[2]!.netReturn).toBeCloseTo(0.1, 12);
  const charged = weightBacktest(days, changed, returns, {
    ...zero,
    commissionBps: 10,
  });
  expect(charged[1]!.grossReturn).toBe(a[1]!.grossReturn);
  expect(charged[1]!.netReturn).toBeCloseTo(0.04 - 0.8 * 0.001, 12);
  const noRebalance = weightBacktest(
    days,
    weights.map((row) =>
      row.dt === days[1]
        ? { ...row, weight: row.symbol === "A" ? 0.6 : 0.4 }
        : row,
    ),
    returns,
    { ...zero, commissionBps: 10 },
  );
  expect(noRebalance[1]!.grossReturn).toBe(charged[1]!.grossReturn);
  expect(noRebalance[1]!.netReturn).toBeCloseTo(0.04, 12);
});

it("charges 2.0 turnover for a full switch, including both sides", () => {
  const result = weightBacktest(
    days.slice(0, 2),
    [
      { dt: days[0]!, symbol: "A", weight: 1 },
      { dt: days[1]!, symbol: "B", weight: 1 },
    ],
    returns.filter((row) => row.dt !== days[2]),
    { ...zero, commissionBps: 3 },
  );
  expect(result[1]!.turnover).toBe(2);
  expect(result[1]!.cost).toBeCloseTo(0.0006, 12);
});

it("propagates held missing returns and unknown weights, but cash needs no price", () => {
  const missing = returns.filter(
    (row) => !(row.dt === days[1] && row.symbol === "B"),
  );
  expect(weightBacktest(days, weights, missing, zero)[1]!.netReturn).toBeNull();
  expect(
    weightBacktest(days, [], [], zero).map((row) => row.netReturn),
  ).toEqual([0, 0, 0]);
  const unknown = weights.map((row) =>
    row.dt === days[0] && row.symbol === "A" ? { ...row, weight: null } : row,
  );
  expect(weightBacktest(days, unknown, returns, zero)[1]!.netReturn).toBeNull();
});

it("rejects duplicate, invalid and leveraged inputs", () => {
  expect(() =>
    weightBacktest(days, [...weights, weights[0]!], returns, zero),
  ).toThrow("重复权重");
  expect(() =>
    weightBacktest([...days].reverse(), weights, returns, zero),
  ).toThrow("日历");
  expect(() =>
    weightBacktest(
      days,
      [{ dt: days[0]!, symbol: "A", weight: NaN }],
      returns,
      zero,
    ),
  ).toThrow("权重");
  expect(() =>
    weightBacktest(
      days,
      weights.map((row) => ({ ...row, weight: 0.8 })),
      returns,
      zero,
    ),
  ).toThrow("超过一");
});

it("passes the nonzero-return projection round trip, including entry, exit and cash", () => {
  const fixture = projectionAnchor();
  const result = compareProjection(
    fixture.spec,
    fixture.simulation,
    fixture.series,
  );
  expect(fixture.simulation.unfilled).toEqual([]);
  expect(fixture.simulation.excluded).toEqual([]);
  expect(fixture.simulation.trades).toHaveLength(1);
  expect(fixture.simulation.openPositions).toBe(0);
  expect(result.projection.unavailable).toEqual([]);
  expect(result.projection.rows.map((row) => row.weight)).toEqual([
    0,
    0.5,
    5500 / 10500,
    6000 / 11000,
    0,
  ]);
  // NAV: 10000,10000,10500,11000,11000; cash remains 5000 until sale.
  [0, 0, 0.05, 500 / 10500, 0].forEach((value, i) =>
    expect(result.daily[i]!.netReturn).toBeCloseTo(value, 12),
  );
  expect(result.difference.maxAbs).toBeLessThan(1e-12);
});

it("exposes an ordinary no-exclusion round-trip failure instead of adjusting weights", () => {
  const fixture = projectionAnchor(true);
  const result = compareProjection(
    fixture.spec,
    fixture.simulation,
    fixture.series,
  );
  expect(fixture.simulation.unfilled).toEqual([]);
  expect(fixture.simulation.excluded).toEqual([]);
  expect(result.daily[1]!.actual).toBeCloseTo(0.05, 12);
  expect(result.daily[1]!.netReturn).toBe(0);
  expect(result.difference.maxAbs).toBeCloseTo(0.05, 12);
  expect(result.unexplained.maxAbs).toBeLessThan(1e-12);
});

it("does not use final marks or bridge missing/duplicate historical prices", () => {
  const { simulation, series } = projectionAnchor();
  const symbol = "sh600000",
    bars = series.get(symbol)!;
  const missing = new Map([[symbol, bars.filter((_row, i) => i !== 2)]]);
  expect(projectResearchWeights(simulation, missing).unavailable).toHaveLength(
    1,
  );
  const values = closeReturns(
    bars.map((bar) => bar.date),
    missing,
  );
  expect(values[2]!.value).toBeNull();
  expect(values[3]!.value).toBeNull();
  const duplicate = new Map([[symbol, [...bars, bars[2]!]]]);
  expect(
    projectResearchWeights(simulation, duplicate).rows[2]!.weight,
  ).toBeNull();
});

it("replays the unchanged E3 admission fixture and prints reproducible attribution", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("U7a must not use network");
  });
  try {
    const { dataset, result } = await admissionResearchFixture();
    const series = new Map(
      dataset.stocks.map((stock) => [stock.symbol, stock.bars]),
    );
    const partitions = result.partitions.map((partition) => {
      const simulation = partition.simulation!;
      const comparison = compareProjection(result.spec, simulation, series);
      expect(comparison.projection.unavailable).toEqual([]);
      expect(comparison.unexplained.maxAbs).toBeLessThan(1e-12);
      return {
        partition: partition.partition,
        counts: {
          days: simulation.nav.length,
          trades: simulation.trades.length,
          attempts: simulation.attempts.length,
          excluded: simulation.excluded.length,
          unfilled: simulation.unfilled.length,
          openPositions: simulation.openPositions,
          staleValuation: simulation.staleValuation,
        },
        ...comparison,
      };
    });
    const daily = partitions.flatMap((partition) => partition.daily);
    expect(partitions.map((partition) => partition.counts)).toEqual([
      {
        days: 8,
        trades: 1,
        attempts: 0,
        excluded: 0,
        unfilled: 0,
        openPositions: 0,
        staleValuation: false,
      },
      {
        days: 4,
        trades: 0,
        attempts: 0,
        excluded: 0,
        unfilled: 0,
        openPositions: 0,
        staleValuation: false,
      },
    ]);
    const entry = daily.find((row) => row.dt === "2025-03-10")!;
    // 600 shares * 0.10 entry-day rise / 100000 capital is absent in lagged weights.
    expect(entry.sevenSourceResidual).toBeCloseTo(-0.0006, 12);
    const held = daily.find((row) => row.dt === "2025-03-11")!;
    // No fills on this day: changed marked weights still incur formula turnover.
    expect(held.fees).toBeCloseTo(-0.00000014875236319948637, 15);
    const summaries = Object.fromEntries(
      (
        [
          "difference",
          "fees",
          "timing",
          "sevenSourceResidual",
          "unexplained",
        ] as const
      ).map((key) => [
        key,
        absoluteSummary(
          daily.flatMap((row) => (row[key] === null ? [] : [row[key]])),
        ),
      ]),
    );
    console.log(
      "U7A_EVIDENCE",
      JSON.stringify({
        datasetHash: dataset.hash,
        spec: result.spec,
        partitions,
        summaries,
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});
