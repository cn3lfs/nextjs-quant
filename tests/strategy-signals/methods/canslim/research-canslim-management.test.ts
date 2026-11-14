import { expect, it } from "vitest";
import { canslimRiskTemplate } from "trading-strategies/research/canslim/research-canslim-management";
import {
  canslimExitPresetIds,
  canslimExitDescription,
  researchExitPresetTemplate,
  clearStaleExitPreset,
} from "../../../../src/lib/research/specs/research-exit-presets";
import { researchManagementSchema } from "../../../../src/lib/research/workflow/research-management";
import { researchSpecSchema } from "../../../../src/lib/research/strategy-research";
import { researchMethodSnapshot } from "../../../../src/server/research/research-method";

it("resets unrelated controls, records source/configuration, and rejects stale percentage identities", () => {
  for (const kind of canslimExitPresetIds) {
    const spec = researchSpecSchema.parse(
      canslimRiskTemplate(
        researchSpecSchema.parse({
          strategy: "canslim-priority",
          start: "2024-03-02",
          end: "2024-03-24",
          validationStart: "2024-03-23",
        }),
      ),
    );
    spec.management = researchExitPresetTemplate(spec.management!, kind);
    expect(researchSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.risk).toEqual({ fraction: 0.015, maxWeight: 0.25 });
    expect(researchMethodSnapshot(spec)).toHaveProperty(
      "exitPreset.kind",
      kind,
    );
    expect(researchMethodSnapshot(spec)).toHaveProperty(
      "exitPreset.interpretation",
      canslimExitDescription,
    );
    expect(
      researchMethodSnapshot(spec).sources.some(
        (s) => s.path === "canslim-analyst/references/entry-exit-rules.md",
      ),
    ).toBe(true);
    const stale = {
      ...spec.management!,
      stop: { kind: "percent" as const, fraction: 0.05 },
    };
    expect(researchManagementSchema.safeParse(stale).success).toBe(false);
    expect(clearStaleExitPreset(stale)).not.toHaveProperty("exitPreset");
    const reset = canslimRiskTemplate({
      ...spec,
      management: researchManagementSchema.parse({
        kelly: {
          provenance: "manual-scenario",
          winRate: 0.5,
          payoff: 2,
          fraction: 0.5,
        },
      }),
    });
    expect(reset.management!.kelly).toBeUndefined();
  }
});
