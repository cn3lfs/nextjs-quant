import type { UTCTimestamp } from "lightweight-charts";
import { chartTime } from "./chart-data";

/** One trading day of TDX minute points (index i = the i-th trading minute). */
export type IntradayDay = {
  date: string;
  /** Previous close: the day's percent and colour baseline. */
  preClose: number;
  points: readonly { price: number; volume: number }[];
};
export type IntradayRow = {
  time: UTCTimestamp;
  date: string;
  /** HH:MM Beijing wall time of the minute's close. */
  clock: string;
  price: number;
  /** Cumulative volume-weighted average price of the day. */
  average: number;
  volume: number;
  /** Price change vs the previous minute (first minute: vs preClose). */
  direction: 1 | -1 | 0;
  preClose: number;
};

/** A-share continuous-trading minutes, stamped at each minute's close as TDX
 * does: 09:31–11:30 and 13:01–15:00, 240 slots per day. */
export const intradayClocks: readonly string[] = [
  ...Array.from({ length: 120 }, (_, i) => 9 * 60 + 31 + i),
  ...Array.from({ length: 120 }, (_, i) => 13 * 60 + 1 + i),
].map(
  (m) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
);

const slotTime = (date: string, clock: string) =>
  chartTime(`${date}T${clock}:00+08:00`, "5m") as UTCTimestamp;

/**
 * Chart rows for consecutive days, oldest first. The average line is
 * cumulative Σ(price×volume)/Σvolume per day — TDX's 均价 is amount/volume;
 * minute points carry no amount, so this is the volume-weighted price
 * approximation. Minutes beyond the returned points are left as whitespace
 * so the last day's time axis always spans the full session.
 */
export function intradayRows(days: readonly IntradayDay[]) {
  const rows: IntradayRow[] = [];
  const whitespace: { time: UTCTimestamp }[] = [];
  days.forEach((day, d) => {
    let amount = 0,
      volume = 0,
      previous = day.preClose;
    day.points.slice(0, intradayClocks.length).forEach((point, i) => {
      amount += point.price * point.volume;
      volume += point.volume;
      const clock = intradayClocks[i]!;
      rows.push({
        time: slotTime(day.date, clock),
        date: day.date,
        clock,
        price: point.price,
        average: volume > 0 ? amount / volume : point.price,
        volume: point.volume,
        direction: point.price > previous ? 1 : point.price < previous ? -1 : 0,
        preClose: day.preClose,
      });
      previous = point.price;
    });
    if (d === days.length - 1)
      for (const clock of intradayClocks.slice(day.points.length))
        whitespace.push({ time: slotTime(day.date, clock) });
  });
  return { rows, whitespace };
}

/**
 * Which trading day the live TDX minutes belong to. The minute and quote
 * responses carry no date, and the session clock has no holiday calendar
 * (a weekday holiday still looks like trading hours), so the day is derived
 * from data instead: the live previous close must equal the close of the
 * previous trading day's daily bar. The bar after that one, when present, is
 * the live day; otherwise the daily bars end before the live day and today's
 * date is used but marked unverified. Earlier days are the bars up to and
 * including the matched previous day.
 */
export function liveIntradayDay(
  bars: readonly { date: string; close: number }[],
  preClose: number | null | undefined,
  today: string,
) {
  const day = (i: number) => bars[i]!.date.slice(0, 10);
  if (preClose && preClose > 0)
    // Only the latest few bars are plausible previous days.
    for (let i = bars.length - 1; i >= Math.max(0, bars.length - 5); i--)
      if (Math.abs(bars[i]!.close - preClose) <= preClose * 1e-6)
        return i + 1 < bars.length
          ? { date: day(i + 1), verified: true, previous: i }
          : { date: today, verified: false, previous: i };
  return { date: today, verified: false, previous: bars.length - 1 };
}

/** Symmetric price range around the (latest) previous close, as TDX draws
 * 分时: the percent axis is then centred on 0. Never narrower than ±1%. */
export function intradayRange(rows: readonly IntradayRow[], preClose: number) {
  let deviation = preClose * 0.01;
  for (const row of rows)
    deviation = Math.max(
      deviation,
      Math.abs(row.price - preClose),
      Math.abs(row.average - preClose),
    );
  return {
    minValue: preClose - deviation,
    maxValue: preClose + deviation,
    percent: (deviation / preClose) * 100,
  };
}
