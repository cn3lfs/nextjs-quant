import { describe, expect, it } from "vitest";
import { historicalLowSeries, type LowZoneFact } from "trading-strategies";
import { historicalLowSeries as reference } from "../helpers/historical-low-reference";

describe("full-history low-zone window indexing", () => {
  it("matches every original numeric field, reason and confidence across ties, gaps, leap years and expiring facts", () => {
    const bars = Array.from({ length: 4200 }, (_, i) => {
      const date = new Date(Date.UTC(2008, 0, 1 + i + Math.floor(i / 7) * 2))
        .toISOString()
        .slice(0, 10);
      const close = 20 + (i % 23) + Math.round(6 * Math.sin(i / 17));
      return {
        date,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
        amount: 1000 * close,
      };
    });
    const facts: LowZoneFact[] = bars
      .filter((_, i) => i % 11 !== 0)
      .map<LowZoneFact>((b, i) => ({
        date: b.date,
        availableAt: b.date,
        pe: i % 5 === 0 ? null : i % 19,
        pb: i % 13 === 0 ? -1 : 1 + (i % 7),
        temperature: i % 17 === 0 ? null : i % 100,
        confidence: i % 9 ? "verified" : "approximate",
        source: "QA sparse PIT facts",
      }))
      .reverse();
    const expected = reference(bars, {}, facts);
    const actual = historicalLowSeries(bars, {}, facts);
    expect(actual).toEqual(expected);
    const future = {
      ...bars.at(-1)!,
      date: "2030-01-01",
      close: 0.01,
      open: 0.01,
      high: 1,
      low: 0.01,
    };
    expect(
      historicalLowSeries([...bars, future], {}, [
        ...facts,
        {
          date: future.date,
          availableAt: future.date,
          pe: 0.001,
          pb: 0.001,
          temperature: 0,
          confidence: "verified",
          source: "Future negative control",
        },
      ]).slice(0, -1),
    ).toEqual(actual);
  });
});
