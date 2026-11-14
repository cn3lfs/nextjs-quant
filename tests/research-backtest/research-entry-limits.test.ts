import { expect, it } from "vitest";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
const dates = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"];
const base = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[0],
  end: dates[3],
  validationStart: dates[3],
  initialCapital: 100000,
  maxPositions: 5,
  holdingDays: 60,
  risk: { fraction: 0.1, maxWeight: 1 },
  management: { stop: { kind: "percent", fraction: 0.03 } },
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
it("omitted entry limits do not invent a total-weight cap", () => {
  expect(base.management).not.toHaveProperty("maxTotalWeight");
});
