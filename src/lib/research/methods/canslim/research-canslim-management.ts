import type { ResearchSpec } from "../../strategy-research";
import { researchManagementSchema } from "../../workflow/research-management";
import { researchExitPresetTemplate } from "../../specs/research-exit-presets";

/** Explicit reusable risk scenario, not an inference from a report's BUY. */
export function canslimRiskTemplate(spec: ResearchSpec): ResearchSpec {
  return {
    ...spec,
    risk: { fraction: 0.015, maxWeight: 0.25 },
    management: researchExitPresetTemplate(
      researchManagementSchema.parse({}),
      "canslim-8-fixed",
    ),
  };
}
