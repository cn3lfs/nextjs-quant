import { describe, expect, it } from "vitest";
import type { Bar } from "../../../src/lib/domain";
import {
  bias,
  cci,
  williams,
} from "../../../src/lib/chart/chart-extra-indicators";
import {
  chartViewSchema,
  defaultChartView,
  indicatorLabel,
  parameterSummary,
} from "../../../src/lib/chart/chart-view";
import { enabledIndicators } from "../../../src/lib/chart/chart-data";

const bar = (high: number, low: number, close: number): Bar =>
  ({
    date: "2026-01-01",
    open: close,
    high,
    low,
    close,
    volume: 100,
    amount: 0,
  }) as Bar;

describe("chart extra indicators (TDX formulas)", () => {
  const bars = [bar(10, 8, 9), bar(12, 9, 11), bar(13, 10, 10)];
  it("WR = 100 × (HHV − C) / (HHV − LLV) over complete windows", () => {
    expect(williams(bars, 2)).toEqual([null, 25, (100 * 3) / 4]);
  });
  it("BIAS = (C − MA) / MA × 100", () => {
    expect(bias(bars, 2)).toEqual([null, 10, (-0.5 / 10.5) * 100]);
  });
  it("CCI uses mean absolute deviation of the typical price", () => {
    // TYP = 9, 32/3, 11 → window 2 at i=1: mean 59/6, dev 5/6
    const value = cci(bars, 2)[1]!;
    expect(value).toBeCloseTo((32 / 3 - 59 / 6) / (0.015 * (5 / 6)), 10);
    expect(cci(bars, 2)[0]).toBeNull();
    expect(cci([bar(1, 1, 1), bar(1, 1, 1)], 2)[1]).toBeNull();
  });
});

describe("chart view compatibility", () => {
  it("fills new indicator parameters for views saved before they existed", () => {
    const { ema: _e, wr: _w, bias: _b, cci: _c, ...legacy } =
      defaultChartView.parameters;
    const view = chartViewSchema.parse({
      ...defaultChartView,
      parameters: legacy,
    });
    expect(view.parameters).toEqual(defaultChartView.parameters);
  });
  it("labels numbered lines and parameter groups from current parameters", () => {
    const p = { ...defaultChartView.parameters, wr: [14, 7] as [number, number] };
    expect(indicatorLabel("WR1", p)).toBe("WR14");
    expect(indicatorLabel("EMA3", p)).toBe("EMA50");
    expect(parameterSummary("wr", p)).toBe("WR(14,7)");
  });
  it("routes new indicators through the enabled list", () => {
    expect(enabledIndicators(["ema"], ["wr", "cci", "obv"])).toEqual([
      "EMA1",
      "EMA2",
      "EMA3",
      "WR1",
      "WR2",
      "CCI",
      "OBV",
    ]);
  });
});
