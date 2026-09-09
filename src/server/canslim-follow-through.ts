import type { Snapshot } from "~/lib/domain";
import { canslimEntry } from "./canslim-entry";

export function canslimFollowThrough(snapshot: Snapshot, now = Date.now()) {
  const bars = snapshot.bars;
  const valid =
    snapshot.symbol === "sh000300" &&
    bars.length >= 38 &&
    canslimEntry(snapshot, null, null, null, now).asOf !== null;
  const candidates = [];
  let bottom = -1,
    start = -1;
  if (valid)
    for (let i = 20; i < bars.length; i++) {
      const b = bars[i]!,
        previous = bars[i - 1]!;
      if (b.low <= Math.min(...bars.slice(i - 20, i).map((v) => v.low))) {
        bottom = i;
        start = -1;
        continue;
      }
      if (bottom < 0) continue;
      if (b.low < bars[bottom]!.low) {
        bottom = -1;
        start = -1;
        continue;
      }
      if (start < 0 && b.close > previous.close) start = i;
      const reboundDay = start < 0 ? 0 : i - start + 1;
      if (reboundDay < 4 || reboundDay > 7 || i < bars.length - 10) continue;
      const priceConfirmed = b.close >= previous.close * 1.015;
      const volumeConfirmed = b.volume > previous.volume * 1.5;
      if (!priceConfirmed && !volumeConfirmed) continue;
      const invalidated = bars.slice(i + 1).find((later) => later.low < b.low);
      candidates.push({
        bottomDate: bars[bottom]!.date,
        reboundStart: bars[start]!.date,
        reboundDay,
        date: b.date,
        low: b.low,
        priceConfirmed,
        volumeConfirmed,
        invalidatedAt: invalidated?.date ?? null,
        points: invalidated ? 0 : priceConfirmed && volumeConfirmed ? 8 : 4,
      });
    }
  return {
    id: "M2",
    maxPoints: 8,
    version: "canslim-follow-through-1",
    status: valid ? "computed" : "missing",
    points: candidates.at(-1)?.points ?? 0,
    selectedDate: candidates.at(-1)?.date ?? null,
    candidates,
    warnings: [
      "反弹起点应用定义：低点不高于此前20条最低点，其后首次收盘上涨为第1日；再次触及20条低点重置。",
      "第4–7条检查涨幅至少1.5%且量严格大于前条1.5倍，仅一项满足为疑似；最近10条取最后候选，后续破其低点作废，不退回旧候选。",
      "仅对当前截止序列作计算诊断，交易日覆盖与反弹起点定义仍须在报告披露，不构成交易许可。",
    ],
  };
}
