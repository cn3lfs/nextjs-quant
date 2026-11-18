import type { Bar } from "trading-strategy-core/bars";
import type { GrowthPriceInput } from "../contracts/growth-price-input.js";
import {
  canslimHighPoints,
  type CanslimHighId,
} from "./research-canslim-strategies.js";
import { validGrowthPriceBar } from "./canslim-entry.js";
import { canslimNewHigh, formatCanslimNewHigh } from "./canslim-new-high.js";

export function researchCanslimHighSeries(
  id: CanslimHighId,
  bars: readonly Bar[],
) {
  const minimum = canslimHighPoints[id];
  const diagnostics =
    orderedHighDiagnostics(bars) ?? originalHighDiagnostics(bars);
  let previous: ReturnType<typeof canslimNewHigh> | null = null;
  return bars.map((bar, index) => {
    const diagnostic = diagnostics[index] ?? null;
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

const horizonMs = 364 * 86_400_000;

/** Same left-open 364-day window and inclusive validation anchor as the
 * original per-prefix diagnostic. Date and bar validation are done once. */
function orderedHighDiagnostics(bars: readonly Bar[]) {
  const times = bars.map((bar) => Date.parse(bar.date));
  if (
    bars.some((bar, index) => {
      const time = times[index]!;
      return (
        !Number.isFinite(time) ||
        new Date(time).toISOString().slice(0, 10) !== bar.date ||
        (index > 0 && time <= times[index - 1]!)
      );
    })
  )
    return null;

  const invalid = [0];
  for (const bar of bars)
    invalid.push(invalid.at(-1)! + Number(!validGrowthPriceBar(bar)));
  const highs: number[] = [];
  let anchor = 0;
  let head = 0;
  return bars.map((bar, index) => {
    const boundary = times[index]! - horizonMs;
    while (anchor < index && times[anchor + 1]! <= boundary) anchor++;
    while (head < highs.length && times[highs[head]!]! <= boundary) head++;
    while (head < highs.length && bars[highs.at(-1)!]!.high <= bar.high)
      highs.pop();
    highs.push(index);

    const valid =
      index - anchor + 1 >= 21 && invalid[index + 1] === invalid[anchor];
    const covered = valid && times[anchor]! <= boundary;
    const high = covered ? bars[highs[head]!]!.high : null;
    return formatCanslimNewHigh({
      asOf: valid ? bar.date : null,
      start: valid ? new Date(boundary).toISOString().slice(0, 10) : null,
      close: valid ? bar.close : null,
      high,
      covered,
      windowBars: covered ? index - anchor : 0,
      volumeConfirmed:
        high !== null && bar.close >= high
          ? bar.volume >=
            1.5 *
              bars
                .slice(index - 20, index)
                .reduce((sum, b) => sum + b.volume / 20, 0)
          : null,
      adjustment: "none",
    });
  });
}

function originalHighDiagnostics(bars: readonly Bar[]) {
  let left = 0;
  return bars.map((bar, index) => {
    const time = Date.parse(`${bar.date}T07:06:00Z`);
    const boundary = Date.parse(bar.date) - horizonMs;
    while (left < index && Date.parse(bars[left + 1]!.date) <= boundary) left++;
    if (!Number.isFinite(time)) return null;
    const snapshot: GrowthPriceInput = {
      id: "research-prefix",
      hash: "research-prefix",
      symbol: "research",
      period: "day",
      adjustment: "none",
      historicalAsOf: bar.date,
      bars: bars.slice(left, index + 1),
    };
    return canslimNewHigh(snapshot, time);
  });
}
