import type { DailyPerformance } from "./daily-performance";

type DecaySample = DailyPerformance & {
  informationRatio?: DailyPerformance["sharpeWbt"];
};

export const trackingDecayThreshold = 0.3;
/** 只提示年化或 U8 归一化 IR 衰减；开发期非正或缺失时相对降幅没有可解释的基线。 */
export function trackingDecayWarning(
  development: DecaySample,
  tracking: DecaySample | null,
) {
  const declined = (
    baseline: number | null | undefined,
    current: number | null | undefined,
  ) =>
    baseline != null &&
    baseline > 0 &&
    current != null &&
    (baseline - current) / baseline > trackingDecayThreshold;
  const labels = [
    declined(development.annualReturn.value, tracking?.annualReturn.value)
      ? "年化收益"
      : null,
    declined(
      development.informationRatio?.value,
      tracking?.informationRatio?.value,
    )
      ? "IR"
      : null,
  ].filter((value) => value !== null);
  return labels.length
    ? `跟踪段${labels.join("、")}相对开发段下滑超过 ${trackingDecayThreshold * 100}%，请复核样本；此提示不构成判定。`
    : null;
}
