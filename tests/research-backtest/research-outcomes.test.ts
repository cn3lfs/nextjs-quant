import { expect, it } from "vitest";
import { researchOutcomes } from "../../src/server/backtest/research-outcomes";
import type { ResearchEvent } from "../../src/lib/research/strategy-research";

const days = ["2024-01-02", "2024-01-03", "2024-01-04"];
const event: ResearchEvent = {
  symbol: "sh600000",
  observedDate: days[0]!,
  endpointDate: "2023-12-01",
  key: "signal",
  strategyVersion: "v1",
  partition: "validation",
  evidence: "{}",
};
const bars = days.map((date, i) => ({
  date,
  open: 10,
  high: 13,
  low: 9,
  close: 10 + i,
  volume: 100,
  amount: 1000,
}));

it("uses confirmation date rather than the historical endpoint for the observation window", () => {
  const result = researchOutcomes(
    [event],
    new Map([[event.symbol, bars]]),
    bars,
    days,
    2,
    days[2]!,
  )[0]!;
  expect(result).toMatchObject({
    status: "observed",
    entryDate: days[1],
    exitDate: days[2],
    excessReturn: 0,
  });
  expect(result.grossReturn).toBeCloseTo(0.2);
});

it("keeps immature, missing and benchmark-unavailable observations distinct", () => {
  const series = new Map([[event.symbol, bars]]);
  expect(
    researchOutcomes([event], series, bars, days, 2, days[1]!)[0],
  ).toMatchObject({ status: "pending", grossReturn: null });
  expect(
    researchOutcomes([event], new Map(), bars, days, 2, days[2]!)[0],
  ).toMatchObject({ status: "unavailable", grossReturn: null });
  expect(
    researchOutcomes([event], series, [], days, 2, days[2]!)[0],
  ).toMatchObject({
    status: "observed",
    benchmarkReturn: null,
    excessReturn: null,
  });
});
