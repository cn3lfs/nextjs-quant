import type { researchWyckoffStructureSeries } from "./research-structure-weekly";
import { isWyckoff, researchWyckoffSeries } from "~/lib/research-wyckoff";
import { researchSwingSystemSeries } from "~/lib/research-swing-system";
import {
  isSwingCore,
  researchSwingCoreSeries,
} from "~/lib/research-swing-core";
import {
  isSepaResearch,
  type SepaResearchId,
} from "~/lib/research-sepa-strategies";
import { researchSepaSeries } from "../canslim/research-sepa";
import type { Bar } from "~/lib/domain";
import type { VolumeEvidence } from "~/lib/research-volume-grid";
import {
  isCanslimResearch,
  isCanslimHigh,
  isCanslimSaucer,
  canslimSaucerShape,
  isCanslimCup,
  isCanslimPriority,
  canslimCupShape,
  type CanslimResearchId,
} from "~/lib/research-canslim-strategies";
import { researchCanslimFlatPoint } from "../canslim/research-canslim-flat";
import { researchCanslimHold } from "../canslim/research-canslim-hold";
import { researchCanslimHighSeries } from "../canslim/research-canslim-high";
import { researchCanslimVolumeScore } from "../canslim/research-canslim-volume-score";
import { researchCanslimVolumeTier } from "../canslim/research-canslim-volume-tier";
import { researchCanslimMarketCombination } from "../canslim/research-canslim-market-combination";
import { isCanslimMarketCombination } from "~/lib/research-canslim-market-strategies";
import { isCanslimMarket } from "~/lib/research-canslim-market-strategies";
import {
  researchCanslimMarketScore,
  type CanslimResearchMarket,
} from "../canslim/research-canslim-market-score";
import { researchCanslimSaucerPoint } from "../canslim/research-canslim-saucer";
import { researchCanslimCupPoint } from "../canslim/research-canslim-cup";
import { researchCanslimPriorityPoint } from "../canslim/research-canslim-priority";
import { researchCanslimFailure } from "../canslim/research-canslim-failure";
import { researchCanslimVolumeWait } from "../canslim/research-canslim-volume-wait";
import { researchCanslimBear } from "../canslim/research-canslim-bear";
import { researchCanslimWeekly } from "../canslim/research-canslim-weekly";
import {
  isResearchRule as isLocalRule,
  researchRuleSeries as localSeries,
  type ResearchRuleId as LocalId,
  type ResearchRulePoint as LocalPoint,
} from "~/lib/research-rules";
import {
  isBreakoutRule,
  breakoutRuleDecision,
  type BreakoutRuleId,
  type BreakoutRulePoint,
} from "~/lib/research-breakout-rules";
import { analyzeBreakout } from "../breakout/breakout";
export type ResearchRuleId =
  LocalId | BreakoutRuleId | CanslimResearchId | SepaResearchId;
export type ResearchRulePoint =
  | ReturnType<typeof researchWyckoffStructureSeries>[number]
  | ReturnType<typeof researchCanslimVolumeTier>[number]
  | ReturnType<typeof researchCanslimMarketCombination>[number]
  | ReturnType<typeof researchCanslimMarketScore>[number]
  | ReturnType<typeof researchCanslimVolumeScore>[number]
  | ReturnType<typeof researchSepaSeries>[number]
  | ReturnType<
      typeof researchCanslimWeekly<
        ReturnType<typeof researchCanslimPriorityPoint>
      >
    >[number]
  | ReturnType<typeof researchCanslimBear>[number]
  | ReturnType<typeof researchCanslimVolumeWait>[number]
  | ReturnType<typeof researchCanslimFailure>[number]
  | ReturnType<typeof researchSwingSystemSeries>[number]
  | ReturnType<typeof researchSwingCoreSeries>[number]
  | LocalPoint
  | BreakoutRulePoint
  | ReturnType<typeof researchCanslimFlatPoint>
  | ReturnType<typeof researchCanslimHold>[number]
  | ReturnType<typeof researchCanslimHighSeries>[number];
export function isResearchRule(id: string): id is ResearchRuleId {
  return (
    isSepaResearch(id) ||
    isLocalRule(id) ||
    isBreakoutRule(id) ||
    isCanslimResearch(id)
  );
}
/** Server adapter keeps the existing diagnostic engine out of client bundles.
 * Each historical point uses its own confirmed structure and indicator prefix. */
export function researchRuleSeries(
  id: ResearchRuleId,
  bars: readonly Bar[],
  calendar: readonly string[] = bars.map((bar) => bar.date),
  market?: CanslimResearchMarket,
  evidence: VolumeEvidence = {},
): ResearchRulePoint[] {
  if (isWyckoff(id)) return researchWyckoffSeries(id, bars, calendar);
  if (id === "canslim-volume-tier" || id === "canslim-volume-tier-crash")
    return researchCanslimVolumeTier(id, bars, calendar, market);
  if (isCanslimMarket(id))
    return researchCanslimMarketScore(id, bars, calendar, market);
  if (id === "canslim-volume-entry-binary")
    return researchCanslimVolumeScore(bars, calendar);
  if (isSepaResearch(id)) return researchSepaSeries(id, bars, calendar);
  if (isCanslimHigh(id)) return researchCanslimHighSeries(id, bars);
  if (isCanslimPriority(id)) {
    const points = bars.map((_, index) =>
      researchCanslimPriorityPoint(
        bars.slice(0, index + 1),
        id === "canslim-priority-gate2-fallback"
          ? "gate2-fallback"
          : id.includes("-scored-handles")
            ? "scored-handles"
            : "strict",
      ),
    );
    if (isCanslimMarketCombination(id))
      return researchCanslimMarketCombination(
        id,
        points,
        bars,
        calendar,
        market,
      );
    if (id === "canslim-priority-exits-daily")
      return researchCanslimWeekly(
        researchCanslimBear(points, bars, calendar, "ma20"),
        bars,
        calendar,
      );
    if (id === "canslim-priority-weekly10-half")
      return researchCanslimWeekly(points, bars, calendar);
    if (id.includes("-bear4-"))
      return researchCanslimBear(
        points,
        bars,
        calendar,
        id.endsWith("previous") ? "previous" : "ma20",
      );
    if (id.includes("-volume-wait"))
      return researchCanslimVolumeWait(
        points,
        bars,
        calendar,
        id.endsWith("3") ? 3 : 5,
      );
    if (id.includes("-fail3-"))
      return researchCanslimFailure(
        points,
        bars,
        calendar,
        id.endsWith("-low") ? "low" : "close",
      );
    return id.endsWith("-hold3")
      ? researchCanslimHold(points, bars, calendar)
      : points;
  }
  if (isCanslimCup(id)) {
    const points = bars.map((_, index) =>
      researchCanslimCupPoint(
        canslimCupShape(id),
        bars.slice(
          id.endsWith("-window120") ? Math.max(0, index - 119) : 0,
          index + 1,
        ),
        id.includes("-total-score")
          ? "score-total"
          : id.includes("-half-handle")
            ? "half-handle"
            : "strict",
        id.includes("-right-not-higher") ? "not-higher" : "symmetric",
      ),
    );
    return id.endsWith("-hold3")
      ? researchCanslimHold(points, bars, calendar)
      : id.endsWith("-window120")
        ? points.map((p, i) =>
            i < 119
              ? {
                  ...p,
                  entry: false,
                  candidate: null,
                  historyStart: null,
                  maxEntryPrice: null,
                  reason: "120根观察窗口未满",
                }
              : p,
          )
        : points;
  }
  if (isCanslimSaucer(id)) {
    const points = bars.map((_, index) =>
      researchCanslimSaucerPoint(
        canslimSaucerShape(id),
        bars.slice(Math.max(0, index - 140), index + 1),
      ),
    );
    return id.endsWith("-hold3")
      ? researchCanslimHold(points, bars, calendar)
      : points;
  }
  if (isCanslimResearch(id)) {
    const points = bars.map((_, index) =>
      researchCanslimFlatPoint(bars.slice(Math.max(0, index - 50), index + 1)),
    );
    return id === "canslim-flat-hold3"
      ? researchCanslimHold(points, bars, calendar)
      : points;
  }
  if (id === "sw-system-combined")
    return researchSwingSystemSeries(bars, analyzeBreakout(bars, 0).points);
  if (isSwingCore(id))
    return researchSwingCoreSeries(
      id,
      bars,
      analyzeBreakout(bars, 0).points,
      calendar,
    );
  return isBreakoutRule(id)
    ? analyzeBreakout(bars, 0).points.map((point, i) =>
        breakoutRuleDecision(id, point, bars[i]!),
      )
    : localSeries(id, bars, evidence);
}
