import type { FormulaRuntime } from "../contracts/formula-runtime.js";
import {
  isWyckoffHourly,
  researchWyckoffHourlySeries,
  type WyckoffHourlyId,
} from "../wyckoff/research-wyckoff-hourly.js";
import {
  isWyckoffVsa,
  researchWyckoffVsaSeries,
  type WyckoffVsaId,
} from "../wyckoff/research-wyckoff-vsa.js";
import {
  isWyckoff,
  researchWyckoffSeries,
  type WyckoffId,
  type WyckoffPoint,
} from "../wyckoff/research-wyckoff.js";
import {
  isTechnicalStrategy,
  researchTechnicalSeries,
  type TechnicalStrategyId,
  type TechnicalPoint,
} from "../technical/research-technical.js";
import {
  isVolumeStrategy,
  researchVolumeSeries,
  type VolumeStrategyId,
  type VolumePoint,
} from "../volume/research-volume.js";
import type { Bar } from "trading-strategy-core/bars";
import type { VolumeEvidence } from "../volume/research-volume-grid.js";
import {
  isChannelStrategy,
  researchChannelSeries,
  type ChannelId,
  type ChannelPoint,
} from "../technical/research-channels.js";
import {
  isContinuation,
  researchContinuationSeries,
  type ContinuationId,
  type ContinuationPoint,
} from "../technical/research-continuation.js";
import {
  isCandleStrategy,
  researchCandleSeries,
  type CandleStrategyId,
  type CandlePoint,
} from "../technical/research-candles.js";
import {
  isVolumeSequence,
  researchVolumeSequenceSeries,
  type VolumeSequenceId,
  type VolumeSequencePoint,
} from "../volume/research-volume-sequence.js";
import {
  isVolumeFailure,
  researchVolumeFailureSeries,
  type VolumeFailureId,
  type VolumeFailurePoint,
} from "../volume/research-volume-failure.js";
import {
  isVolumeStructure,
  researchVolumeStructureSeries,
  type VolumeStructureId,
  type VolumeStructurePoint,
} from "../volume/research-volume-structure.js";
import {
  isVolumeContext,
  researchVolumeContextSeries,
  type VolumeContextId,
  type VolumeContextPoint,
} from "../volume/research-volume-context.js";
import {
  isVolumeReversal,
  researchVolumeReversalSeries,
  type VolumeReversalId,
  type VolumeReversalPoint,
} from "../volume/research-volume-reversals.js";
export type ResearchRuleId =
  | WyckoffHourlyId
  | WyckoffVsaId
  | WyckoffId
  | ChannelId
  | ContinuationId
  | CandleStrategyId
  | TechnicalStrategyId
  | VolumeStrategyId
  | VolumeReversalId
  | VolumeContextId
  | VolumeStructureId
  | VolumeFailureId
  | VolumeSequenceId;
export type ResearchRulePoint =
  | ReturnType<typeof researchWyckoffHourlySeries>[number]
  | ReturnType<typeof researchWyckoffVsaSeries>[number]
  | WyckoffPoint
  | ChannelPoint
  | ContinuationPoint
  | CandlePoint
  | TechnicalPoint
  | VolumePoint
  | VolumeReversalPoint
  | VolumeContextPoint
  | VolumeStructurePoint
  | VolumeFailurePoint
  | VolumeSequencePoint;
export function isResearchRule(id: string): id is ResearchRuleId {
  return (
    isWyckoffHourly(id) ||
    isWyckoffVsa(id) ||
    isWyckoff(id) ||
    isChannelStrategy(id) ||
    isContinuation(id) ||
    isCandleStrategy(id) ||
    isTechnicalStrategy(id) ||
    isVolumeStrategy(id) ||
    isVolumeReversal(id) ||
    isVolumeContext(id) ||
    isVolumeStructure(id) ||
    isVolumeFailure(id) ||
    isVolumeSequence(id)
  );
}
export function researchRuleSeries(
  id: ResearchRuleId,
  bars: readonly Bar[],
  evidence: VolumeEvidence = {},
  runtime?: FormulaRuntime,
): ResearchRulePoint[] {
  if (isWyckoffHourly(id)) return researchWyckoffHourlySeries(bars);
  if (isWyckoffVsa(id)) return researchWyckoffVsaSeries(id, bars);
  if (isWyckoff(id)) return researchWyckoffSeries(id, bars);
  if (isChannelStrategy(id)) return researchChannelSeries(id, bars);
  if (isContinuation(id)) return researchContinuationSeries(id, bars);
  if (isCandleStrategy(id)) return researchCandleSeries(id, bars);
  return isVolumeSequence(id)
    ? researchVolumeSequenceSeries(id, bars, evidence)
    : isVolumeFailure(id)
      ? researchVolumeFailureSeries(id, bars, evidence)
      : isVolumeStructure(id)
        ? researchVolumeStructureSeries(id, bars, evidence)
        : isVolumeContext(id)
          ? researchVolumeContextSeries(id, bars, evidence)
          : isVolumeReversal(id)
            ? researchVolumeReversalSeries(id, bars, evidence)
            : isVolumeStrategy(id)
              ? researchVolumeSeries(id, bars, evidence)
              : researchTechnicalSeries(id, bars, evidence, runtime);
}
