import { expect, it } from "vitest";
import { researchManagementSchema } from "../../src/lib/research/workflow/research-management";
import {
  researchInitialStop,
  researchStopComparison,
} from "trading-strategies/research/risk/research-initial-stop";
const management = researchManagementSchema.parse({
  stop: {
    kind: "nearest-stop",
    fraction: 0.05,
    period: 14,
    multiple: 1.5,
    structureBuffer: 0.3,
  },
});
it("selects the nearest valid long stop, preserving all three source candidates", () => {
  const result = researchStopComparison(management.stop, 80, {
    initialStop: 76.5,
    stopAtr: 2.5,
  });
  expect(result).toEqual({
    candidates: [
      { kind: "percent", price: 76 },
      { kind: "atr", price: 76.25 },
      { kind: "structure", price: 75.75 },
    ],
    selected: 76.25,
  });
  expect(
    researchInitialStop(management, 80, { initialStop: 79, stopAtr: 1 }),
  ).toBe(78.7);
  expect(
    researchInitialStop(management, 80, { initialStop: 79, stopAtr: 10 }),
  ).toBe(76);
  const equal = researchManagementSchema.parse({
    stop: {
      kind: "nearest-stop",
      fraction: 0.05,
      period: 14,
      multiple: 2,
      structureBuffer: 0,
    },
  });
  expect(researchInitialStop(equal, 80, { initialStop: 76, stopAtr: 2 })).toBe(
    76,
  );
});
it("rejects any missing or invalid candidate instead of silently comparing a smaller set", () => {
  for (const evidence of [
    {},
    { initialStop: 76.5 },
    { stopAtr: 2.5 },
    { initialStop: 76.5, stopAtr: 0 },
    { initialStop: 76.5, stopAtr: NaN },
    { initialStop: 0.1, stopAtr: 2.5 },
    { initialStop: 81, stopAtr: 1 },
    { initialStop: 76.5, stopAtr: 100 },
  ])
    expect(researchInitialStop(management, 80, evidence)).toBeNull();
  for (const entry of [0, Infinity, NaN])
    expect(
      researchInitialStop(management, entry, {
        initialStop: 76.5,
        stopAtr: 2.5,
      }),
    ).toBeNull();
});
