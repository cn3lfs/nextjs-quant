import { expect, it } from "vitest";
import type { Bar } from "../../src/lib/domain";
import { researchManagementSchema } from "../../src/lib/research/workflow/research-management";
import {
  researchRManagementTemplate,
  isResearchRManagementTemplate,
} from "trading-strategies/research/risk/research-r-management";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
import { researchMethodSnapshot } from "../../src/server/research/research-method";
import { atr, rollingHigh } from "../../src/lib/indicators";

const dates = Array.from(
  { length: 30 },
  (_, i) => `2024-01-${String(i + 1).padStart(2, "0")}`,
);
const management = researchRManagementTemplate(
  researchManagementSchema.parse({ stop: { kind: "percent", fraction: 0.1 } }),
);
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[20],
  end: dates[29],
  validationStart: dates[29],
  initialCapital: 100000,
  holdingDays: 60,
  risk: { fraction: 0.1, maxWeight: 1 },
  management,
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
function bars(): Bar[] {
  return dates.map((date, i) => {
    const open = i < 22 ? 100 : i === 22 ? 110 : 122;
    const close = i < 21 ? 100 : i === 21 ? 110 : i === 22 ? 120 : 122;
    return {
      date,
      open,
      close,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      volume: 10000,
      amount: 1000000,
    };
  });
}
it("calculates the rolling 22-day three-ATR tail from completed history", () => {
  const input = bars();
  const expected = rollingHigh(input, 22)[27]! - 3 * atr(input, 22)[27]!;
  expect(expected).toBeGreaterThan(110);
});
it("recognizes the named parameters, versions R-only behavior, and preserves independent limits", () => {
  const next = researchRManagementTemplate(
    researchManagementSchema.parse({
      ...management,
      liquidityCap: true,
      timeExit: { days: 10, minR: 0.5 },
    }),
  );
  expect(isResearchRManagementTemplate(next)).toBe(true);
  expect(next.liquidityCap).toBe(true);
  expect(next.timeExit).toEqual({ days: 10, minR: 0.5 });
  const edited = researchManagementSchema.parse({
    ...next,
    breakeven: { atR: 1.5, mode: "r-only" },
  });
  expect(isResearchRManagementTemplate(edited)).toBe(false);
  expect(researchMethodSnapshot({ ...spec, management: next })).toHaveProperty(
    "rManagement.version",
    "research-r-management-1",
  );
  expect(
    researchMethodSnapshot({ ...spec, management: edited }),
  ).not.toHaveProperty("rManagement");
  expect(
    researchMethodSnapshot({ ...spec, management: edited }),
  ).toHaveProperty("rBreakeven.version", "research-r-breakeven-1");
  const old = researchManagementSchema.parse({ breakeven: { atR: 1 } });
  expect(old.breakeven).toEqual({ atR: 1 });
  expect(
    researchMethodSnapshot({ ...spec, management: old }),
  ).not.toHaveProperty("rBreakeven");
  expect(
    researchManagementSchema.safeParse({
      ...management,
      breakeven: { atR: 0, mode: "r-only" },
    }).success,
  ).toBe(false);
});
