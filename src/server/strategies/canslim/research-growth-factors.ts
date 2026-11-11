import { createHash } from "node:crypto";
import {
  evaluateGrowthFactorsFromContext,
  rankGrowthFactorRows,
  validateGrowthRankRequests,
  growthFactorMethods,
} from "trading-strategies/research/growth/growth-factor-engine";
import { type CanslimAsOfRequest } from "trading-strategies/research/contracts/canslim-request";
import { captureGrowthFactorContext } from "./growth-factor-context";
/** Capture and archive boundary; factor mathematics lives in the strategy package. */
export function evaluateGrowthFactors(
  request: CanslimAsOfRequest,
  observations: unknown,
  methodIds: readonly string[] = Object.keys(growthFactorMethods),
) {
  const payload = evaluateGrowthFactorsFromContext(
    captureGrowthFactorContext(request, observations),
    methodIds,
  );
  return {
    id: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    ...payload,
  };
}
export function rankGrowthFactors(
  requests: readonly CanslimAsOfRequest[],
  observations: unknown,
  methodId: string,
) {
  const parsed = validateGrowthRankRequests(requests);
  return rankGrowthFactorRows(
    parsed,
    parsed.map((r) => ({
      symbol: r.symbol,
      ...evaluateGrowthFactors(r, observations, [methodId]).results[0]!,
    })),
  );
}
