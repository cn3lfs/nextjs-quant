import { expect, it } from "vitest";
import { researchRetracementStop } from "trading-strategies/research/technical/research-retracement";
import { researchManagementSchema } from "../../../src/lib/research/workflow/research-management";
import { researchMethodSnapshot } from "../../../src/server/research/research-method";
it("retains the specified fraction of peak profit rather than applying it to price", () => {
  expect(researchRetracementStop(100, 90, 119.99)).toBeNull();
  for (const [high, stop, giveback] of [
    [120, 114, 0.3],
    [130, 122.5, 0.25],
    [140, 132, 0.2],
    [170, 166.5, 0.05],
    [180, 176, 0.05],
  ])
    expect(researchRetracementStop(100, 90, high!)).toMatchObject({
      stop,
      giveback,
    });
  expect(researchRetracementStop(100, 100, 120)).toBeNull();
  expect(researchRetracementStop(100, 90, NaN)).toBeNull();
});
it("binds the optional retracement version without changing fixed management", () => {
  const management = researchManagementSchema.parse({
    trail: { kind: "retracement" },
  });
  expect(
    researchMethodSnapshot({ strategy: "dual-breakout", management }),
  ).toHaveProperty("retracement.version", "research-retracement-1");
  expect(
    researchMethodSnapshot({
      strategy: "dual-breakout",
      management: researchManagementSchema.parse({}),
    }),
  ).not.toHaveProperty("retracement");
});
