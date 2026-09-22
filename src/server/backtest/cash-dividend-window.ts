import { createHash } from "node:crypto";
import type { Snapshot } from "~/lib/domain";
import { validateActionRange } from "./backtest-actions";
export function cashDividendWindow(
  source: Snapshot,
  start: string,
  end: string,
  slow: number,
) {
  validateActionRange(start, end);
  if (
    source.period !== "day" ||
    (source.historicalAsOf !== undefined && end > source.historicalAsOf) ||
    !source.bars.length ||
    start < source.bars[0]!.date ||
    end > source.bars.at(-1)!.date
  )
    throw new Error("纯现金模拟区间超出日线快照覆盖");
  const bars = source.bars.filter((b) => b.date <= end);
  const evaluationStart = bars.findIndex((b) => b.date >= start);
  if (evaluationStart < slow || bars.length - evaluationStart < 1)
    throw new Error("纯现金模拟预热行情不足或区间为空");
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        version: "cash-window-1",
        sourceHash: source.hash,
        start,
        end,
        bars,
      }),
    )
    .digest("hex");
  return {
    evaluationStart,
    source: {
      ...source,
      bars,
      hash,
      id: `snapshot-cash-${source.symbol}-${hash.slice(0, 16)}`,
      historicalAsOf: end,
    },
  };
}
