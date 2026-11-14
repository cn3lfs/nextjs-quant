import { expect, it } from "vitest";
import { researchManagementSchema } from "../../../src/lib/research/workflow/research-management";
import { researchInitialStop } from "trading-strategies/research/risk/research-initial-stop";
import { researchSpecSchema } from "../../../src/lib/research/strategy-research";
import { researchMethodSnapshot } from "../../../src/server/research/research-method";
const management = researchManagementSchema.parse({
  stop: { kind: "structure-atr", period: 14, multiple: 0.3 },
});
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: "2024-01-01",
  end: "2024-12-31",
  validationStart: "2024-10-01",
  risk: { fraction: 0.01, maxWeight: 0.2 },
  management,
});
it("records the optional structure-distance rule version", () => {
  const dates = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"];
  const selected = researchSpecSchema.parse({
    ...spec,
    start: dates[0],
    end: dates[3],
    validationStart: dates[3],
    initialCapital: 1000000,
    management: {
      ...management,
      stop: { ...management.stop, maxDistanceAtr: 2 },
    },
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  expect(researchMethodSnapshot(selected)).toHaveProperty(
    "structureDistance.version",
    "research-structure-distance-1",
  );
  expect(researchMethodSnapshot(spec)).not.toHaveProperty("structureDistance");
});
it("subtracts signal ATR from the frozen structure rather than from the entry", () => {
  expect(
    researchInitialStop(management, 100, { initialStop: 95, stopAtr: 2 }),
  ).toBe(94.4);
  expect(
    researchInitialStop(management, 105, { initialStop: 95, stopAtr: 2 }),
  ).toBe(94.4);
  expect(
    researchInitialStop(management, 94, { initialStop: 95, stopAtr: 2 }),
  ).toBeNull();
  for (const evidence of [
    { initialStop: 95 },
    { stopAtr: 2 },
    { initialStop: 95, stopAtr: 0 },
    { initialStop: 95, stopAtr: NaN },
    { initialStop: 0.1, stopAtr: 2 },
  ])
    expect(researchInitialStop(management, 100, evidence)).toBeNull();
});
