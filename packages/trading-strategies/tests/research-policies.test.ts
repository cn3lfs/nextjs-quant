import { expect, it } from "vitest";
import {
  swingRewardAdmission,
  swingDisciplineTemplate,
} from "../src/research/swing/research-swing-discipline.js";
import {
  swingExitTemplate,
  swingExitKind,
} from "../src/research/swing/research-swing-exits.js";
import {
  canslimRiskTemplate,
  canslimFixedExitPolicy,
} from "../src/research/canslim/research-canslim-management.js";

it("admits only finite fee-aware 2R quotes and never executes quotes into an account", () => {
  const input = {
    entry: 10,
    stop: 9,
    target: 12,
    quantity: 100,
    quote: {
      entryCost: (amount: number) => amount,
      sellProceeds: (quantity: number, price: number) => quantity * price,
    },
  };
  expect(swingRewardAdmission(input)).toMatchObject({ allow: true, ratio: 2 });
  expect(
    swingRewardAdmission({
      ...input,
      quote: { ...input.quote, entryCost: (amount: number) => amount + 5 },
    }).allow,
  ).toBe(false);
  expect(
    swingRewardAdmission({
      ...input,
      quote: { ...input.quote, sellProceeds: () => null },
    }).ratio,
  ).toBeNull();
  expect(
    swingRewardAdmission({
      ...input,
      quote: { ...input.quote, entryCost: () => NaN },
    }).ratio,
  ).toBeNull();
  expect(swingRewardAdmission({ ...input, stop: 10 })).toMatchObject({
    allow: false,
    ratio: null,
  });
});

it("preserves unrelated strategy configuration while replacing competing exit rules", () => {
  const old = {
    tag: "keep",
    confirmations: 2,
    trail: { kind: "atr" },
    exitPreset: "old",
    breakeven: { atR: 1 },
    trailAfterScaleOut: true,
  };
  const fixed = swingExitTemplate(old, true);
  expect(fixed.tag).toBe("keep");
  expect(fixed).not.toHaveProperty("breakeven");
  expect(fixed).not.toHaveProperty("exitPreset");
  expect(swingExitKind(fixed)).toBe("prior-target");
  expect(swingExitKind(swingExitTemplate(old, false))).toBe("r1-r2");
  expect(old.confirmations).toBe(2);
  expect(swingDisciplineTemplate("sw-stop3").stop).toEqual({
    kind: "percent",
    fraction: 0.03,
  });
});

it("composes the same CANSLIM fixed risk policy without importing application schemas", () => {
  const prior = { name: "existing", risk: { fraction: 1, maxWeight: 1 } };
  const result = canslimRiskTemplate(prior);
  expect(result.name).toBe("existing");
  expect(result.risk).toEqual({ fraction: 0.015, maxWeight: 0.25 });
  expect(result.management).toEqual(canslimFixedExitPolicy);
  expect(result.management.stop).toEqual({ kind: "percent", fraction: 0.08 });
  expect(prior.risk.fraction).toBe(1);
});
