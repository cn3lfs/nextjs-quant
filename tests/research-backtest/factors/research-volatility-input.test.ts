import { expect, it } from "vitest";
import {
  externalVolatilityPoint,
  type VolatilityInput,
} from "trading-strategies/research/factors/research-volatility-input";

const bars = Array.from({ length: 30 }, (_, i) => ({
  date: `2021-01-${String(i + 1).padStart(2, "0")}`,
  open: 100,
  high: 102,
  low: 98,
  close: 100,
  volume: 10000,
  amount: 1000000,
}));
const evidence = (date = "2021-01-20"): VolatilityInput => ({
  symbol: "sh600000",
  date,
  source: "fixed-input-only",
  version: "fixture-1",
  effectiveAt: `${date}T14:00:00+08:00`,
  availableAt: `${date}T14:00:00+08:00`,
  capturedAt: `${date}T14:00:00+08:00`,
  kase: {
    formulaReference: "synthetic evaluated correction; not official DevStop",
    window: 2,
    anchor: 100,
    warning: { sigma: 0, skewCorrection: 1 },
    levels: [
      { sigma: 1, skewCorrection: 2 },
      { sigma: 2, skewCorrection: 4 },
      { sigma: 3, skewCorrection: 8 },
    ],
    cumulativeFractions: [0.25, 0.5, 1],
  },
  beta: {
    value: 1,
    estimationWindow: 60,
    benchmark: "sh000300",
    windowEnd: date,
    price: 100,
    tableReference: "synthetic table; not original",
    table: [
      { betaMin: 0, betaMax: 1, priceMin: 0, priceMax: 200, distance: 5 },
      { betaMin: 1, betaMax: 2, priceMin: 0, priceMax: 200, distance: 8 },
    ],
  },
});
it("requires external parameters, provenance and all causal timestamps; no invented defaults", () => {
  expect(
    externalVolatilityPoint("rk-kase", bars, "sh600000", "2021-01-20"),
  ).toMatchObject({ status: "missing" });
  for (const field of ["effectiveAt", "availableAt", "capturedAt"] as const) {
    const e = evidence();
    e[field] = "2021-01-21T09:00:00+08:00";
    expect(
      externalVolatilityPoint("rk-kase", bars, e.symbol, e.date, [e]).status,
    ).toBe("missing");
  }
  const e = evidence();
  delete e.kase;
  expect(
    externalVolatilityPoint("rk-kase", bars, e.symbol, e.date, [e]).status,
  ).toBe("missing");
  expect(
    externalVolatilityPoint("rk-beta", bars, e.symbol, e.date, [e, e]).status,
  ).toBe("missing");
});
it("Kase applies supplied corrections to hand-calculated two-bar TR sample deviation", () => {
  const e = evidence();
  expect(
    externalVolatilityPoint("rk-kase", bars, e.symbol, e.date, [e]),
  ).toMatchObject({
    status: "available",
    stop: 92,
    warning: 99,
    levels: [98, 96, 92],
  });
  const varied = structuredClone(bars);
  varied[19]!.high = 106;
  // last two two-bar TRs are 4 and 8: sample STD=sqrt(8).
  const result = externalVolatilityPoint("rk-kase", varied, e.symbol, e.date, [
    e,
  ]);
  expect(result.status).toBe("available");
  if (result.status === "available")
    expect(result.stop).toBeCloseTo(92 - 3 * Math.sqrt(8));
  varied[19]!.volume = 0;
  expect(
    externalVolatilityPoint("rk-kase", varied, e.symbol, e.date, [e]).status,
  ).toBe("missing");
  expect(
    externalVolatilityPoint(
      "rk-kase",
      bars.filter((_, i) => i !== 18),
      e.symbol,
      e.date,
      [e],
      bars.map((b) => b.date),
    ).status,
  ).toBe("missing");
  e.kase!.levels[1].skewCorrection = 1;
  expect(
    externalVolatilityPoint("rk-kase", bars, e.symbol, e.date, [e]).status,
  ).toBe("missing");
});
it("Beta table uses left-closed right-open cells and refuses gaps/overlaps/future estimates", () => {
  const e = evidence();
  expect(
    externalVolatilityPoint("rk-beta", bars, e.symbol, e.date, [e]),
  ).toMatchObject({ status: "available", stop: 92 });
  e.beta!.value = 2;
  expect(
    externalVolatilityPoint("rk-beta", bars, e.symbol, e.date, [e]).status,
  ).toBe("missing");
  e.beta!.value = 1;
  e.beta!.table.push(e.beta!.table[1]!);
  expect(
    externalVolatilityPoint("rk-beta", bars, e.symbol, e.date, [e]).status,
  ).toBe("missing");
  e.beta!.table.pop();
  e.beta!.windowEnd = "2021-01-21";
  expect(
    externalVolatilityPoint("rk-beta", bars, e.symbol, e.date, [e]).status,
  ).toBe("missing");
});
