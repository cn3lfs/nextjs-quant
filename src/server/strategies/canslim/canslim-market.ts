import type { Snapshot } from "~/lib/domain";
import { canslimEntry } from "./canslim-entry";
import { canslimFollowThrough } from "./canslim-follow-through";

export function canslimMarket(snapshot: Snapshot, now = Date.now()) {
  const bars = snapshot.bars;
  const valid =
    snapshot.symbol === "sh000300" &&
    canslimEntry(snapshot, null, null, null, now).asOf !== null;
  const mean = (end: number, length: number) =>
    bars.slice(end - length, end).reduce((sum, b) => sum + b.close / length, 0);
  const enough = valid && bars.length >= 254;
  const ma250 = enough ? mean(bars.length, 250) : null;
  const ma120 = enough ? mean(bars.length, 120) : null;
  const rising = enough ? ma250! > mean(bars.length - 1, 250) : null;
  const aboveFourDays = enough
    ? [0, 1, 2, 3].every(
        (offset) =>
          bars[bars.length - 1 - offset]!.close >
          mean(bars.length - offset, 250),
      )
    : null;
  const close = bars.at(-1)?.close;
  const near = enough && close! >= ma250! * 0.99 && close! <= ma250! * 1.01;
  const trendPoints = !enough
    ? 0
    : near
      ? 5
      : close! > ma250!
        ? rising && aboveFourDays
          ? 10
          : 7
        : close! > ma120!
          ? 3
          : 0;
  const distributionDates = valid
    ? bars
        .slice(-20)
        .filter((b, i) => {
          const previous = bars[bars.length - 21 + i]!;
          return b.close < previous.close && b.volume > previous.volume;
        })
        .map((b) => b.date)
    : [];
  const recentDates = new Set(bars.slice(-5).map((b) => b.date));
  const recentCount = distributionDates.filter((date) =>
    recentDates.has(date),
  ).length;
  // Application definition: at least three of the last five sessions are distribution days.
  const concentrated = recentCount >= 3;
  return {
    version: "canslim-market-2",
    snapshotId: snapshot.id,
    snapshotHash: snapshot.hash,
    asOf: valid ? bars.at(-1)!.date : null,
    checks: [
      {
        id: "M1",
        maxPoints: 10,
        points: trendPoints,
        status: enough ? "computed" : "missing",
        ma250,
        ma120,
        rising,
        aboveFourDays,
      },
      {
        id: "M3",
        maxPoints: 5,
        points:
          !valid || concentrated || distributionDates.length >= 5
            ? 0
            : distributionDates.length <= 2
              ? 5
              : 3,
        status: valid ? "computed" : "missing",
        distributionDates,
        recentCount,
        concentrated,
      },
      canslimFollowThrough(snapshot, now),
    ],
    warnings: [
      "仅接受沪深300已完成日线。计算诊断不等于完整市场许可，交易日覆盖与源时效仍需独立核验。",
      "M1以相邻MA250比较方向；±1%含边界优先给5分，连续4条站上才排除刚突破，至少需254条。",
      "M3最近5条至少3个分布日定义为集中，属于应用适配；同价或同量不计分布日。M2反弹口径及缺口见该项warnings。",
    ],
  };
}
