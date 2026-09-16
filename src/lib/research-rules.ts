import {
  isTechnicalStrategy,
  researchTechnicalSeries,
  type TechnicalStrategyId,
  type TechnicalPoint,
} from "./research-technical";
import {
  isVolumeStrategy,
  researchVolumeSeries,
  type VolumeStrategyId,
  type VolumePoint,
} from "./research-volume";
import type { Bar } from "./domain";
import {
  isChannelStrategy,
  researchChannelSeries,
  type ChannelId,
  type ChannelPoint,
} from "./research-channels";
import {
  isContinuation,
  researchContinuationSeries,
  type ContinuationId,
  type ContinuationPoint,
} from "./research-continuation";
import {
  isCandleStrategy,
  researchCandleSeries,
  type CandleStrategyId,
  type CandlePoint,
} from "./research-candles";
import {
  isVolumeSequence,
  researchVolumeSequenceSeries,
  type VolumeSequenceId,
  type VolumeSequencePoint,
} from "./research-volume-sequence";
import {
  isVolumeFailure,
  researchVolumeFailureSeries,
  type VolumeFailureId,
  type VolumeFailurePoint,
} from "./research-volume-failure";
import {
  isVolumeStructure,
  researchVolumeStructureSeries,
  type VolumeStructureId,
  type VolumeStructurePoint,
} from "./research-volume-structure";
import {
  isVolumeContext,
  researchVolumeContextSeries,
  type VolumeContextId,
  type VolumeContextPoint,
} from "./research-volume-context";
import {
  isVolumeReversal,
  researchVolumeReversalSeries,
  type VolumeReversalId,
  type VolumeReversalPoint,
} from "./research-volume-reversals";
export type ResearchRuleId =
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
): ResearchRulePoint[] {
  if (isChannelStrategy(id)) return researchChannelSeries(id, bars);
  if (isContinuation(id)) return researchContinuationSeries(id, bars);
  if (isCandleStrategy(id)) return researchCandleSeries(id, bars);
  return isVolumeSequence(id)
    ? researchVolumeSequenceSeries(id, bars)
    : isVolumeFailure(id)
      ? researchVolumeFailureSeries(id, bars)
      : isVolumeStructure(id)
        ? researchVolumeStructureSeries(id, bars)
        : isVolumeContext(id)
          ? researchVolumeContextSeries(id, bars)
          : isVolumeReversal(id)
            ? researchVolumeReversalSeries(id, bars)
            : isVolumeStrategy(id)
              ? researchVolumeSeries(id, bars)
              : researchTechnicalSeries(id, bars);
}
