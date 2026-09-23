import type { Bar, Snapshot } from "~/lib/domain";
import {
  canslimHighPoints,
  type CanslimHighId,
} from "~/lib/research/methods/canslim/research-canslim-strategies";
import { canslimNewHigh } from "./canslim-new-high";

export function researchCanslimHighSeries(
  id: CanslimHighId,
  bars: readonly Bar[],
) {
  const minimum = canslimHighPoints[id];
  let left = 0;
  let previous: ReturnType<typeof canslimNewHigh> | null = null;
  return bars.map((bar, index) => {
    const time = Date.parse(`${bar.date}T07:06:00Z`);
    const start = Date.parse(bar.date) - 364 * 86400000;
    // Keep one anchor at or before the left boundary, without old invalid bars
    // outside the factor window poisoning every future observation.
    while (left < index && Date.parse(bars[left + 1]!.date) <= start) left++;
    const snapshot: Snapshot = {
      id: "research-prefix",
      hash: "research-prefix",
      symbol: "research",
      source: "research-dataset",
      period: "day",
      adjustment: "none",
      historicalAsOf: bar.date,
      createdAt: Number.isFinite(time) ? time : 0,
      bars: bars.slice(left, index + 1),
    };
    const diagnostic = Number.isFinite(time)
      ? canslimNewHigh(snapshot, time)
      : null;
    // Reuse validated window evidence, but do not reuse the reference's 95/100
    // score tiers for the entry document's distinct inclusive 98% condition.
    const current =
      diagnostic && id === "canslim-high-98"
        ? {
            ...diagnostic,
            version: "canslim-new-high-entry98-1",
            points:
              diagnostic.status === "computed" &&
              diagnostic.close !== null &&
              diagnostic.high52Weeks !== null &&
              diagnostic.close >= diagnostic.high52Weeks * 0.98
                ? 9
                : 0,
            warnings: diagnostic.warnings.map((warning, index) =>
              index === 1
                ? "入口简表独立二值评分：收盘至少52周高点98%计9分，否则0分；不附放量门槛，不使用细则分层。"
                : warning,
            ),
          }
        : diagnostic;
    const valid = current?.status === "computed";
    const previousPoints =
      previous?.status === "computed" ? previous.points : null;
    const point = {
      date: bar.date,
      entry: !!(
        valid &&
        previousPoints !== null &&
        previousPoints < minimum &&
        current.points >= minimum
      ),
      exit: false,
      reason: !valid
        ? "缺少有效完整52周价格窗口"
        : previousPoints === null
          ? "前一观察缺少有效52周评分，不能确认上穿"
          : null,
      values: { close: Number.isFinite(bar.close) ? bar.close : null },
      minimumPoints: minimum,
      previousDate: index ? bars[index - 1]!.date : null,
      previousPoints,
      diagnostic: current,
    };
    previous = current;
    return point;
  });
}
