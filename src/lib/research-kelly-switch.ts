import { researchKellyTraining } from "./research-kelly-training";
import { researchKellyQuality } from "./research-kelly-quality";
import { researchKellyLimit } from "./research-kelly";

export const researchKellySwitchVersion = "research-kelly-rolling-switch30-1";
export function researchKellySwitch(
  trades: Parameters<typeof researchKellyTraining>[0],
  start: string,
  cutoff: string,
  partition: string,
  evidence: string,
  payoff: number,
) {
  const training = researchKellyTraining(trades, start, cutoff, partition);
  const empirical = training.samples.length >= 30;
  const quality = empirical ? null : researchKellyQuality(evidence);
  const fraction = empirical ? 0.5 : 0.25;
  const invalid = training.duplicates > 0;
  const winRate = invalid
    ? null
    : empirical
      ? training.winRate
      : quality!.winRate;
  const calculation = researchKellyLimit(
    { provenance: "development-closed", payoff, fraction },
    winRate,
  );
  return {
    ...calculation,
    ...(invalid
      ? {
          reason: "闭合交易存在重复身份，不切换或回退",
          fullKelly: null,
          weight: null,
        }
      : quality?.reason
        ? { reason: quality.reason, fullKelly: null, weight: null }
        : {}),
    source: empirical ? ("closed-trades" as const) : ("quality-proxy" as const),
    cutoff,
    partition,
    sampleCount: training.samples.length,
    wins: training.wins,
    losses: training.losses,
    zeros: training.zeros,
    fraction,
    winRate,
    quality,
  };
}
