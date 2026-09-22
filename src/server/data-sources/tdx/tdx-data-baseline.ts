import type { Snapshot } from "~/lib/domain";
import { readSnapshot } from "./tdx";

/** Observed gaps are not trading-status judgments: suspended sessions stay unknown. */
export function summarizeTdxSnapshot(snapshot: Snapshot, targetDate: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) ||
    !Number.isFinite(Date.parse(targetDate)) ||
    new Date(targetDate).toISOString().slice(0, 10) !== targetDate
  )
    throw new Error("目标日期非法");
  const bars = snapshot.bars;
  const target = bars.filter((bar) => bar.date.slice(0, 10) === targetDate);
  const expectedTimes =
    snapshot.period === "5m"
      ? [570, 780].flatMap((start) =>
          Array.from({ length: 24 }, (_, i) => {
            const end = start + (i + 1) * 5;
            return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
          }),
        )
      : [];
  const observed = new Set(target.map((bar) => bar.date.slice(11, 16)));
  return {
    symbol: snapshot.symbol,
    name: snapshot.name ?? null,
    period: snapshot.period,
    source: snapshot.source,
    adjustment: snapshot.adjustment,
    hash: snapshot.hash,
    count: bars.length,
    first: bars[0]?.date ?? null,
    last: bars.at(-1)?.date ?? null,
    targetDate,
    targetCount: target.length,
    missingRegularSessionTimes: expectedTimes.filter(
      (time) => !observed.has(time),
    ),
    unexpectedTimes:
      snapshot.period === "5m"
        ? [...observed].filter((time) => !expectedTimes.includes(time))
        : [],
    lastBar: bars.at(-1) ?? null,
    tradingStatus: "unknown" as const,
  };
}

export async function captureTdxBaseline(
  root: string,
  symbols: string[],
  targetDate: string,
) {
  const observations = [];
  // Sequential full-file reads bound memory and use the same parser as the application.
  for (const symbol of [...new Set(symbols)]) {
    for (const period of ["day", "5m"] as const) {
      try {
        observations.push({
          status: "read" as const,
          ...summarizeTdxSnapshot(
            await readSnapshot(root, symbol, period),
            targetDate,
          ),
        });
      } catch (error) {
        observations.push({
          status: "unavailable" as const,
          symbol,
          period,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return {
    capturedAt: new Date().toISOString(),
    root,
    targetDate,
    note: "缺口按普通完整交易日展示；不判定停牌或今日是否交易，盘中尚未到达的时段也包含在缺口中。",
    observations,
  };
}
