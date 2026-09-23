import { expect, it } from "vitest";
import { TickMarkType } from "lightweight-charts";
import { chartTime } from "../../../src/lib/chart/chart-data";
import {
  chineseChartLocalization,
  chineseTickMark,
} from "../../../src/lib/chart/chart-localization";

it("shows Chinese axis abbreviations and 24-hour Shanghai crosshair time without double timezone shifting", () => {
  const time = chartTime("2026-09-11T06:35:00.000Z", "5m");
  expect(chineseChartLocalization.timeFormatter(time)).toBe("2026-09-11 14:35");
  expect(chineseTickMark(time, TickMarkType.Time)).toBe("14:35");
  expect(chineseTickMark("2026-09-11", TickMarkType.Month)).toBe("9月");
  expect(chineseTickMark("2026-09-11", TickMarkType.DayOfMonth)).toBe("11日");
  expect(
    chineseTickMark({ year: 2026, month: 9, day: 11 }, TickMarkType.Year),
  ).toBe("2026年");
});
