import { describe, expect, it } from "vitest";
import { aggregateChartBars } from "../../../src/server/market/chart-aggregation";
import { chartTime } from "../../../src/lib/chart/chart-data";
import { mcpChartHistory } from "../../../src/server/market/chart-history";
const rows = (minutes: number[]) =>
  minutes.map((m, i) => ({
    date: `2026-09-11T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00+08:00`,
    open: 10 + i,
    high: 12 + i,
    low: 9 + i,
    close: 11 + i,
    volume: 100,
    amount: 1000,
  }));
const morning = Array.from({ length: 24 }, (_, i) => 575 + i * 5);
const afternoon = Array.from({ length: 24 }, (_, i) => 785 + i * 5);
describe("chart period aggregation", () => {
  it("aggregates 60m on both sides of lunch with exact OHLCV", () => {
    const result = aggregateChartBars(
      rows([...morning, ...afternoon]),
      "5m",
      "60m",
      Date.parse("2026-09-11T15:10:00+08:00"),
    );
    expect(result.bars.map((b) => b.date.slice(11, 16))).toEqual([
      "10:30",
      "11:30",
      "14:00",
      "15:00",
    ]);
    expect(result.bars[0]).toMatchObject({
      open: 10,
      high: 23,
      low: 9,
      close: 22,
      volume: 1200,
      amount: 12000,
    });
    expect(result.formingDates).toEqual([]);
  });
  it("rejects a historical bucket with an interior missing 5m bar", () => {
    const result = aggregateChartBars(
      rows(morning.filter((m) => m !== 580)),
      "5m",
      "15m",
      Date.parse("2026-09-11T12:00:00+08:00"),
    );
    expect(result.bars).toHaveLength(7);
    expect(result.excluded).toHaveLength(1);
  });
  it("keeps a forming prefix but rejects a missing opening bar", () => {
    const now = Date.parse("2026-09-11T09:41:00+08:00");
    expect(
      aggregateChartBars(rows([575, 580]), "5m", "15m", now).formingDates,
    ).toHaveLength(1);
    expect(aggregateChartBars(rows([580]), "5m", "15m", now).bars).toHaveLength(
      0,
    );
  });
  it("daily aggregation requires all 48 bars after close", () => {
    expect(
      aggregateChartBars(
        rows([...morning, ...afternoon]),
        "5m",
        "day",
        Date.parse("2026-09-11T15:10:00+08:00"),
      ).bars,
    ).toHaveLength(1);
    expect(
      aggregateChartBars(
        rows(morning),
        "5m",
        "day",
        Date.parse("2026-09-11T15:10:00+08:00"),
      ).bars,
    ).toHaveLength(0);
  });
  it("all minute chart timestamps use the same Chinese wall clock", () => {
    for (const period of ["5m", "15m", "30m", "60m"] as const)
      expect(chartTime("2026-09-11T14:30:00+08:00", period)).toBe(
        Date.parse("2026-09-11T14:30:00Z") / 1000,
      );
  });
  it("stops when a provider ignores the paging offset instead of claiming 2000 bars", async () => {
    let calls = 0;
    const page = Array.from({ length: 700 }, (_, i) => ({
      Data: Number(
        new Date(Date.UTC(2023, 0, 1 + i))
          .toISOString()
          .slice(0, 10)
          .replaceAll("-", ""),
      ),
      Open: 10,
      High: 12,
      Low: 9,
      Close: 11,
      RawVolume: 100,
      Amount: 1000,
    }));
    const result = await mcpChartHistory("sh000001", "day", 2000, async () => {
      calls++;
      return { Rows: page };
    });
    expect(calls).toBe(2);
    expect(result.bars).toHaveLength(700);
    expect(result.historyExhausted).toBe(true);
  });
});
import {
  rememberChartRange,
  restoreChartRange,
} from "../../../src/lib/chart/chart-viewport";
import { normalizeChartMcpPage } from "../../../src/server/market/chart-history";
it("preserves visible dates when older bars are prepended and across period switches", () => {
  const bars = rows(morning);
  rememberChartRange("sh600000:5m", bars, 0, { from: 2.5, to: 10.5 });
  const earlier = rows(morning).map((b) => ({
    ...b,
    date: b.date.replace("2026-09-11", "2026-09-10"),
  }));
  const restored = restoreChartRange("sh600000:5m", [...earlier, ...bars]);
  expect(restored).toEqual({ start: 0, range: { from: 26.5, to: 34.5 } });
  expect(restoreChartRange("sh600000:15m", bars)).toBeNull();
});
it("normalizes the verified MCP lunch closing label and rejects collisions", () => {
  const row = {
    Data: "20260911",
    Second: 46800,
    Open: 10,
    High: 12,
    Low: 9,
    Close: 11,
    RawVolume: 100,
    Amount: 1000,
  };
  expect(normalizeChartMcpPage({ Rows: [row] }, "60m")[0]?.date).toBe(
    "2026-09-11T11:30:00+08:00",
  );
  expect(() =>
    normalizeChartMcpPage({ Rows: [{ ...row, Second: 41400 }, row] }, "60m"),
  ).toThrow("冲突");
});
