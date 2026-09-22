import type { Snapshot } from "~/lib/domain";
import { canslimFlatBase } from "./canslim-flat-base";
import { bottomShape } from "./canslim-bottom";
export function canslimSaucer(snapshot: Snapshot, now = Date.now()) {
  const validation = canslimFlatBase(snapshot, now);
  if (!validation.applicable || snapshot.bars.length < 46)
    return {
      version: "canslim-saucer-2",
      applicable: false as const,
      reason: "需要至少46根有效已完成日线，包含25条整理与20条量能参照",
    };
  const bars = snapshot.bars,
    last = bars.at(-1)!;
  const mean = (values: number[]) =>
    values.reduce((sum, value) => sum + value / values.length, 0);
  const candidates = [];
  for (let length = 25; length <= 120 && bars.length >= length + 21; length++) {
    const base = bars.slice(-length - 1, -1),
      before = bars.slice(-length - 21, -length - 1);
    const high = Math.max(...base.map((b) => b.high)),
      low = Math.min(...base.map((b) => b.low));
    const depth = (high - low) / high;
    const bottomIndex = base.findIndex((b) => b.low === low);
    const geometry = bottomShape(base, high, low);
    const longest = geometry.longest;
    const bottom = base.filter((b) => b.low <= low + (high - low) * 0.2);
    const positioned =
      depth > 0 &&
      bottomIndex >= 5 &&
      bottomIndex < length - 5 &&
      base[0]!.close > low + (high - low) * 0.5 &&
      base.at(-1)!.close > low + (high - low) * 0.5;
    const rounded = positioned && geometry.rounded;
    const shape = rounded
      ? "U"
      : positioned && geometry.doubleBottom
        ? "W"
        : "unclassified";
    const volume = mean(bottom.map((b) => b.volume)),
      priorVolume = mean(before.map((b) => b.volume));
    const points =
      (low >= high * 0.9 ? 3 : low >= high * 0.85 ? 2 : 0) +
      (length >= 30 ? 2 : 1) +
      (shape === "U" ? 2 : shape === "W" ? 1 : 0) +
      (volume < priorVolume * 0.4 ? 3 : volume < priorVolume * 0.6 ? 2 : 0);
    candidates.push({
      length,
      start: base[0]!.date,
      end: base.at(-1)!.date,
      bottomDate: base[bottomIndex]!.date,
      high,
      low,
      depthPercent: depth * 100,
      longestBottomRun: longest,
      rounded,
      shape,
      doubleBottom: geometry.doubleBottom,
      bottomVolumeRatio: volume / priorVolume,
      points,
      qualified:
        low >= high * 0.85 &&
        (shape === "U" || shape === "W") &&
        volume < priorVolume * 0.6 &&
        points >= 6,
      testDate: last.date,
      breakoutAboveOnePercent: last.close > high * 1.01,
      threeDayHold: null,
    });
  }
  return {
    version: "canslim-saucer-2",
    applicable: true as const,
    candidates,
    warnings: [
      "25–120条窗口的碟形诊断，未覆盖更长整理；不等于完整入场许可。",
      "圆底采用底部20%深度区域连续至少10条、最低点远离两端且两端收盘回到上半部；底部均量与整理前20条比较，属于应用适配。",
      "W形采用与杯柄一致的已确认双低点与反弹口径，形状项1分；不使用测试日构造形态，三日维持、企业行动和完整交易日覆盖尚未核验。",
    ],
  };
}
