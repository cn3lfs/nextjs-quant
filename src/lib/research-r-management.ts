import type { ResearchManagement } from "./research-management";

export const researchRManagementVersion = "research-r-management-1";

/** The script leaves the tail unspecified; methods.md supplies ATR(22) x 3. */
export function researchRManagementTemplate(
  value: ResearchManagement,
): ResearchManagement {
  const { exitPreset: _preset, ...rest } = value;
  return {
    ...rest,
    confirmations: 1,
    breakeven: { atR: 1, mode: "r-only" },
    scaleOut: [{ atR: 2, fraction: 0.5, raiseStopR: 1 }],
    trail: { kind: "rolling-chandelier", period: 22, multiple: 3 },
    trailAfterScaleOut: true,
  };
}

export function isResearchRManagementTemplate(
  value: ResearchManagement | undefined,
) {
  return (
    !!value &&
    value.confirmations === 1 &&
    value.breakeven?.mode === "r-only" &&
    value.breakeven.atR === 1 &&
    value.scaleOut?.length === 1 &&
    value.scaleOut[0]!.atR === 2 &&
    value.scaleOut[0]!.fraction === 0.5 &&
    value.scaleOut[0]!.raiseStopR === 1 &&
    value.trail.kind === "rolling-chandelier" &&
    value.trail.period === 22 &&
    value.trail.multiple === 3 &&
    value.trailAfterScaleOut === true
  );
}
