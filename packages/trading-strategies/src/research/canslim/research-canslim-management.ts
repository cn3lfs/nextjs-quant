/** CANSLIM fixed-stop risk scenario; composition preserves the caller's remaining spec. */
export const canslimFixedExitPolicy = {
  exitPreset: "canslim-8-fixed",
  stop: { kind: "percent", fraction: 0.08 },
  confirmations: 1,
  stressBuffer: 0,
  trail: { kind: "fixed" },
  timeExit: null,
} as const;

export function canslimRiskTemplate<T extends object>(spec: T) {
  return {
    ...spec,
    risk: { fraction: 0.015, maxWeight: 0.25 },
    management: canslimFixedExitPolicy,
  };
}
