import { expect, it } from "vitest";
import {
  riskParityWeights,
  riskParityMaximumCandidates,
} from "../src/portfolio-risk-parity.js";

const dates = Array.from({ length: 60 }, (_, i) =>
  new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
);
const asOf = dates.at(-1)!;
it("rejects oversized universes before covariance allocation while accepting the boundary", () => {
  const rows = Array.from(
    { length: riskParityMaximumCandidates + 1 },
    (_, i) => ({ symbol: `asset-${i}`, returns: [] }),
  );
  expect(() => riskParityWeights(rows, asOf)).toThrow("最多200");
  expect(
    riskParityWeights(rows.slice(0, riskParityMaximumCandidates), asOf)
      .excluded,
  ).toHaveLength(200);
});
const series = (symbol: string, values: (i: number) => number) => ({
  symbol,
  returns: dates.map((date, i) => ({ date, value: values(i) })),
});

it("diagonal covariance agrees with inverse-volatility analytical weights", () => {
  const result = riskParityWeights(
    [
      series("A", (i) => (i % 2 ? 0.01 : -0.01)),
      series("B", (i) => (i % 4 < 2 ? 0.02 : -0.02)),
    ],
    asOf,
  );
  expect(result.weights[0]!.weight).toBeCloseTo(2 / 3, 5);
  expect(result.weights[1]!.weight).toBeCloseTo(1 / 3, 5);
});

it("uses off-diagonal covariance and equalizes risk contributions", () => {
  const result = riskParityWeights(
    [
      series("A", (i) => (i % 2 ? 0.01 : -0.01)),
      series("B", (i) => (i % 2 ? 0.008 : -0.008) + (i % 4 < 2 ? 0.01 : -0.01)),
      series("C", (i) => (i % 4 < 2 ? 0.015 : -0.015)),
    ],
    asOf,
  );
  const w = result.weights.map((row) => row.weight),
    c = result.diagnostics!.covariance;
  const contributions = w.map(
    (weight, i) => weight * c[i]!.reduce((sum, v, j) => sum + v * w[j]!, 0),
  );
  const total = contributions.reduce((sum, v) => sum + v, 0);
  contributions.forEach((v) => expect(v / total).toBeCloseTo(1 / 3, 7));
  const inverse = c.map((row, i) => 1 / Math.sqrt(row[i]!));
  expect(
    w.some(
      (v, i) =>
        Math.abs(v - inverse[i]! / inverse.reduce((s, x) => s + x, 0)) > 0.01,
    ),
  ).toBe(true);
  expect(w.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 14);
});

it("handles duplicated assets with an explicit ridge and deterministic ordering", () => {
  const a = series("A", (i) => (i % 2 ? 0.01 : -0.01));
  const b = { ...a, symbol: "B" };
  expect(riskParityWeights([a, b], asOf)).toEqual(
    riskParityWeights([b, a], asOf),
  );
  expect(riskParityWeights([a, b], asOf).weights[0]!.weight).toBeCloseTo(
    0.5,
    7,
  );
});

it("excludes short and zero-variance histories, rejects future and misaligned input", () => {
  const a = series("A", (i) => (i % 2 ? 0.01 : -0.01));
  expect(
    riskParityWeights(
      [{ ...a, returns: a.returns.slice(1) }, series("B", () => 0)],
      asOf,
    ).excluded,
  ).toEqual(["A", "B"]);
  expect(() => riskParityWeights([a], dates.at(-2)!)).toThrow("日期");
  const shifted = a.returns.map((row, i) =>
    i === 0 ? { ...row, date: "2023-12-31" } : row,
  );
  expect(() =>
    riskParityWeights([a, { symbol: "B", returns: shifted }], asOf),
  ).toThrow("对齐");
  expect(() => riskParityWeights([a, a], asOf)).toThrow("重复");
});
