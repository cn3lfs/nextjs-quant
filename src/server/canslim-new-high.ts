import type { Snapshot } from "~/lib/domain";
import { canslimEntry } from "./canslim-entry";

export function canslimNewHigh(snapshot: Snapshot, now = Date.now()) {
  const validation = canslimEntry(snapshot, null, null, null, now);
  const asOf = validation.asOf;
  const start = asOf
    ? new Date(Date.parse(asOf) - 364 * 86400000).toISOString().slice(0, 10)
    : null;
  const covered = start !== null && snapshot.bars[0]!.date <= start;
  const window = covered
    ? snapshot.bars.filter((b) => b.date > start! && b.date <= asOf!)
    : [];
  const high = window.length ? Math.max(...window.map((b) => b.high)) : null;
  const close = asOf ? snapshot.bars.at(-1)!.close : null;
  const points =
    high === null || close === null
      ? 0
      : close >= high
        ? 9
        : close >= high * 0.95
          ? 6
          : close >= high * 0.9
            ? 3
            : 0;
  return {
    id: "N2",
    maxPoints: 9,
    version: "canslim-new-high-1",
    status: covered && high !== null ? "computed" : "missing",
    points,
    asOf,
    windowStartExclusive: start,
    windowBars: window.length,
    high52Weeks: high,
    close,
    distancePercent:
      high !== null && close !== null ? (1 - close / high) * 100 : null,
    breakoutVolumeConfirmed:
      high !== null && close !== null && close >= high
        ? validation.checks.volumeConfirmed
        : null,
    adjustment: snapshot.adjustment,
    warnings: [
      "52周按截止日前364个自然日的左开右闭区间，含测试日最高价；必须有区间起点或更早记录，不将不足52周的最高价冒充全年高点。",
      "0/3/6/9分按收盘距区间最高价的90%/95%/100%分档。放量加分仅在突破时适用，此时已达9分上限，不给未突破的近高点额外加分。",
      "仅对现有快照可计算；交易日缺口、停牌及企业行动可比性未核验，不表示完整52周覆盖已验证。",
    ],
  };
}
