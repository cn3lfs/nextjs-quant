import { bottomShape } from "./canslim-bottom";
import type { Snapshot } from "~/lib/domain";
import { canslimFlatBase } from "./canslim-flat-base";

export function canslimCup(
  snapshot: Snapshot,
  now = Date.now(),
  qualification:
    "strict" | "v-score" | "half-handle" | "score-total" = "strict",
) {
  const version =
    qualification === "score-total"
      ? "canslim-cup-score-total-1"
      : qualification === "half-handle"
        ? "canslim-cup-half-handle-1"
        : qualification === "v-score"
          ? "canslim-cup-v-score-1"
          : "canslim-cup-2";
  const validation = canslimFlatBase(snapshot, now);
  if (!validation.applicable)
    return {
      version,
      applicable: false as const,
      reason: validation.reason,
    };
  const bars = snapshot.bars,
    end = bars.length - 2;
  const peaks: number[] = [];
  for (let i = 3; i <= end - 3; i++) {
    const peers = bars.slice(i - 3, i + 4).filter((_, offset) => offset !== 3);
    if (
      peers.every((b) => bars[i]!.high > b.high) &&
      !peers.every((b) => bars[i]!.low < b.low)
    )
      peaks.push(i);
  }
  const mean = (values: number[]) => {
    if (qualification !== "score-total")
      return values.reduce((sum, value) => sum + value / values.length, 0);
    // Positive volumes: normalization avoids overflow and preserves an exact
    // constant-volume mean at the strict 60/80 percent scoring boundaries.
    const scale = values.reduce((max, value) => Math.max(max, value), 0);
    return (
      (values.reduce((sum, value) => sum + value / scale, 0) / values.length) *
      scale
    );
  };
  const candidates = [];
  for (const right of peaks) {
    if (end - right < 5) continue;
    const handle = bars.slice(right + 1, end + 1),
      rightHigh = bars[right]!.high;
    if (handle.some((b) => b.high > rightHigh)) continue;
    const handleLow = Math.min(...handle.map((b) => b.low));
    for (const left of peaks) {
      const duration = right - left;
      if (duration < 35 || duration > 325) continue;
      const leftHigh = bars[left]!.high;
      if (rightHigh < leftHigh * 0.95 || rightHigh > leftHigh * 1.05) continue;
      const cup = bars.slice(left, right + 1),
        bottom = Math.min(...cup.map((b) => b.low));
      const depth = (leftHigh - bottom) / leftHigh;
      if (depth < 0.12 || depth > 0.33) continue;
      const bottomIndex = left + cup.findIndex((b) => b.low === bottom);
      if (bottomIndex <= left + 3 || bottomIndex >= right - 3) continue;
      const { longest, rounded, doubleBottom, shape } = bottomShape(
        cup,
        leftHigh,
        bottom,
      );
      const pullback = (rightHigh - handleLow) / rightHigh;
      const upperHalf = handleLow > bottom + (leftHigh - bottom) / 2;
      const cupVolume = mean(cup.map((b) => b.volume)),
        handleVolume = mean(handle.map((b) => b.volume));
      const split = Math.floor(handle.length / 2);
      const firstVolume = mean(handle.slice(0, split).map((b) => b.volume));
      const secondVolume = mean(handle.slice(split).map((b) => b.volume));
      const contracting = secondVolume < firstVolume;
      const steady =
        secondVolume >= firstVolume * 0.9 && secondVolume <= firstVolume * 1.1;
      const handlePoints =
        pullback <= depth / 3 &&
        (qualification === "score-total" || contracting)
          ? 2
          : pullback <= depth / 2 && (qualification !== "half-handle" || steady)
            ? 1
            : 0;
      const scoreComponents = {
        shape: shape === "U" ? 3 : shape === "W" ? 2 : shape === "V" ? 1 : 0,
        depth: depth >= 0.15 && depth <= 0.3 ? 2 : 1,
        handle: handlePoints,
        volume:
          handleVolume < cupVolume * 0.6
            ? 2
            : handleVolume < cupVolume * 0.8
              ? 1
              : 0,
        duration: 1,
      };
      const points =
        scoreComponents.shape +
        scoreComponents.depth +
        scoreComponents.handle +
        scoreComponents.volume +
        scoreComponents.duration;
      candidates.push({
        left: bars[left]!.date,
        right: bars[right]!.date,
        bottomDate: bars[bottomIndex]!.date,
        leftConfirmedAt: bars[left + 3]!.date,
        rightConfirmedAt: bars[right + 3]!.date,
        handleEnd: bars[end]!.date,
        duration,
        handleLength: handle.length,
        depthPercent: depth * 100,
        handlePullbackPercent: pullback * 100,
        upperHalf,
        rounded,
        shape,
        doubleBottom,
        longestBottomRun: longest,
        volumeRatio: handleVolume / cupVolume,
        contracting,
        points,
        ...(qualification === "score-total"
          ? {
              scoreComponents,
              hardChecks: {
                recognizedShape: shape === "U" || shape === "W",
                upperHalf,
                handleThird: pullback <= depth / 3,
                contracting,
                volumeBelow80: handleVolume < cupVolume * 0.8,
              },
            }
          : {}),
        ...(qualification === "half-handle"
          ? {
              handlePoints,
              steady,
              handleHalfVolumeRatio: secondVolume / firstVolume,
            }
          : {}),
        qualified:
          qualification === "score-total"
            ? upperHalf && points >= 6
            : (shape === "U" ||
                shape === "W" ||
                (qualification !== "strict" && shape === "V")) &&
              upperHalf &&
              (qualification === "half-handle"
                ? handlePoints === 1
                : pullback <= depth / 3 && contracting) &&
              handleVolume < cupVolume * 0.8 &&
              points >= 6,
        pivot: rightHigh,
        testDate: bars.at(-1)!.date,
        breakoutAboveOnePercent: bars.at(-1)!.close > rightHigh * 1.01,
        threeDayHold: null,
      });
    }
  }
  return {
    version,
    applicable: true as const,
    candidates,
    warnings: [
      ...(qualification === "score-total"
        ? [
            "总分表对照：柄分仅按回调深度计2/1/0，形状或量能0分不单独否决，总分至少6。保留杯35–325条、深12–33%、对称杯沿5%、柄至少5条且上半部等基础几何；各项原硬条件另记，不等于严格柄或完整CANSLIM。",
          ]
        : []),
      ...(qualification === "half-handle"
        ? [
            "柄1分对照只选柄质量恰为1分：回调不超杯深二分之一，后半均量在前半90%至110%之间（含边界，为工程口径）；浅柄且缩量优先计2分，不混入本分支。上半部和总分至少6仍保留，U/W/V分别研究。",
          ]
        : []),
      ...(qualification === "v-score"
        ? [
            "V形评分对照允许形状1分进入候选，仍要求严格上半部、三分之一柄深、缩量与总分至少6；不放开深柄评分分支。",
          ]
        : []),
      "杯柄计算诊断，尚未验证企业行动、交易日缺口或完整入场条件，不生成交易信号。",
      "拐点采用左右各3条严格局部高低点，排除歧义bar，不使用测试日。U形为杯深下方20%区域连续10条；W形为该区域两个已确认低点相隔至少5条、中间反弹达到杯深30%，均属应用适配。",
      "杯周期35–325条、柄至少5条；测试日排除在杯柄窗口之外，三日维持未确认。",
    ],
  };
}
