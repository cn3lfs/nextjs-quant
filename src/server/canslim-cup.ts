import { bottomShape } from "./canslim-bottom";
import type { Snapshot } from "~/lib/domain";
import { canslimFlatBase } from "./canslim-flat-base";

export function canslimCup(snapshot: Snapshot, now = Date.now()) {
  const validation = canslimFlatBase(snapshot, now);
  if (!validation.applicable)
    return {
      version: "canslim-cup-2",
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
  const mean = (values: number[]) =>
    values.reduce((sum, value) => sum + value / values.length, 0);
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
      const contracting =
        mean(handle.slice(split).map((b) => b.volume)) <
        mean(handle.slice(0, split).map((b) => b.volume));
      const points =
        (shape === "U" ? 3 : shape === "W" ? 2 : shape === "V" ? 1 : 0) +
        (depth >= 0.15 && depth <= 0.3 ? 2 : 1) +
        (pullback <= depth / 3 && contracting
          ? 2
          : pullback <= depth / 2
            ? 1
            : 0) +
        (handleVolume < cupVolume * 0.6
          ? 2
          : handleVolume < cupVolume * 0.8
            ? 1
            : 0) +
        1;
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
        qualified:
          (shape === "U" || shape === "W") &&
          upperHalf &&
          pullback <= depth / 3 &&
          contracting &&
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
    version: "canslim-cup-2",
    applicable: true as const,
    candidates,
    warnings: [
      "杯柄计算诊断，尚未验证企业行动、交易日缺口或完整入场条件，不生成交易信号。",
      "拐点采用左右各3条严格局部高低点，排除歧义bar，不使用测试日。U形为杯深下方20%区域连续10条；W形为该区域两个已确认低点相隔至少5条、中间反弹达到杯深30%，均属应用适配。",
      "杯周期35–325条、柄至少5条；测试日排除在杯柄窗口之外，三日维持未确认。",
    ],
  };
}
