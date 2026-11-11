import type { Bar } from "trading-strategy-core/bars";
import { confirmedExtrema } from "trading-strategy-core/indicators";
import { researchStructureTargets } from "../technical/research-structure-targets.js";
import {
  wyckoffScore,
  type WyckoffId,
  type WyckoffPoint,
  type WyckoffStructureInput,
} from "./research-wyckoff.js";
import type { researchWyckoffHourlySeries } from "./research-wyckoff-hourly.js";

export const wyckoffStructureWeeklyCount = 52;
export const wyckoffStructureRsPeriod = 20;
export type WyckoffStructureBasePoint =
  WyckoffPoint | ReturnType<typeof researchWyckoffHourlySeries>[number];
export type WyckoffStructureCriterion = {
  pass: boolean;
  reason: string | null;
  evidence: unknown;
  scoreStop?: number;
  scoreTarget?: ReturnType<typeof researchStructureTargets>;
};

/** All weeks have already passed the application's complete-calendar/visibility checks. */
export function wyckoffWeeklyAlignment(weeks: readonly Bar[]) {
  const extrema = confirmedExtrema(weeks);
  const barrier = extrema.ambiguousIndices.at(-1) ?? -1;
  const points = extrema.extrema.filter((point) => point.index - 3 > barrier);
  const highs = points.filter((point) => point.kind === "high").slice(-2);
  const lows = points.filter((point) => point.kind === "low").slice(-2);
  const aligned =
    weeks.length === wyckoffStructureWeeklyCount &&
    highs.length === 2 &&
    lows.length === 2 &&
    highs[1]!.price > highs[0]!.price &&
    lows[1]!.price > lows[0]!.price;
  return { highs, lows, aligned };
}

/** A zero change fails; ratios remain the existing percent change observations. */
export const wyckoffDualRelativeStrength = (
  industry: number | null,
  market: number | null,
) => industry !== null && market !== null && industry > 0 && market > 0;

/** Frozen JAC/TR drives both payoff and stop; no later range or target reordering. */
export function wyckoffScoreEntry(
  point: WyckoffStructureBasePoint,
  bars: readonly Bar[],
  index: number,
  assessment: NonNullable<WyckoffStructureInput["assessment"]>,
): WyckoffStructureCriterion {
  const score = wyckoffScore(assessment)!;
  const match = point.events.find(
    (event) => event.kind === "jac" && event.state === "confirmed",
  );
  if (!match || !("index" in match.facts))
    return { pass: false, reason: null, evidence: score };
  const facts = match.facts;
  const target = researchStructureTargets({
    model: "source-width-123",
    bars: bars.slice(facts.rangeStart, facts.index),
    low: facts.support,
    high: facts.resistance,
    boxSize: (facts.resistance - facts.support) * 0.1,
    direction: 1,
    breakoutPrice: facts.close,
    confirmedAt: point.date,
  });
  const stop = facts.support * 0.999;
  const payoff =
    target.status === "computed"
      ? (target.targets.at(-1)! - bars[index]!.close) /
        (bars[index]!.close - stop)
      : null;
  return {
    pass:
      score.value >= 70 &&
      ["accumulation", "markup"].includes(score.phase) &&
      payoff !== null &&
      payoff >= 2,
    reason: target.status === "missing" ? target.reason : null,
    evidence: { ...score, payoff, target, stop },
    scoreStop: stop,
    scoreTarget: target,
  };
}

/** Visibility failures always defeat a valid mathematical signal and remain visible in the result. */
export function applyWyckoffStructurePolicy(
  id: WyckoffId,
  point: WyckoffStructureBasePoint,
  input: WyckoffStructureInput | undefined,
  criterion: WyckoffStructureCriterion,
) {
  const { pass, reason, evidence, scoreStop, scoreTarget } = criterion;
  return {
    ...point,
    ...(id === "wy-score-half-kelly" && scoreStop
      ? {
          ruleStop: {
            price: scoreStop,
            days: 60,
            reason: "冻结TR下沿下方0.1%",
          },
        }
      : {}),
    ...(scoreTarget ? { targetPlan: scoreTarget } : {}),
    entry: point.entry && !reason && pass,
    reason,
    inputEvidence: evidence,
    values: {
      ...point.values,
      structureInput: input ?? null,
      criterion: evidence,
    },
    decision: reason ?? (pass ? "共享输入判据通过" : "共享输入判据过滤"),
  };
}
export type WyckoffStructurePoint =
  | ReturnType<typeof applyWyckoffStructurePolicy>
  | (WyckoffStructureBasePoint & { inputEvidence: null });
