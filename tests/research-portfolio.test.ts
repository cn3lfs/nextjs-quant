import { expect, it } from "vitest";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import type { ResearchExecutionRules } from "../src/lib/research-execution";
const days = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"];
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: days[0],
  end: days[3],
  validationStart: days[2],
  initialCapital: 10000,
  maxPositions: 1,
  holdingDays: 1,
  costs: { slippageBps: 0 },
});
const event: ResearchEvent = {
  symbol: "sh600000",
  observedDate: days[0]!,
  endpointDate: days[0]!,
  key: "buy",
  strategyVersion: "v1",
  partition: "development",
  evidence: "{}",
};
const bars = days.map((date, index) => ({
  date,
  open: index >= 2 ? 12 : 10,
  close: 12,
  high: 13,
  low: 9,
  volume: 1000,
  amount: 12000,
}));
const rules: ResearchExecutionRules = {
  evidence: "sample",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 1000000,
  limitUp: null,
  limitDown: null,
  tradable: true,
};

it("buys after the signal, respects T+1 and reconciles net cash with all fees", () => {
  const result = researchPortfolio(
    spec,
    [event],
    days,
    new Map([[event.symbol, bars]]),
    () => rules,
  );
  expect(result.trades[0]).toMatchObject({
    entryDate: days[1],
    exitDate: days[2],
    quantity: 900,
    entryCost: 9005,
    holdingTradingDays: 1,
  });
  expect(result.trades[0]?.profit).toBeCloseTo(1784.6);
  expect(result.nav.at(-1)?.value).toBeCloseTo(11784.6);
  expect(result.nav.every((point) => point.cash >= 0)).toBe(true);
  expect(result.statistics.count).toBe(1);
  expect(result.openPositions).toBe(0);
});

it("retains blocked exits as open positions rather than fabricating closed losses", () => {
  const result = researchPortfolio(
    spec,
    [event],
    days,
    new Map([[event.symbol, bars]]),
    (_symbol, date) => ({ ...rules, tradable: date < days[2]! }),
  );
  expect(result.openPositions).toBe(1);
  expect(result.statistics.count).toBe(0);
  expect(
    result.attempts.filter((attempt) => attempt.side === "sell"),
  ).toHaveLength(2);
});

it("flags stale valuation and withholds Sharpe when held prices are missing", () => {
  const result = researchPortfolio(
    spec,
    [event],
    days,
    new Map([[event.symbol, bars.slice(0, 2)]]),
    () => rules,
  );
  expect(result.staleValuation).toBe(true);
  expect(result.navStatistics.sharpe).toBeNull();
  expect(result.statistics.count).toBe(0);
});
