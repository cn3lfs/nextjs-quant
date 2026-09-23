import {
  isWyckoffHourly,
  researchWyckoffHourlySeries,
  type WyckoffHourlyId,
} from "../methods/wyckoff/research-wyckoff-hourly";
import {
  isWyckoffVsa,
  researchWyckoffVsaSeries,
  type WyckoffVsaId,
} from "../methods/wyckoff/research-wyckoff-vsa";
import {
  isWyckoff,
  researchWyckoffSeries,
  type WyckoffId,
  type WyckoffPoint,
} from "../methods/wyckoff/research-wyckoff";
import {
  isTechnicalStrategy,
  researchTechnicalSeries,
  type TechnicalStrategyId,
  type TechnicalPoint,
} from "../technical/research-technical";
import {
  isVolumeStrategy,
  researchVolumeSeries,
  type VolumeStrategyId,
  type VolumePoint,
} from "../methods/volume/research-volume";
import type { Bar } from "../../domain";
import type { VolumeEvidence } from "../methods/volume/research-volume-grid";
import {
  isChannelStrategy,
  researchChannelSeries,
  type ChannelId,
  type ChannelPoint,
} from "../technical/research-channels";
import {
  isContinuation,
  researchContinuationSeries,
  type ContinuationId,
  type ContinuationPoint,
} from "../technical/research-continuation";
import {
  isCandleStrategy,
  researchCandleSeries,
  type CandleStrategyId,
  type CandlePoint,
} from "../technical/research-candles";
import {
  isVolumeSequence,
  researchVolumeSequenceSeries,
  type VolumeSequenceId,
  type VolumeSequencePoint,
} from "../methods/volume/research-volume-sequence";
import {
  isVolumeFailure,
  researchVolumeFailureSeries,
  type VolumeFailureId,
  type VolumeFailurePoint,
} from "../methods/volume/research-volume-failure";
import {
  isVolumeStructure,
  researchVolumeStructureSeries,
  type VolumeStructureId,
  type VolumeStructurePoint,
} from "../methods/volume/research-volume-structure";
import {
  isVolumeContext,
  researchVolumeContextSeries,
  type VolumeContextId,
  type VolumeContextPoint,
} from "../methods/volume/research-volume-context";
import {
  isVolumeReversal,
  researchVolumeReversalSeries,
  type VolumeReversalId,
  type VolumeReversalPoint,
} from "../methods/volume/research-volume-reversals";
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
              : researchTechnicalSeries(id, bars, evidence);
}
