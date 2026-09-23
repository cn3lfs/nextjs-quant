import type { Snapshot } from "~/lib/domain";
import { confirmedExtrema } from "trading-strategy-core/indicators";

export function vcpFacts(snapshot: Snapshot, chartBars = false) {
  const bars = snapshot.bars.slice(-60);
  if ((!chartBars && snapshot.period !== "day") || bars.length < 60)
    return {
      version: "vcp-diagnostic-2",
      applicable: false,
      reason: "需要至少 60 根已完成日线",
    };
  const {
    extrema,
    ambiguousDates: ambiguous,
    ambiguousIndices,
  } = confirmedExtrema(bars);
  const crossesAmbiguity = (start: number, end: number) =>
    ambiguousIndices.some((i) => i > start && i < end);
  const contractions: {
    highDate: string;
    lowDate: string;
    confirmedAt: string;
    high: number;
    low: number;
    depthPercent: number;
    start: number;
    end: number;
  }[] = [];
  for (let index = 0; index < extrema.length - 1; index++) {
    const high = extrema[index]!,
      low = extrema[index + 1]!;
    if (
      high.kind !== "high" ||
      low.kind !== "low" ||
      high.price <= low.price ||
      crossesAmbiguity(high.index, low.index)
    )
      continue;
    contractions.push({
      highDate: high.date,
      lowDate: low.date,
      confirmedAt: low.confirmedAt,
      high: high.price,
      low: low.price,
      depthPercent: ((high.price - low.price) / high.price) * 100,
      start: high.index,
      end: low.index,
    });
  }
  const first = contractions[0],
    last = contractions.at(-1);
  const reductions = contractions
    .slice(1)
    .map((wave, i) =>
      crossesAmbiguity(contractions[i]!.end, wave.start)
        ? null
        : (1 - wave.depthPercent / contractions[i]!.depthPercent) * 100,
    );
  const pivot = last
    ? extrema.find(
        (p) =>
          p.kind === "high" &&
          p.index > last.end &&
          !crossesAmbiguity(last.end, p.index),
      )
    : undefined;
  const average = (values: number[]) =>
    values.reduce((sum, n) => sum + n, 0) / values.length;
  const volume5 = average(bars.slice(-5).map((b) => b.volume));
  const volume20 = average(bars.slice(-20).map((b) => b.volume));
  const amplitude5 = average(
    bars.slice(-5).map((b) => ((b.high - b.low) / b.open) * 100),
  );
  return {
    version: "vcp-diagnostic-2",
    applicable: true,
    asOf: bars.at(-1)!.date,
    extrema,
    ambiguousDates: ambiguous,
    contractions,
    reductionsPercent: reductions,
    checks: {
      minimumTwoContractions: contractions.length >= 2,
      shrinkingAtLeast30Percent:
        reductions.length && reductions.every((r) => r !== null)
          ? reductions.every((r) => r! >= 30 - 1e-10)
          : null,
      lastDepthAtMost10Percent: last ? last.depthPercent <= 10 : null,
      amplitudeAtMost1Point5: amplitude5 <= 1.5,
      finalVolumeDry: volume20 > 0 ? volume5 <= volume20 * 0.5 : null,
      duration15To120Bars: first
        ? bars.length - first.start >= 15 && bars.length - first.start <= 120
        : null,
      consolidationVolumeVersusUptrend: null,
    },
    volume5,
    volume20,
    amplitude5,
    pivot: pivot
      ? {
          date: pivot.date,
          confirmedAt: pivot.confirmedAt,
          price: pivot.price,
          confirmationPrice: pivot.price * 1.01,
        }
      : null,
    warnings: [
      "仅 VCP 形态诊断，不给出评分、买卖结论或收益概率。",
      "局部极值需后续 3 根确认，末尾 3 根不作为已确认拐点；同时高低极值的日线无法判断先后，予以隔离。",
      "只配对相邻高低极值，使用近 60 条记录的全部配对，不挑选最有利子序列。",
      "歧义 K 线中断波段配对、跨段收缩比较和枢纽搜索，不跨过隔离记录拼接形态。",
      "上升段边界尚未核验，盘整量能比未计算；长期盘整、复权与缺失交易日另行核验。",
    ],
  };
}
