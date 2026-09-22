import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import { researchLiquidity } from "../src/lib/research-liquidity";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research/research-method";

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
const event: ResearchEvent = {
  symbol: "sh600000",
  observedDate: dates[19]!,
  endpointDate: dates[19]!,
  strategyVersion: "fixture",
  key: "fixture",
  evidence: "{}",
  partition: "development",
};
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
  tradable: true,
  limitUp: null,
  limitDown: null,
};
function run(input = bars(), config = spec) {
  return researchPortfolio(
    config,
    [event],
    dates,
    new Map([[event.symbol, input]]),
    () => rules,
  );
}
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
it("caps the real first order and preserves uncapped legacy configuration and snapshot", () => {
  const result = run();
  expect(result.trades[0]!.quantity).toBe(1000);
  expect(result.liquidityChecks).toHaveLength(1);
  const { liquidityCap: _cap, ...management } = spec.management!;
  const legacy = researchSpecSchema.parse({ ...spec, management });
  expect(run(bars(), legacy).trades[0]!.quantity).toBe(10000);
  expect(run(bars(), legacy)).not.toHaveProperty("liquidityChecks");
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
it("missing capacity blocks entry but never blocks an already confirmed stop exit", () => {
  const missing = bars();
  missing[19]!.amount = 0;
  const denied = run(missing);
  expect(denied.trades).toHaveLength(0);
  expect(
    denied.attempts.some((a) => a.reason.includes("容量约束暂停买入")),
  ).toBe(true);
  const input = bars();
  input[21] = { ...input[21]!, open: 10, close: 8, low: 7, amount: 0 };
  input[22] = { ...input[22]!, open: 8, close: 8, low: 7, amount: 0 };
  const result = run(input);
  expect(result.trades[0]!.exitDate).toBe(dates[22]);
  expect(result.trades[0]!.exitPrice).toBe(8);
});

it("counts the entire marked holding against capacity when pyramiding and does not liquidate on a lower cap", () => {
  const input = bars();
  input[20] = { ...input[20]!, close: 11, high: 12 };
  input[21] = { ...input[21]!, open: 11, close: 12, high: 13, low: 10 };
  for (let i = 22; i < input.length; i++) {
    input[i] = {
      ...input[i]!,
      open: 12,
      close: 12,
      high: 13,
      low: 11,
      amount: 1,
    };
  }
  const config = researchSpecSchema.parse({
    ...spec,
    management: {
      ...spec.management,
      pyramid: { kind: "r-50-30-20", maxTotalWeight: 1 },
    },
  });
  const result = run(input, config);
  const trade = result.trades[0]!;
  expect(trade.entries!.map((e) => e.quantity)).toEqual([500, 300]);
  expect(trade.exitDate).toBeNull();
  expect(trade.remainingQuantity).toBe(800);
  expect(result.liquidityChecks!.some((c) => c.maxPositionValue! < 9600)).toBe(
    true,
  );
});
