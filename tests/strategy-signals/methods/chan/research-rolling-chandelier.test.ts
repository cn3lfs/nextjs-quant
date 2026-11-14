import { expect, it } from "vitest";
import { rollingHigh } from "../../../../src/lib/indicators";
import { researchSpecSchema } from "../../../../src/lib/research/strategy-research";
import { researchMethodSnapshot } from "../../../../src/server/research/research-method";
const dates = Array.from(
  { length: 7 },
  (_, i) => `2024-01-${String(i + 2).padStart(2, "0")}`,
);
const bars = [110, 105, 104, 103, 102, 101, 100].map((high, i) => ({
  date: dates[i]!,
  open: 100,
  close: 100,
  high,
  low: 99,
  volume: 10000,
  amount: 1000000,
}));
it("uses only complete windows and drops the old peak without forward access", () => {
  expect(rollingHigh(bars, 3)).toEqual([null, null, 110, 105, 104, 103, 102]);
  expect(rollingHigh(bars.slice(0, 4), 3)).toEqual(
    rollingHigh(bars, 3).slice(0, 4),
  );
  expect(
    rollingHigh(
      bars.map((b, i) => (i === 2 ? { ...b, volume: 0 } : b)),
      3,
    ).slice(2, 5),
  ).toEqual([null, null, null]);
  expect(() => rollingHigh(bars, 0)).toThrow();
});
it("calculates the rolling high and records the distinct chandelier version", () => {
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: dates[0],
    end: dates[6],
    validationStart: dates[6],
    initialCapital: 100000,
    holdingDays: 60,
    risk: { fraction: 0.05, maxWeight: 0.5 },
    management: {
      stop: { kind: "percent", fraction: 0.2 },
      trail: { kind: "rolling-chandelier", period: 3, multiple: 1 },
    },
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const input = bars.map((b, i) => ({
    ...b,
    open: 120,
    close: 120,
    high: i === 3 ? 150 : 130,
    low: 90,
  }));
  expect(rollingHigh(input, 3)[6]).toBe(130);
  const legacy = researchSpecSchema.parse({
    ...spec,
    management: {
      ...spec.management,
      trail: { kind: "chandelier", period: 3, multiple: 1 },
    },
  });
  expect(researchMethodSnapshot(legacy)).not.toHaveProperty(
    "rollingChandelier",
  );
  expect(researchMethodSnapshot(spec)).toHaveProperty(
    "rollingChandelier.version",
    "research-rolling-chandelier-1",
  );
});
