import type { Snapshot } from "~/lib/domain";

export function canslimFlatBase(snapshot: Snapshot, now = Date.now()) {
  const bars = snapshot.bars;
  const local = new Date(now + 8 * 3600000).toISOString();
  const invalid =
    snapshot.period !== "day" ||
    bars.length < 36 ||
    bars.some((bar, index) => {
      const time = Date.parse(`${bar.date}T00:00:00Z`);
      return (
        !/^\d{4}-\d{2}-\d{2}$/.test(bar.date) ||
        !Number.isFinite(time) ||
        new Date(time).toISOString().slice(0, 10) !== bar.date ||
        (index > 0 && bar.date <= bars[index - 1]!.date) ||
        [bar.open, bar.high, bar.low, bar.close, bar.volume].some(
          (value) => !Number.isFinite(value),
        ) ||
        bar.low <= 0 ||
        bar.high < Math.max(bar.open, bar.close, bar.low) ||
        bar.low > Math.min(bar.open, bar.close) ||
        bar.volume <= 0 ||
        bar.date > local.slice(0, 10) ||
        (bar.date === local.slice(0, 10) && local.slice(11, 16) < "15:05") ||
        (snapshot.historicalAsOf !== undefined &&
          bar.date > snapshot.historicalAsOf)
      );
    });
  if (invalid)
    return {
      version: "canslim-flat-base-1",
      applicable: false as const,
      reason:
        "需要至少36根有效、递增且已完成日线；零量或越过截止日不能确认形态",
    };
  const last = bars.at(-1)!;
  const mean = (values: number[]) =>
    values.reduce((sum, value) => sum + value / values.length, 0);
  const candidates = [];
  for (let length = 15; length <= 30 && bars.length >= length + 21; length++) {
    // The test day is excluded from the base and its volume reference.
    const base = bars.slice(-length - 1, -1),
      before = bars.slice(-length - 21, -length - 1);
    const high = Math.max(...base.map((b) => b.high)),
      low = Math.min(...base.map((b) => b.low));
    const priorHigh = Math.max(...before.map((b) => b.high));
    const volume = mean(base.map((b) => b.volume)),
      priorVolume = mean(before.map((b) => b.volume));
    const depth = (high - low) / high,
      distance = Math.max(0, (priorHigh - high) / priorHigh);
    const split = Math.floor(length / 2);
    const contracting =
      mean(base.slice(split).map((b) => b.volume)) <
      mean(base.slice(0, split).map((b) => b.volume));
    const points =
      (length >= 20 ? 2 : 1) +
      (low >= high * 0.9 ? 3 : low >= high * 0.85 ? 2 : 0) +
      (volume < priorVolume * 0.5 ? 3 : volume < priorVolume * 0.7 ? 2 : 0) +
      (high >= priorHigh * 0.9 ? 2 : high >= priorHigh * 0.85 ? 1 : 0);
    candidates.push({
      length,
      start: base[0]!.date,
      end: base.at(-1)!.date,
      high,
      low,
      priorHigh,
      depthPercent: depth * 100,
      distancePercent: distance * 100,
      volumeRatio: volume / priorVolume,
      contracting,
      points,
      qualified:
        low >= high * 0.85 &&
        high >= priorHigh * 0.85 &&
        contracting &&
        volume < priorVolume * 0.7 &&
        points >= 6,
      breakout: {
        asOf: last.date,
        closeAboveConfirmation: last.close > high * 1.01,
        withinFivePercent: last.close <= high * 1.05,
        volumeConfirmed:
          last.volume >= mean(bars.slice(-21, -1).map((b) => b.volume)) * 1.5,
        threeDayHold: null,
      },
    });
  }
  return {
    version: "canslim-flat-base-1",
    applicable: true as const,
    candidates,
    warnings: [
      "平台整理诊断，不代表杯柄/碟形或完整入场确认；不自动触发交易信号。",
      "应用窗口15–30条，前高与前期均量取整理前20条；量能持续萎缩采用后半段均量低于前半段，需披露此适配口径。",
      "测试日不进入整理区间；突破后3日维持、复权事件、交易日缺口及涨跌停状态尚需核验。",
    ],
  };
}
