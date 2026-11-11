export type SwingExitPolicyInput = {
  confirmations: number;
  trail: { kind: string };
  scaleOut?: readonly {
    atR: number;
    fraction: number;
    raiseStopR: number | null;
  }[];
  breakeven?: unknown;
  trailAfterScaleOut?: boolean;
  exitPreset?: unknown;
};

export const swingExitVersion = "swing-exits-1";
/** Preserve the initial risk choice; remove competing moving lines explicitly. */
export function swingExitTemplate<T extends SwingExitPolicyInput>(
  value: T,
  priorTarget: boolean,
) {
  const {
    breakeven: _breakeven,
    trailAfterScaleOut: _after,
    exitPreset: _preset,
    ...rest
  } = value;
  return {
    ...rest,
    confirmations: 1 as const,
    trail: { kind: "fixed" as const },
    scaleOut: [
      { atR: 1, fraction: 1 / 3, raiseStopR: null },
      { atR: 2, fraction: 1 / 3, raiseStopR: priorTarget ? 1 : null },
    ],
  };
}

/** Recognize actual parameters, so editing a template never leaves a stale name. */
export function swingExitKind(value: SwingExitPolicyInput | undefined) {
  const rows = value?.scaleOut;
  if (
    !value ||
    value.confirmations !== 1 ||
    value.trail.kind !== "fixed" ||
    value.breakeven ||
    value.trailAfterScaleOut ||
    rows?.length !== 2 ||
    rows[0]!.atR !== 1 ||
    rows[1]!.atR !== 2 ||
    rows.some((row) => row.fraction !== 1 / 3) ||
    rows[0]!.raiseStopR !== null
  )
    return null;
  return rows[1]!.raiseStopR === 1
    ? "prior-target"
    : rows[1]!.raiseStopR === null
      ? "r1-r2"
      : null;
}
