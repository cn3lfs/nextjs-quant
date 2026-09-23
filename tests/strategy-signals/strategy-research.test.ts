import { expect, it } from "vitest";
import {
  researchNavStatistics,
  researchSpecSchema,
  researchTradeStatistics,
} from "../../src/lib/research/strategy-research";

it("reports wins, flat trades and payoff ratio with explicit empty denominators", () => {
  const result = researchTradeStatistics([0.2, 0.1, -0.1, 0]);
  expect(result).toMatchObject({
    count: 4,
    wins: 2,
    losses: 1,
    flat: 1,
    winRate: 0.5,
  });
  expect(result.payoffRatio).toBeCloseTo(1.5);
  expect(result.expectancy).toBeCloseTo(0.05);
  expect(result.distribution.median).toBeCloseTo(0.05);
  expect(result.distribution.p25).toBeCloseTo(-0.025);
  expect(result.distribution.p75).toBeCloseTo(0.125);
  expect(researchTradeStatistics([]).distribution.minimum).toBeNull();
  expect(researchTradeStatistics([0.1]).payoffRatio).toBeNull();
  expect(researchTradeStatistics([]).winRate).toBeNull();
  expect(() => researchTradeStatistics([NaN])).toThrow();
});

it("computes drawdown and Sharpe from a capital NAV series rather than independent trades", () => {
  const result = researchNavStatistics(100, [110, 99], 0);
  expect(result.totalReturn).toBeCloseTo(-0.01);
  expect(result.maxDrawdown).toBeCloseTo(0.1);
  expect(result.sharpe).toBeCloseTo(0);
  expect(researchNavStatistics(100, [100, 100], 0).sharpe).toBeNull();
  expect(researchNavStatistics(100, [], 0).totalReturn).toBeNull();
  expect(() => researchNavStatistics(0, [100], 0)).toThrow();
});

it("requires an explicit held-out validation period and valid calendar dates", () => {
  const input = {
    strategy: "czsc",
    start: "2024-01-01",
    end: "2024-12-31",
    validationStart: "2024-10-01",
  };
  expect(researchSpecSchema.parse(input).holdingDays).toBe(5);
  expect(
    researchSpecSchema.safeParse({ ...input, validationStart: input.start })
      .success,
  ).toBe(false);
  expect(
    researchSpecSchema.safeParse({ ...input, start: "2024-02-30" }).success,
  ).toBe(false);
});
