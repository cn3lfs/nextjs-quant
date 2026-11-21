import { expect, it } from "vitest";
import type { Bar } from "../../src/lib/domain";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
import { researchManagementSchema } from "../../src/lib/research/workflow/research-management";
import { researchHigherLow } from "trading-strategies/research/risk/research-protection";
import { researchMethodSnapshot } from "../../src/server/research/research-method";

const date = (i: number) =>
  new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10);
function spec(start: number, end: number, management: unknown) {
  return researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: date(start),
    end: date(end),
    validationStart: date(end - 1),
    initialCapital: 40000,
    holdingDays: 60,
    maxPositions: 1,
    risk: { fraction: 0.04, maxWeight: 1 },
    management,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
}
function structureBars(): Bar[] {
  const input = Array.from({ length: 76 }, (_, i) => ({
    date: date(i),
    open: 110,
    close: 110,
    high: 111,
    low: 109,
    volume: 1000,
    amount: 110000,
  }));
  input[50]!.low = 95;
  Object.assign(input[61]!, { open: 100, close: 108, low: 99 });
  input[65]!.low = 105;
  Object.assign(input[69]!, { close: 99, low: 98 });
  Object.assign(input[70]!, { open: 90, close: 91, high: 92, low: 89 });
  return input;
}

it("higher lows are unavailable before right-side confirmation and cannot cross ambiguity or suspension", () => {
  const input = structureBars();
  expect(researchHigherLow(input.slice(0, 68), date(61), 100).status).toBe(
    "not-confirmed",
  );
  expect(researchHigherLow(input.slice(0, 69), date(61), 100)).toMatchObject({
    status: "confirmed",
    latest: { date: date(65), confirmedAt: date(68), price: 105 },
  });
  expect(researchHigherLow(input.slice(0, 59), date(61), 100).status).toBe(
    "unavailable",
  );
  const suspended = structuredClone(input);
  suspended[64]!.volume = 0;
  expect(researchHigherLow(suspended.slice(0, 69), date(61), 100).status).toBe(
    "not-confirmed",
  );
  const ambiguous = structuredClone(input);
  ambiguous[63]!.high = 500;
  ambiguous[63]!.low = 1;
  expect(researchHigherLow(ambiguous.slice(0, 69), date(61), 100).status).toBe(
    "not-confirmed",
  );
});

it("optional protections preserve old shapes and freeze their source version independently", () => {
  const old = spec(0, 7, {});
  expect(old.management).not.toHaveProperty("breakeven");
  expect(old.management).not.toHaveProperty("trailAfterScaleOut");
  expect(researchMethodSnapshot(old)).toEqual(
    researchMethodSnapshot(old.strategy, true),
  );
  const active = spec(0, 7, { breakeven: { atR: 1 } });
  const method = researchMethodSnapshot(active);
  expect(method.protection!.version).toBe("research-protection-1");
  expect(researchMethodSnapshot(active)).toEqual(method);
  expect(
    researchManagementSchema.safeParse({ trailAfterScaleOut: true }).success,
  ).toBe(false);
});
