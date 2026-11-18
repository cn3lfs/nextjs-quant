/** Portfolio replay is ordered by completed bar. Performance consumes one
 * closing observation per labelled market day, never each intraday mark as a day. */
export function dailyEquity(
  points: readonly { date: string; equity: number }[],
) {
  const days = new Map<string, { date: string; value: number }>();
  let previous = -Infinity;
  for (const point of points) {
    const time = Date.parse(point.date);
    if (
      !Number.isFinite(time) ||
      time <= previous ||
      !Number.isFinite(point.equity) ||
      point.equity < 0
    )
      throw new Error("Invalid ordered equity observations");
    previous = time;
    // UTC intraday candles are end-labelled: midnight closes the preceding day.
    const utcMidnight = /T00:00:00(?:\.000)?(?:Z|\+00:00)$/.test(point.date);
    const date = utcMidnight
      ? new Date(time - 1).toISOString().slice(0, 10)
      : point.date.slice(0, 10);
    days.set(date, { date, value: point.equity });
  }
  return [...days.values()];
}
