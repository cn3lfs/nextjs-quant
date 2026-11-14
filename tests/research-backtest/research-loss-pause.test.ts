import { expect, it } from "vitest";
import { researchLossPause } from "trading-strategies/research/risk/research-loss-pause";
import { researchManagementSchema } from "../../src/lib/research/workflow/research-management";

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
