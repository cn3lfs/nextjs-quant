import type { Snapshot } from "~/lib/domain";
import { canslimFlatBase } from "./canslim-flat-base";
import { canslimCup } from "./canslim-cup";
import { canslimSaucer } from "./canslim-saucer";
import { canslimEntry } from "./canslim-entry";
import { canslimNewHigh } from "./canslim-new-high";
import { canslimVolume } from "./canslim-volume";

/** Keep each qualified geometry and its own pivot; never pick by model preference. */
export function canslimTechnical(
  snapshot: Snapshot,
  now = Date.now(),
  market: Snapshot | null = null,
) {
  const marketBars = market?.bars.slice(-2);
  const marketValid =
    market?.symbol === "sh000300" &&
    !market.historicalAsOf &&
    !snapshot.historicalAsOf &&
    canslimEntry(market, null, null, null, now).asOf !== null &&
    marketBars?.length === 2 &&
    marketBars[0]!.date === snapshot.bars.at(-2)?.date &&
    marketBars[1]!.date === snapshot.bars.at(-1)?.date;
  const change = marketValid
    ? (marketBars[1]!.close / marketBars[0]!.close - 1) * 100
    : null;
  const marketContext =
    change !== null && Number.isFinite(change)
      ? {
          symbol: market!.symbol,
          snapshotId: market!.id,
          snapshotHash: market!.hash,
          bars: marketBars!,
          changePercent: change,
          warning: "相邻记录日期与个股对齐；尚未独立验证交易日连续性和源时效。",
        }
      : null;
  const patterns = {
    flatBase: canslimFlatBase(snapshot, now),
    cup: canslimCup(snapshot, now),
    saucer: canslimSaucer(snapshot, now),
  };
  const entries = Object.entries(patterns).flatMap(([pattern, result]) =>
    result.applicable
      ? result.candidates.flatMap((candidate, index) =>
          candidate.qualified
            ? [
                {
                  pattern,
                  candidateIndex: index,
                  patternVersion: result.version,
                  entry: canslimEntry(
                    snapshot,
                    "pivot" in candidate ? candidate.pivot : candidate.high,
                    marketContext?.changePercent ?? null,
                    null,
                    now,
                  ),
                },
              ]
            : [],
        )
      : [],
  );
  return {
    version: "canslim-technical-4",
    snapshotId: snapshot.id,
    snapshotHash: snapshot.hash,
    patterns,
    newHigh: canslimNewHigh(snapshot, now),
    volume: canslimVolume(snapshot, null, now),
    entries,
    marketContext,
    missing: [
      ...(marketContext ? [] : ["同日沪深300涨跌幅证据"]),
      "截止时点可用的催化剂证据",
      "证券交易限制与账户风险核验",
    ],
  };
}
