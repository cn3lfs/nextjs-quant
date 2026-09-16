import { expect, it } from "vitest";
import {
  sepaExitPresetIds,
  researchExitPresetTemplate,
  sepaExitDescription,
} from "../src/lib/research-exit-presets";
import { researchManagementSchema } from "../src/lib/research-management";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";
import { applyResearchManagement } from "../src/components/research-strategy-fields";
const setup = (kind: (typeof sepaExitPresetIds)[number]) => {
  const bars = Array.from({ length: 45 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    close: 100,
    high: 101,
    low: 99,
    volume: 1000,
    amount: 100000,
  }));
  const spec = researchSpecSchema.parse({
    strategy: "sepa-vcp-close",
    start: bars[0]!.date,
    end: bars[44]!.date,
    validationStart: bars[43]!.date,
    holdingDays: 60,
    initialCapital: 100000,
    maxPositions: 1,
    risk: { fraction: 0.1, maxWeight: 1 },
    management: researchExitPresetTemplate(
      researchManagementSchema.parse({}),
      kind,
    ),
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const rules = {
    evidence: "synthetic",
    tradable: true,
    limitUp: null,
    limitDown: null,
    minimumBuy: 100,
    buyStep: 100,
    maximumOrder: 100000,
    minimumSell: 100,
    sellStep: 100,
    maximumSell: 100000,
    sellOddLotAll: true,
  };
  const run = (blocked = "") =>
    researchPortfolio(
      spec,
      [
        {
          symbol: "sh600000",
          observedDate: bars[0]!.date,
          endpointDate: bars[0]!.date,
          key: "fixture",
          strategyVersion: "sepa-vcp-close-1",
          partition: "development",
          evidence: "synthetic confirmed entry",
          entryPriceRange: { min: 98, max: 102.9 },
        },
      ],
      bars.map((b) => b.date),
      new Map([["sh600000", bars]]),
      (_, date) => ({ ...rules, tradable: date !== blocked }),
    );
  return { bars, spec, run };
};
it.each(sepaExitPresetIds)(
  "preserves executable identity and exported rule: %s",
  (kind) => {
    const { spec } = setup(kind);
    expect(researchSpecSchema.safeParse(spec).success).toBe(true);
    expect(researchMethodSnapshot(spec).exitPreset).toMatchObject({
      kind,
      interpretation: sepaExitDescription,
    });
    expect(
      researchManagementSchema.safeParse({
        ...spec.management,
        stop: { kind: "percent", fraction: 0.05 },
      }).success,
    ).toBe(false);
    if (kind.startsWith("sepa-time4"))
      expect(
        applyResearchManagement(
          { ...spec, holdingDays: 5, management: undefined },
          spec.management!,
        ).holdingDays,
      ).toBe(60);
  },
);
it("MIN followed by the 10% cap produces the actual entry-relative stop", () => {
  const { run } = setup("sepa-min-cap10");
  const t = run().trades[0]!;
  expect(t.entryPrice).toBe(100);
  expect(t.initialStop).toBe(90);
  for (const pivot of [96, 98, 100])
    expect(Math.max(Math.min(pivot * 0.92, 100 * 0.9), 100 * 0.9)).toBe(90);
});
it("15% close raises only the subsequent stop and a gap can still lose money", () => {
  const { bars, run } = setup("sepa-be15");
  Object.assign(bars[2]!, { open: 110, high: 115, low: 99, close: 115 });
  Object.assign(bars[3]!, { open: 110, high: 111, low: 99, close: 100 });
  Object.assign(bars[4]!, { open: 95, high: 101, low: 94, close: 100 });
  const t = run().trades[0]!;
  expect(t.stopHistory).toContainEqual(
    expect.objectContaining({ date: bars[2]!.date, stop: 100 }),
  );
  expect(t.exitDate).toBe(bars[4]!.date);
  expect(t.exitPrice).toBe(95);
});
it.each(["sepa-time4-calendar", "sepa-time4-trading20"] as const)(
  "four weeks is checked once from actual entry: %s",
  (kind) => {
    const { bars, run } = setup(kind);
    const due = kind.endsWith("calendar") ? 29 : 20;
    let t = run().trades[0]!;
    expect(t.exitDate).toBe(bars[due + 1]!.date);
    Object.assign(bars[due]!, { open: 110, high: 111, low: 109, close: 110 });
    t = run().trades[0]!;
    expect(t.exitDate).toBeNull();
    Object.assign(bars[due]!, { open: 109, high: 110, low: 108, close: 109 });
    t = run(bars[due + 1]!.date).trades[0]!;
    expect(t.exitDate).toBe(bars[due + 2]!.date);
  },
);
