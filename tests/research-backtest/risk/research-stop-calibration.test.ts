import { expect, it } from "vitest";
import {
  indicatorRespect,
  indicatorStopLines,
} from "trading-strategies/research/risk/research-stop-calibration";
import type { Bar } from "../../../src/lib/domain";
const bars: Bar[] = Array.from({ length: 190 }, (_, i) => ({
  date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 100000,
  amount: 10000000,
}));
const calendar = bars.map((b) => b.date);
it.each(indicatorStopLines.filter((id) => id !== "rk-sar"))(
  "%s along-line test excludes signal-day and future bars",
  (line) => {
    const date = calendar[180]!;
    const result = indicatorRespect(bars, calendar, date, line);
    expect(result).toEqual({
      allow: true,
      touches: 60,
      holds: 60,
      reason: null,
    });
    const future = bars.map((b, i) =>
      i >= 180 ? { ...b, low: 1, close: 1000, high: 1001 } : b,
    );
    expect(indicatorRespect(future, calendar, date, line)).toEqual(result);
    expect(
      indicatorRespect(
        bars.filter((_, i) => i !== 160),
        calendar,
        date,
        line,
      ).allow,
    ).toBe(false);
    expect(
      indicatorRespect(
        bars.map((b) => ({ ...b, low: 95 })),
        calendar,
        date,
        line,
      ).allow,
    ).toBe(false);
  },
);
