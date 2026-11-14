import { expect, it, vi } from "vitest";
// Weight projection is pure; prohibit database access through new dependencies.
vi.mock(
  "../../../src/server/db/index",
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
import { backtestCostsSchema } from "../../../src/lib/backtest/backtest-costs";
import { weightBacktest } from "../../../src/lib/backtest/weight-backtest";

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
