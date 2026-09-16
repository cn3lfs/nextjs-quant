import type { ResearchKellyTraining } from "./research-kelly-training";
export const researchKellyPayoffVersion = "research-kelly-net-payoff-1";
export function researchKellyNetPayoff(
  training: ResearchKellyTraining | null | undefined,
) {
  const positive = training?.samples.filter((row) => row.profit > 0) ?? [];
  const negative = training?.samples.filter((row) => row.profit < 0) ?? [];
  const meanWin = positive.length
    ? positive.reduce((sum, row) => sum + row.profit / positive.length, 0)
    : null;
  const meanLoss = negative.length
    ? negative.reduce((sum, row) => sum - row.profit / negative.length, 0)
    : null;
  const ratio =
    meanWin != null && meanLoss != null && meanWin > 0 && meanLoss > 0
      ? meanWin / meanLoss
      : null;
  const reason =
    !training || training.reason || training.samples.length < 30
      ? "开发期参考样本不可用或不足30笔"
      : !positive.length || !negative.length
        ? "开发期缺少盈利或亏损交易，回报倍数不可用"
        : ratio == null || !Number.isFinite(ratio) || ratio <= 0
          ? "净损益均值比超出有效范围"
          : null;
  return {
    version: researchKellyPayoffVersion,
    wins: positive.length,
    losses: negative.length,
    meanWinNetProfit:
      meanWin != null && Number.isFinite(meanWin) ? meanWin : null,
    meanLossAbsNetProfit:
      meanLoss != null && Number.isFinite(meanLoss) ? meanLoss : null,
    payoff: reason ? null : ratio,
    reason,
  };
}
