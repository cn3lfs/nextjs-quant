import { expect, it } from "vitest";
import {
  researchInitialStop,
  researchMaximumDistance,
  researchManagementSchema,
} from "../src/lib/research-management";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { selectResearchStrategy } from "../src/components/research-strategy-fields";
import { researchMethodSnapshot } from "../src/server/research-method";
const management = researchManagementSchema.parse({
  stop: {
    kind: "max-distance",
    fraction: 0.05,
    period: 14,
    multiple: 1.5,
    structureBuffer: 0.3,
  },
});
it("selects the farthest valid long stop, preserving all three source candidates", () => {
  const result = researchMaximumDistance(management.stop, 80, {
    initialStop: 76.5,
    stopAtr: 2.5,
  });
  expect(result).toEqual({
    candidates: [
      { kind: "percent", price: 76 },
      { kind: "atr", price: 76.25 },
      { kind: "structure", price: 75.75 },
    ],
    selected: 75.75,
  });
  expect(
    researchInitialStop(management, 80, { initialStop: 79, stopAtr: 1 }),
  ).toBe(76);
  expect(
    researchInitialStop(management, 80, { initialStop: 79, stopAtr: 10 }),
  ).toBe(65);
  const equal = researchManagementSchema.parse({
    stop: {
      kind: "max-distance",
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
it("versions the complete comparison and clears unsupported structure configuration", () => {
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: "2024-01-01",
    end: "2024-12-31",
    validationStart: "2024-10-01",
    risk: { fraction: 0.01, maxWeight: 0.2 },
    management,
  });
  expect(
    researchSpecSchema.safeParse({ ...spec, strategy: "ma-cross" }).success,
  ).toBe(false);
  expect(selectResearchStrategy(spec, "ma-cross").management!.stop).toEqual({
    kind: "percent",
    fraction: 0.05,
  });
  const method = researchMethodSnapshot(spec);
  expect(method).toHaveProperty(
    "maxDistance.version",
    "research-max-distance-1",
  );
  expect(
    method.sources.some(
      (s) => s.path === "stop-loss/scripts/stop_loss_calc.py",
    ),
  ).toBe(true);
  expect(
    researchMethodSnapshot({
      ...spec,
      management: researchManagementSchema.parse({}),
    }),
  ).not.toHaveProperty("maxDistance");
  expect(
    researchManagementSchema.safeParse({
      stop: { ...management.stop, multiple: 0 },
    }).success,
  ).toBe(false);
});
