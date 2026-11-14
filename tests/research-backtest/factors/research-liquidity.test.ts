import { expect, it } from "vitest";
import type { Bar } from "../../../src/lib/domain";
import { researchLiquidity } from "trading-strategies/research/factors/research-liquidity";
import { researchSpecSchema } from "../../../src/lib/research/strategy-research";
import { researchMethodSnapshot } from "../../../src/server/research/research-method";

const dates = Array.from(
  { length: 28 },
  (_, i) => `2024-01-${String(i + 1).padStart(2, "0")}`,
);
const bars = (): Bar[] =>
  dates.map((date) => ({
    date,
    open: 10,
    close: 10,
    high: 11,
    low: 9,
    volume: 100000,
    amount: 1000000,
  }));
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[19],
  end: dates[27],
  validationStart: dates[26],
  initialCapital: 100000,
  holdingDays: 60,
  risk: { fraction: 0.1, maxWeight: 1 },
  management: { stop: { kind: "percent", fraction: 0.1 }, liquidityCap: true },
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
it("uses exactly twenty prior snapshot days in yuan, excluding current and future turnover", () => {
  const input = bars();
  const result = researchLiquidity(input, dates, dates[20]!);
  expect(result).toMatchObject({
    meanAmount: 1000000,
    maxPositionValue: 10000,
    amountUnit: "yuan",
    observedDate: dates[19],
    windowStart: dates[0],
  });
  input[20]!.amount = 1e12;
  input[27]!.amount = Number.NaN;
  expect(researchLiquidity(input, dates, dates[20]!)).toEqual(result);
  expect(
    researchLiquidity(input, dates, dates[19]!).maxPositionValue,
  ).toBeNull();
});
it("refuses incomplete, suspended, nonfinite and overflowing windows", () => {
  for (const amount of [0, -1, Number.NaN, Infinity]) {
    const input = bars();
    input[2]!.amount = amount;
    expect(
      researchLiquidity(input, dates, dates[20]!).maxPositionValue,
    ).toBeNull();
  }
  const input = bars();
  input[2]!.volume = 0;
  expect(
    researchLiquidity(input, dates, dates[20]!).maxPositionValue,
  ).toBeNull();
  expect(
    researchLiquidity(
      bars().filter((_, i) => i !== 2),
      dates,
      dates[20]!,
    ).maxPositionValue,
  ).toBeNull();
  expect(
    researchLiquidity(
      bars().map((b) => ({ ...b, amount: Number.MAX_VALUE })),
      dates,
      dates[20]!,
    ).maxPositionValue,
  ).toBeNull();
});
it("records liquidity-cap provenance only when configured", () => {
  const { liquidityCap: _cap, ...management } = spec.management!;
  const legacy = researchSpecSchema.parse({ ...spec, management });
  expect(researchMethodSnapshot(legacy)).not.toHaveProperty("liquidityCap");
  expect(researchMethodSnapshot(spec)).toHaveProperty(
    "liquidityCap.version",
    "research-liquidity-1",
  );
  expect(
    researchMethodSnapshot(spec).sources.some(
      (s) => s.path === "stop-loss/references/position-sizing.md",
    ),
  ).toBe(true);
});
