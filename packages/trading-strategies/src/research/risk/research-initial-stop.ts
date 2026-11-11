import type {
  InitialStopPolicy,
  InitialStopManagementPolicy,
} from "../contracts/initial-stop.js";
import {
  riskPresetInitialStop,
  riskPresetEvolution,
} from "./research-risk-presets.js";
import {
  isGrowthPivotStop,
  researchGrowthPivotStop,
} from "../factors/research-growth-stops.js";
export function researchStopOverride(
  management: InitialStopManagementPolicy | undefined,
  evidence: { symbol?: string; observedDate?: string },
) {
  const override = management?.stopOverride;
  return override &&
    override.symbol === evidence.symbol &&
    override.observedDate === evidence.observedDate
    ? override
    : null;
}

export function researchStopComparison(
  stop: InitialStopPolicy,
  entry: number,
  evidence: { initialStop?: number | null; stopAtr?: number | null },
) {
  if (stop.kind !== "max-distance" && stop.kind !== "nearest-stop") return null;
  const { initialStop: structure, stopAtr: atr } = evidence;
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    structure == null ||
    !Number.isFinite(structure) ||
    structure <= 0 ||
    atr == null ||
    !Number.isFinite(atr) ||
    atr <= 0
  )
    return null;
  const candidates = [
    { kind: "percent" as const, price: entry * (1 - stop.fraction) },
    { kind: "atr" as const, price: entry - stop.multiple * atr },
    {
      kind: "structure" as const,
      price: structure - stop.structureBuffer * atr,
    },
  ];
  if (
    candidates.some(
      (c) => !Number.isFinite(c.price) || c.price <= 0 || c.price >= entry,
    )
  )
    return null;
  return {
    candidates,
    selected: (stop.kind === "nearest-stop" ? Math.max : Math.min)(
      ...candidates.map((c) => c.price),
    ),
  };
}

export function researchMaximumDistance(
  stop: InitialStopPolicy,
  entry: number,
  evidence: { initialStop?: number | null; stopAtr?: number | null },
) {
  return stop.kind === "max-distance"
    ? researchStopComparison(stop, entry, evidence)
    : null;
}

export function researchInitialStop(
  management: InitialStopManagementPolicy,
  entry: number,
  evidence: {
    initialStop?: number | null;
    stopAtr?: number | null;
    symbol?: string;
    observedDate?: string;
    entryPriceRange?: { min: number; max: number };
  },
) {
  if (management.riskPreset) {
    if (
      management.riskPreset === "rk-chan-line" ||
      riskPresetEvolution(management.riskPreset)?.crowded
    ) {
      const line = evidence.initialStop;
      return line != null && Number.isFinite(line) && line > 0 && line < entry
        ? line
        : null;
    }
    const selected = riskPresetInitialStop(
      management.riskPreset,
      entry,
      evidence,
    );
    if (selected !== undefined) return selected;
  }
  const override = researchStopOverride(management, evidence);
  if (override)
    return Number.isFinite(entry) &&
      Number.isFinite(override.price) &&
      override.price > 0 &&
      override.price < entry
      ? override.price
      : null;
  if (management.swingDiscipline === "sw-stop-volatility") {
    const a = evidence.stopAtr;
    return a != null && Number.isFinite(a) && a > 0 && entry > 0
      ? entry * (1 - (a / entry >= 0.02 ? 0.03 : 0.02))
      : null;
  }
  const stop = management.stop;
  if (isGrowthPivotStop(stop.kind))
    return researchGrowthPivotStop(
      stop.kind,
      entry,
      evidence.entryPriceRange?.min,
    );
  if (stop.kind === "max-distance" || stop.kind === "nearest-stop")
    return researchStopComparison(stop, entry, evidence)?.selected ?? null;
  const value =
    stop.kind === "structure-auto"
      ? evidence.initialStop != null &&
        Number.isFinite(evidence.initialStop) &&
        evidence.initialStop > 0
        ? stop.atrPeriod == null
          ? evidence.initialStop * (1 - stop.percentBuffer)
          : evidence.stopAtr != null &&
              Number.isFinite(evidence.stopAtr) &&
              evidence.stopAtr > 0
            ? evidence.initialStop - stop.atrMultiple * evidence.stopAtr
            : null
        : null
      : stop.kind === "percent"
        ? entry * (1 - stop.fraction)
        : stop.kind === "structure-atr"
          ? evidence.initialStop != null &&
            evidence.stopAtr != null &&
            Number.isFinite(evidence.stopAtr) &&
            evidence.stopAtr > 0
            ? evidence.initialStop - stop.multiple * evidence.stopAtr
            : null
          : stop.kind === "atr"
            ? evidence.stopAtr != null && evidence.stopAtr > 0
              ? entry - stop.multiple * evidence.stopAtr
              : null
            : evidence.initialStop != null && "buffer" in stop
              ? evidence.initialStop * (1 - stop.buffer)
              : null;
  return value != null && Number.isFinite(value) && value > 0 && value < entry
    ? value
    : null;
}
