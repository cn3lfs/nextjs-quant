export const researchKellyTrainingVersion = "research-kelly-training-1";
type ClosedTrade = {
  event: {
    symbol: string;
    key: string;
    observedDate: string;
    partition: string;
  };
  entryDate: string;
  exitDate: string | null;
  profit: number | null;
  remainingQuantity?: number;
};
export function researchKellyTraining(
  trades: readonly ClosedTrade[],
  start: string,
  cutoff: string,
  partition = "development",
) {
  const samples: Array<{
    symbol: string;
    key: string;
    entryDate: string;
    exitDate: string;
    profit: number;
  }> = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const trade of trades) {
    if (
      trade.event.partition !== partition ||
      trade.event.observedDate < start ||
      trade.event.observedDate >= cutoff ||
      !trade.exitDate ||
      trade.entryDate < trade.event.observedDate ||
      trade.exitDate < trade.entryDate ||
      trade.exitDate >= cutoff ||
      trade.profit == null ||
      !Number.isFinite(trade.profit) ||
      (trade.remainingQuantity != null && trade.remainingQuantity !== 0)
    )
      continue;
    const key = JSON.stringify([
      trade.event.symbol,
      trade.event.key,
      trade.entryDate,
    ]);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    samples.push({
      symbol: trade.event.symbol,
      key: trade.event.key,
      entryDate: trade.entryDate,
      exitDate: trade.exitDate,
      profit: trade.profit,
    });
  }
  samples.sort(
    (a, b) =>
      a.exitDate.localeCompare(b.exitDate) ||
      a.symbol.localeCompare(b.symbol) ||
      a.key.localeCompare(b.key),
  );
  const wins = samples.filter((t) => t.profit > 0).length;
  const losses = samples.filter((t) => t.profit < 0).length;
  const zeros = samples.length - wins - losses;
  const reason = duplicates
    ? "开发期参考交易存在重复身份"
    : samples.length < 30
      ? "开发期不足30笔完整闭合交易"
      : null;
  return {
    version: researchKellyTrainingVersion,
    start,
    cutoff,
    minimumTrades: 30,
    samples,
    wins,
    losses,
    zeros,
    duplicates,
    excluded: trades.length - samples.length,
    winRate: reason ? null : wins / samples.length,
    reason,
  };
}
export type ResearchKellyTraining = ReturnType<typeof researchKellyTraining>;
