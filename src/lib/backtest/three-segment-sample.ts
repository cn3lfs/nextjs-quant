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

export function paramsFrozenMessage(
  paramsFrozenAt: number | null,
  paramsFrozenBeforeTracking: boolean | null,
) {
  if (paramsFrozenAt === null) return "无法确认参数冻结时间";
  const date = new Date(paramsFrozenAt + 8 * 3600000)
    .toISOString()
    .slice(0, 10);
  if (paramsFrozenBeforeTracking === null)
    return `参数最早记录 ${date}；无跟踪起点，无法确认参数是否在跟踪期开始前已存在`;
  return paramsFrozenBeforeTracking
    ? `参数在跟踪期开始前已存在（最早记录 ${date}）`
    : `参数最早记录 ${date} 不早于跟踪起点，本段不是参数外样本`;
}

export function trackingSimulationDisclaimer(
  paramsFrozenBeforeTracking: boolean | null,
) {
  return `不是前向成交业绩，收益仍为模拟${paramsFrozenBeforeTracking === true ? "。" : "，不证明持有期、费用、证券池等参数在上线前已冻结。"}`;
}
