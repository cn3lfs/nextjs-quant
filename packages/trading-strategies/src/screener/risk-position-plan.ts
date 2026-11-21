import { computeRewardMultiple } from "./helpers.js";

export type TheoryConfluenceGrade = "S" | "A" | "B";
export type TheoryPositionPlan = {
  riskPct: number | null;
  rewardMultiple: number | null;
  recommendedShares: number;
  recommendedWeightPct: number;
  distinctFamilies: number;
  maxScore: number;
  confluenceGrade: TheoryConfluenceGrade;
};

export function computeTheoryPositionPlan({
  rawClose,
  rawStopPrice,
  rawTargetPrice,
  accountEquity = 1_000_000,
  riskPerTradePct = 0.01,
  maxPositionPct = 0.1,
  lotSize = 100,
  direction: requestedDirection,
  matches = [],
}: {
  rawClose: number;
  rawStopPrice: number | null;
  rawTargetPrice: number | null;
  accountEquity?: number;
  riskPerTradePct?: number;
  maxPositionPct?: number;
  lotSize?: number;
  direction?: "long" | "short";
  matches?: readonly {
    direction?: "long" | "short";
    family: string;
    theoryFamily?: string;
    score?: number | null;
  }[];
}): TheoryPositionPlan {
  const primaryDirection =
    requestedDirection ??
    matches[0]?.direction ??
    (rawStopPrice !== null &&
    Number.isFinite(rawStopPrice) &&
    rawStopPrice > rawClose
      ? "short"
      : "long");
  const alignedMatches = matches.filter(
    (m) => !m.direction || m.direction === primaryDirection,
  );
  const families = new Set<string>();
  let bestScore: number | undefined;
  for (const match of alignedMatches) {
    families.add(match.theoryFamily ?? match.family);
    if (match.score != null && Number.isInteger(match.score))
      bestScore = Math.max(bestScore ?? match.score, match.score);
  }
  const distinctFamilies = families.size;
  const maxScore = bestScore ?? 3;
  const plan: TheoryPositionPlan = {
    riskPct: null,
    rewardMultiple: null,
    recommendedShares: 0,
    recommendedWeightPct: 0,
    distinctFamilies,
    maxScore,
    confluenceGrade:
      distinctFamilies >= 3
        ? "S"
        : distinctFamilies === 2 || maxScore >= 5
          ? "A"
          : "B",
  };
  if (
    !Number.isFinite(rawClose) ||
    rawClose <= 0 ||
    rawStopPrice === null ||
    !Number.isFinite(rawStopPrice) ||
    rawStopPrice <= 0 ||
    rawStopPrice === rawClose
  )
    return plan;

  const direction = rawStopPrice < rawClose ? "long" : "short";
  if (direction !== primaryDirection) return plan;
  const perShareRisk = Math.abs(rawClose - rawStopPrice);
  plan.riskPct = perShareRisk / rawClose;
  plan.rewardMultiple = computeRewardMultiple(
    direction,
    rawClose,
    rawStopPrice,
    rawTargetPrice,
  );
  if (
    direction === "short" ||
    ![accountEquity, riskPerTradePct, maxPositionPct].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    !Number.isSafeInteger(lotSize) ||
    lotSize <= 0
  )
    return plan;

  const sharesByRisk = (accountEquity * riskPerTradePct) / perShareRisk;
  const sharesByCap = (accountEquity * maxPositionPct) / rawClose;
  const shares =
    Math.floor(Math.min(sharesByRisk, sharesByCap) / lotSize) * lotSize;
  if (Number.isSafeInteger(shares)) {
    plan.recommendedShares = shares;
    plan.recommendedWeightPct = (shares * rawClose) / accountEquity;
  }
  return plan;
}
