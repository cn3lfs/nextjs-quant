import type { Bar } from "trading-strategy-core/bars";
import type { BreakoutPoint } from "../breakout/breakout.js";
import type { CzscResult } from "../chan/czsc.js";
import type { InitialStopPolicy } from "../contracts/initial-stop.js";
import { crowdedStop } from "../risk/research-risk-scenarios.js";
import {
  riskPresetEvolution,
  riskPresetAdmission,
  type RiskPresetId,
} from "../risk/research-risk-presets.js";
import type { SwingDisciplineId } from "../swing/research-swing-discipline.js";
import { researchBreakoutStopLocation } from "./research-breakout-stops.js";

/** Historical legacy profile; explicit confirmed-native admission is a separate policy. */
export function legacyCzscQualifiedSignals(
  result: CzscResult,
  config: 0 | 1100,
) {
  return result.status === "structure"
    ? (result.families
        .find((family) => family.config === config)
        ?.signals.filter(
          (point) =>
            [1, 2, 3].includes(point.kind) && [1, 2].includes(point.quality),
        ) ?? [])
    : [];
}
export type BreakoutEntryPolicy = {
  strategy: string;
  stopDiagnosis: boolean;
  stopKind?: InitialStopPolicy["kind"];
  contextRisk?: string;
  swingDiscipline?: SwingDisciplineId;
  riskPreset?: RiskPresetId;
  pyramidKind?: string;
  growthIntraday?: string;
  riskScenario?: string;
};
/** Strategy facts only. The caller serializes evidence and performs fills. */
export function breakoutEntryIntent(
  point: BreakoutPoint,
  bar: Bar,
  previous: Bar,
  policy: BreakoutEntryPolicy,
  stopAtr: number | null,
) {
  const crowd = riskPresetEvolution(policy.riskPreset)?.crowded;
  const crowded = crowd
    ? crowdedStop(point, crowd.anchor, stopAtr, crowd.multiple)
    : null;
  const location =
    policy.stopKind === "breakout-candle" ||
    policy.stopKind === "platform-upper"
      ? researchBreakoutStopLocation(
          policy.stopKind,
          bar,
          previous,
          point.levels,
        )
      : undefined;
  if (point.long.status !== "是" || bar.volume <= 0) return null;
  return {
    evidence:
      location === undefined
        ? point.long
        : { ...point.long, stopLocation: location },
    ...(policy.contextRisk === "sw-preflight" ||
    policy.swingDiscipline === "sw-min-rr2" ||
    (policy.riskPreset && riskPresetAdmission(policy.riskPreset) === "rr2")
      ? { entryTarget: point.long.risk.target1?.price ?? null }
      : {}),
    ...(crowd ? { initialStop: crowded?.price ?? null } : {}),
    ...(location !== undefined ? { initialStop: location?.price ?? null } : {}),
    ...(policy.pyramidKind === "pullback-50-50"
      ? {
          pullbackLevel:
            point.long.keyLevel && point.long.line
              ? Math.max(point.long.keyLevel.price, point.long.line.value)
              : null,
        }
      : {}),
    ...(policy.stopDiagnosis ||
    policy.strategy === "dual-breakout-structure" ||
    [
      "structure",
      "structure-atr",
      "max-distance",
      "nearest-stop",
      "structure-auto",
    ].some((kind) => kind === policy.stopKind)
      ? {
          initialStop:
            policy.growthIntraday === "RK-C-swing-system" ||
            policy.riskScenario === "pullback"
              ? (point.levels
                  .filter(
                    (level) =>
                      level.source === "swing-low" &&
                      level.confirmedAt <= bar.date &&
                      level.price < bar.close,
                  )
                  .sort((a, b) => b.index - a.index)[0]?.price ?? null)
              : (point.long.risk.stop?.price ?? null),
        }
      : {}),
  };
}
