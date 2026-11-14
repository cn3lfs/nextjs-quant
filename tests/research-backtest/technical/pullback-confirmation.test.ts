import { expect, it } from "vitest";
import { researchPullbackConfirmation } from "trading-strategies/research/technical/research-pullback";

const input = {
  bar: {
    date: "2024-01-03",
    open: 100,
    high: 101,
    low: 100,
    close: 100.1,
    volume: 1000,
    amount: 100100,
  },
  level: 100,
  age: 1,
  waitBars: 3,
  tolerance: 0.003,
  requireProfit: false,
  quantity: 100,
  cost: 10020,
  alreadyConfirmed: false,
};

it("confirms a completed retest inside the original breakout deadline", () => {
  expect(researchPullbackConfirmation(input)).toMatchObject({
    status: "confirmed",
    level: 100,
    date: "2024-01-03",
  });
  expect(researchPullbackConfirmation({ ...input, age: 3 }).status).toBe(
    "confirmed",
  );
  expect(researchPullbackConfirmation({ ...input, age: 4 }).status).toBe(
    "expired",
  );
  expect(researchPullbackConfirmation({ ...input, age: 0 }).status).toBe(
    "waiting",
  );
  expect(
    researchPullbackConfirmation({ ...input, alreadyConfirmed: true }).status,
  ).toBe("waiting");
});

it("cancels broken or unavailable evidence instead of accepting a retest", () => {
  for (const bar of [
    undefined,
    { ...input.bar, low: 99.99 },
    { ...input.bar, volume: 0 },
    { ...input.bar, high: 99 },
  ])
    expect(researchPullbackConfirmation({ ...input, bar }).status).toBe(
      "cancelled",
    );
  expect(
    researchPullbackConfirmation({
      ...input,
      bar: { ...input.bar, open: 100.5, low: 100.4, close: 100.6 },
    }).status,
  ).toBe("waiting");
});

it("applies profitable-only admission to the actual holding cost", () => {
  expect(
    researchPullbackConfirmation({ ...input, requireProfit: true }).status,
  ).toBe("waiting");
  expect(
    researchPullbackConfirmation({ ...input, requireProfit: true, cost: 10000 })
      .status,
  ).toBe("confirmed");
});
