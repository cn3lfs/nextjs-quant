import { expect, it } from "vitest";
import { researchLossPause } from "../src/lib/research-loss-pause";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchManagementSchema } from "../src/lib/research-management";

const dates = Array.from(
  { length: 8 },
  (_, i) => `2024-01-${String(i + 2).padStart(2, "0")}`,
);
const closed = (profit: number) => ({
  symbol: "sh600000",
  eventKey: "fixture",
  entryDate: dates[0]!,
  profit,
});

it("counts capped partial liquidations only when the whole position closes", () => {
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: dates[0],
    end: dates[7],
    validationStart: dates[7],
    initialCapital: 10000,
    maxPositions: 1,
    holdingDays: 1,
    risk: { fraction: 0.1, maxWeight: 0.3 },
    management: {
      lossPauseDays: 1,
      stop: { kind: "percent", fraction: 0.05 },
      scaleOut: [{ atR: 2, fraction: 1 / 3, raiseStopR: null }],
    },
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const event: ResearchEvent = {
    symbol: "sh600000",
    observedDate: dates[0]!,
    endpointDate: dates[0]!,
    strategyVersion: "fixture",
    key: "fixture",
    evidence: "{}",
    partition: "development",
  };
  const bars = dates.map((date, i) => {
    const price = i < 2 ? 10 : 9;
    return {
      date,
      open: price,
      close: price,
      high: price + 0.1,
      low: price - 0.1,
      volume: 10000,
      amount: 100000,
    };
  });
  const run = (end: number) =>
    researchPortfolio(
      { ...spec, end: dates[end]! },
      [event],
      dates.slice(0, end + 1),
      new Map([[event.symbol, bars.slice(0, end + 1)]]),
      () => ({
        evidence: "fixture",
        minimumBuy: 100,
        buyStep: 100,
        maximumOrder: 100000,
        minimumSell: 100,
        sellStep: 100,
        maximumSell: 100,
        sellOddLotAll: true,
        tradable: true,
        limitUp: null,
        limitDown: null,
      }),
    );
  expect(run(3).trades[0]!.profit).toBeNull();
  expect(run(3).lossPause!.records).toEqual([]);
  const finished = run(4);
  expect(finished.trades[0]!.profit).toBe(-300);
  expect(finished.lossPause!.records).toHaveLength(1);
  expect(finished.lossPause!.consecutiveLosses).toBe(1);
  expect(finished.lossPause!.paused).toBe(false);
});

it("accepts only the two explicit cooldown lengths without injecting a legacy default", () => {
  expect(researchManagementSchema.parse({})).not.toHaveProperty(
    "lossPauseDays",
  );
  for (const lossPauseDays of [0, 3, 1.5, NaN])
    expect(researchManagementSchema.safeParse({ lossPauseDays }).success).toBe(
      false,
    );
  for (const lossPauseDays of [1, 2])
    expect(
      researchManagementSchema.parse({ lossPauseDays }).lossPauseDays,
    ).toBe(lossPauseDays);
});

it.each([1, 2] as const)(
  "pauses the trigger day and next %i snapshot sessions",
  (rest) => {
    const state = researchLossPause(dates, rest);
    for (let i = 0; i < 3; i++) state.settle(2, closed(-1));
    expect(state.snapshot(2).records.map((r) => r.triggered)).toEqual([
      false,
      false,
      true,
    ]);
    expect(state.blocked(2)).toBe(true);
    expect(state.blocked(2 + rest)).toBe(true);
    expect(state.blocked(3 + rest)).toBe(false);
    state.settle(3, closed(1));
    expect(state.blocked(3)).toBe(true);
    expect(state.snapshot(3).consecutiveLosses).toBe(0);
  },
);

it("breaks the streak on breakeven, extends after another three losses, and isolates accounts", () => {
  const state = researchLossPause(dates, 2);
  for (const profit of [-1, -1, 0, -1, -1]) state.settle(2, closed(profit));
  expect(state.blocked(2)).toBe(false);
  state.settle(2, closed(-1));
  for (let i = 0; i < 3; i++) state.settle(3, closed(-1));
  expect(state.snapshot(3).pausedThrough).toBe(dates[5]);
  expect(researchLossPause(dates, 2).blocked(3)).toBe(false);
  expect(() => state.settle(2, closed(-1))).toThrow("时序");
  expect(() => state.settle(3, closed(NaN))).toThrow("无效");
});

it("keeps an unfinished cooldown without inventing dates beyond the snapshot", () => {
  const state = researchLossPause(dates, 2);
  for (let i = 0; i < 3; i++) state.settle(7, closed(-1));
  expect(state.snapshot(7)).toMatchObject({
    paused: true,
    remainingTradingDays: 2,
    pausedThrough: null,
    nextEligibleDate: null,
  });
});

function portfolio(rest?: 1 | 2, wait = 6, fees = false) {
  const symbols = ["sh600000", "sh600001", "sh600002", "sh600003"];
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: dates[0],
    end: dates[7],
    validationStart: dates[7],
    initialCapital: 100000,
    maxPositions: 5,
    holdingDays: 1,
    entryMaxWait: wait,
    risk: { fraction: 0.1, maxWeight: 0.2 },
    management: {
      stop: { kind: "percent", fraction: 0.5 },
      ...(rest ? { lossPauseDays: rest } : {}),
    },
    costs: {
      commissionBps: 0,
      minimumCommission: fees ? 5 : 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const events: ResearchEvent[] = symbols.map((symbol, i) => ({
    symbol,
    observedDate: dates[i === 3 ? 1 : 0]!,
    endpointDate: dates[0]!,
    strategyVersion: "fixture",
    key: symbol,
    evidence: "{}",
    partition: "development",
    initialStop: 5,
  }));
  const series = new Map(
    symbols.map((symbol) => [
      symbol,
      dates.map((date, i) => {
        const price = !fees && i >= 2 && symbol !== symbols[3] ? 9 : 10;
        return {
          date,
          open: price,
          close: price,
          high: price + 0.1,
          low: price - 0.1,
          volume: 100000,
          amount: 1000000,
        };
      }),
    ]),
  );
  return researchPortfolio(spec, events, dates, series, () => ({
    evidence: "fixture",
    minimumBuy: 100,
    buyStep: 100,
    maximumOrder: 100000,
    tradable: true,
    limitUp: null,
    limitDown: null,
  }));
}

it.each([1, 2] as const)(
  "uses actual closed trades before pending buys and resumes after %i days",
  (rest) => {
    const result = portfolio(rest);
    expect(result.trades.slice(0, 3).every((t) => t.profit! < 0)).toBe(true);
    expect(result.trades[3]!.entryDate).toBe(dates[3 + rest]);
    expect(result.lossPause!.records.filter((r) => r.triggered)).toHaveLength(
      1,
    );
    expect(
      result.attempts.filter((a) => a.reason.includes("冷静期")),
    ).toHaveLength(rest + 1);
  },
);

it("does not extend entry expiry, counts net fees, and preserves the disabled result shape", () => {
  expect(portfolio(2, 2).trades).toHaveLength(3);
  const fees = portfolio(1, 6, true);
  expect(fees.trades.slice(0, 3).map((t) => t.profit)).toEqual([-10, -10, -10]);
  expect(fees.trades[3]!.entryDate).toBe(dates[4]);
  const legacy = portfolio();
  expect(legacy).not.toHaveProperty("lossPause");
  expect(legacy.trades[3]!.entryDate).toBe(dates[2]);
});
