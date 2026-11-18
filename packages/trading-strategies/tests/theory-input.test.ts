import { describe, expect, it } from "vitest";
import {
  areDailyDatesStrictlyAscending,
  dailyBarEpoch,
  isValidOhlc,
} from "../src/theory-input.js";

describe("dailyBarEpoch", () => {
  it("returns UTC midnight for real calendar days, including leap day", () => {
    expect(dailyBarEpoch("1970-01-01")).toBe(0);
    expect(dailyBarEpoch("2023-12-31")).toBe(1703980800000);
    expect(dailyBarEpoch("2024-01-01")).toBe(1704067200000);
    expect(dailyBarEpoch("2024-02-29")).toBe(1709164800000);
  });

  it("rejects rollover dates, impossible months and timestamps", () => {
    expect(dailyBarEpoch("2023-02-29")).toBeNull();
    expect(dailyBarEpoch("2024-02-30")).toBeNull();
    expect(dailyBarEpoch("2024-04-31")).toBeNull();
    expect(dailyBarEpoch("2024-13-01")).toBeNull();
    expect(dailyBarEpoch("2024-1-01")).toBeNull();
    expect(dailyBarEpoch("2024-01-01T00:00:00Z")).toBeNull();
    expect(dailyBarEpoch(20240101)).toBeNull();
    expect(dailyBarEpoch(new Date(Date.UTC(2024, 0, 1)))).toBeNull();
  });
});

describe("areDailyDatesStrictlyAscending", () => {
  it("accepts a nonempty ascending run across month and year boundaries", () => {
    expect(areDailyDatesStrictlyAscending(["2024-02-29"])).toBe(true);
    expect(
      areDailyDatesStrictlyAscending([
        "2023-12-30",
        "2023-12-31",
        "2024-01-01",
      ]),
    ).toBe(true);
  });

  it("rejects empty, duplicate, descending and invalid labels", () => {
    expect(areDailyDatesStrictlyAscending([])).toBe(false);
    expect(areDailyDatesStrictlyAscending(["2024-01-02", "2024-01-02"])).toBe(
      false,
    );
    expect(areDailyDatesStrictlyAscending(["2024-01-02", "2024-01-01"])).toBe(
      false,
    );
    expect(areDailyDatesStrictlyAscending(["2024-01-01", "2024-02-30"])).toBe(
      false,
    );
  });
});

describe("isValidOhlc", () => {
  it("accepts finite positive prices with low<=open/close<=high and no volume", () => {
    expect(isValidOhlc({ open: 10, high: 11, low: 9, close: 10.5 })).toBe(true);
    expect(isValidOhlc({ open: 9, high: 11, low: 9, close: 11 })).toBe(true);
    expect(
      isValidOhlc({ open: 10, high: 11, low: 9, close: 10.5, volume: 0 }),
    ).toBe(true);
  });

  it("rejects non-finite, non-positive, misordered or incomplete prices", () => {
    expect(isValidOhlc({ open: 0, high: 11, low: 9, close: 10 })).toBe(false);
    expect(isValidOhlc({ open: 10, high: -1, low: -2, close: -1 })).toBe(false);
    expect(isValidOhlc({ open: Number.NaN, high: 11, low: 9, close: 10 })).toBe(
      false,
    );
    expect(
      isValidOhlc({
        open: 10,
        high: Number.POSITIVE_INFINITY,
        low: 9,
        close: 10,
      }),
    ).toBe(false);
    expect(isValidOhlc({ open: 12, high: 11, low: 9, close: 10.5 })).toBe(
      false,
    );
    expect(isValidOhlc({ open: 10, high: 11, low: 9, close: 8.5 })).toBe(false);
    expect(isValidOhlc({ open: 10, high: 8, low: 9, close: 10 })).toBe(false);
    expect(isValidOhlc({ open: 10, high: 11, low: 9 })).toBe(false);
    expect(isValidOhlc({ open: "10", high: 11, low: 9, close: 10 })).toBe(
      false,
    );
    expect(isValidOhlc(null)).toBe(false);
  });
});
