import { expect, it } from "vitest";
import { researchManagementSchema } from "../../src/lib/research/workflow/research-management";
import { researchInitialStop } from "trading-strategies/research/risk/research-initial-stop";
const dates = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"];
const management = researchManagementSchema.parse({
  stop: {
    kind: "max-distance",
    period: 14,
    multiple: 1.5,
    fraction: 0.05,
    structureBuffer: 0.3,
  },
  stopOverride: { symbol: "sh600000", observedDate: dates[0], price: 95 },
});
it("absolute stop override is scoped to its signal date and symbol", () => {
  for (const different of [
    { symbol: "sh600001", observedDate: dates[0]! },
    { symbol: "sh600000", observedDate: dates[1]! },
  ]) {
    expect(researchInitialStop(management, 100, different)).toBeNull();
    expect(
      researchInitialStop(management, 100, {
        ...different,
        initialStop: 95,
        stopAtr: 2,
      }),
    ).toBe(94.4);
  }
});
it("treats unprovided ATR differently from a selected but invalid ATR window", () => {
  const provided = researchManagementSchema.parse({
    stop: {
      kind: "structure-auto",
      atrPeriod: 14,
      atrMultiple: 0.3,
      percentBuffer: 0.005,
    },
  });
  const absent = researchManagementSchema.parse({
    stop: { kind: "structure-auto", atrMultiple: 0.3, percentBuffer: 0.005 },
  });
  expect(
    researchInitialStop(provided, 100, { initialStop: 95, stopAtr: 2 }),
  ).toBe(94.4);
  expect(researchInitialStop(absent, 100, { initialStop: 95 })).toBe(94.525);
  expect(
    researchInitialStop(absent, 100, { initialStop: 95, stopAtr: 200 }),
  ).toBe(94.525);
  for (const stopAtr of [undefined, null, 0, NaN, Infinity])
    expect(
      researchInitialStop(provided, 100, { initialStop: 95, stopAtr }),
    ).toBeNull();
  expect(researchInitialStop(absent, 100, {})).toBeNull();
  expect(researchInitialStop(absent, 90, { initialStop: 95 })).toBeNull();
});
