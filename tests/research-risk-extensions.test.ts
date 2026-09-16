import { expect, it } from "vitest";
import {
  riskExtensionTemplate,
  riskExtensionSchema,
  evaluateRiskExtension,
} from "../src/lib/research-risk-extensions";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchMethodSnapshot } from "../src/server/research-method";
import { researchPortfolio } from "../src/server/research-portfolio";
it("protective put pays only intrinsic at expiry and includes premium and fees", () => {
  const v = evaluateRiskExtension(riskExtensionTemplate("protective-put"));
  expect(v).toMatchObject({
    extensionOnly: true,
    includedInSimulation: false,
    method: "RK-F-put",
  });
  expect(v.option).toMatchObject({
    netPremiumPerShare: 2,
    floorProfit: -710,
    ceilingProfit: null,
  });
  expect(v.option!.outcomes.map((r) => r.profit)).toEqual([
    -710, -710, -710, -210, 790, 2790,
  ]);
  expect(v.option!.outcomes[0]!.putPayoff).toBe(9500);
});
it("collar caps gains and is not called zero-cost when actual net premiums differ", () => {
  const original = riskExtensionTemplate("collar");
  if (original.kind !== "collar") throw new Error("fixture");
  expect(evaluateRiskExtension(original).option).toMatchObject({
    zeroNetPremium: true,
    floorProfit: -510,
    ceilingProfit: 990,
  });
  const v = evaluateRiskExtension({ ...original, callPremium: 1 });
  expect(v.option).toMatchObject({
    zeroNetPremium: false,
    netPremiumPerShare: 1,
    floorProfit: -610,
    ceilingProfit: 890,
  });
  expect(v.option!.outcomes.at(-1)!.profit).toBe(890);
  expect(
    riskExtensionSchema.safeParse({ ...original, shares: 101 }).success,
  ).toBe(false);
  expect(
    riskExtensionSchema.safeParse({ ...original, callStrike: 94 }).success,
  ).toBe(false);
  expect(
    riskExtensionSchema.safeParse({ ...original, expiry: "2026-02-30" })
      .success,
  ).toBe(false);
});
it("short script reflects upper stop and lower R targets without manufacturing borrow or cash trades", () => {
  const v = evaluateRiskExtension(riskExtensionTemplate("short-script"));
  expect(v.short).toMatchObject({
    stop: 105,
    quantity: 2000,
    distance: 5,
    budget: 10000,
    riskWithoutSlippage: 10000,
    riskWithSlippage: 10200,
    breakeven: 100,
    after2R: { reduceFraction: 0.5, stop: 95 },
    feesIncluded: false,
  });
  expect(v.short!.targets).toEqual([
    { r: 1, price: 95, reachable: true },
    { r: 2, price: 90, reachable: true },
    { r: 3, price: 85, reachable: true },
  ]);
  const input = riskExtensionTemplate("short-script");
  if (input.kind !== "short-script") throw new Error("fixture");
  expect(
    riskExtensionSchema.safeParse({ ...input, swingHigh: 90 }).success,
  ).toBe(false);
});
it.each(["protective-put", "collar", "short-script"] as const)(
  "%s is saved and snapshotted separately, never changes A-share portfolio",
  (kind) => {
    const base = researchSpecSchema.parse({
      strategy: "dual-breakout",
      start: "2021-01-01",
      end: "2021-01-05",
      validationStart: "2021-01-04",
    });
    const spec = researchSpecSchema.parse({
      ...base,
      riskExtension: riskExtensionTemplate(kind),
    });
    expect(researchMethodSnapshot(spec).riskExtension).toMatchObject({
      includedInSimulation: false,
      input: { kind },
    });
    const calendar = ["2021-01-01", "2021-01-04", "2021-01-05"];
    expect(
      researchPortfolio(spec, [], calendar, new Map(), () => null),
    ).toEqual(researchPortfolio(base, [], calendar, new Map(), () => null));
  },
);
