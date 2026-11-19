import type { LimitObservation } from "~/server/market/limit-sentiment-observations";

/** 相邻观测超过 5 分钟视为显著缺口，折线断开。 */
export const INTRADAY_GAP_MS = 5 * 60_000;

export type IntradaySegment = {
  session: "morning" | "afternoon";
  points: LimitObservation[];
};

const sessionOf = (point: LimitObservation): "morning" | "afternoon" =>
  point.minute < "13:00" ? "morning" : "afternoon";

/**
 * 按本机记录时刻排序后分段：上午/下午必断，同一时段内相邻观测间隔超过
 * `gapMs` 也断开。孤立的单点仍保留，由图表以圆点显示。
 */
export function splitIntradaySegments(
  points: readonly LimitObservation[],
  gapMs = INTRADAY_GAP_MS,
): IntradaySegment[] {
  const sorted = [...points].sort(
    (left, right) =>
      left.at - right.at || left.minute.localeCompare(right.minute),
  );
  const segments: IntradaySegment[] = [];
  for (const point of sorted) {
    const session = sessionOf(point);
    const current = segments.at(-1);
    if (
      !current ||
      current.session !== session ||
      point.at - current.points.at(-1)!.at > gapMs
    ) {
      segments.push({ session, points: [point] });
    } else {
      current.points.push(point);
    }
  }
  return segments;
}
