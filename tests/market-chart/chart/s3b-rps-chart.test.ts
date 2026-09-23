import { describe, expect, it } from "vitest";
import { rpsChartSegments, type RpsCurve } from "../../../src/lib/chart/chart-data";
import { chartViewSchema, defaultChartView } from "../../../src/lib/chart/chart-view";
const bars = Array.from({ length: 7 }, (_, i) => ({
  date: `2026-09-0${i + 1}`,
  open: 10,
  high: 11,
  low: 9,
  close: 10,
  volume: 100,
  amount: 1000,
}));
const curve: RpsCurve = [0, null, 80, undefined, 90, 0, 100].flatMap(
  (rps, i) =>
    rps === undefined
      ? []
      : [
          {
            date: bars[i]!.date,
            mode: i < 5 ? ("backfill" as const) : ("forward" as const),
            periods: [50],
            values: [rps === null ? null : { rps }],
          },
        ],
);
describe("S3b persisted RPS chart", () => {
  it("breaks null and missing dates, preserves isolated zero, and separates provenance", () => {
    expect(rpsChartSegments(bars, curve, "day", 50)).toEqual([
      { mode: "backfill", data: [{ time: bars[0]!.date, value: 0 }] },
      { mode: "backfill", data: [{ time: bars[2]!.date, value: 80 }] },
      { mode: "backfill", data: [{ time: bars[4]!.date, value: 90 }] },
      {
        mode: "forward",
        data: [
          { time: bars[5]!.date, value: 0 },
          { time: bars[6]!.date, value: 100 },
        ],
      },
    ]);
  });
  it.each(["week", "month", "5m"] as const)(
    "never projects daily RPS into %s",
    (period) => {
      expect(rpsChartSegments(bars, curve, period, 50)).toEqual([]);
    },
  );
  it("does not invent unavailable periods or empty observations", () => {
    expect(rpsChartSegments(bars, curve, "day", 250)).toEqual([]);
    expect(rpsChartSegments(bars, [], "day", 50)).toEqual([]);
    expect(rpsChartSegments(bars, curve, "day", 50, 6)).toEqual([
      { mode: "forward", data: [{ time: bars[6]!.date, value: 100 }] },
    ]);
  });
  it("loads old views with default windows and validates the reference range", () => {
    const { rps: _, ...old } = defaultChartView;
    expect(chartViewSchema.parse(old).rps).toEqual({
      periods: [50, 120, 250],
      threshold: 90,
    });
    expect(
      chartViewSchema.parse({
        ...old,
        subchart: ["rps"],
        rps: { periods: [5, 20], threshold: 0 },
      }).rps,
    ).toEqual({ periods: [5, 20], threshold: 0 });
    for (const threshold of [-1, 101, NaN])
      expect(
        chartViewSchema.safeParse({ ...old, rps: { periods: [50], threshold } })
          .success,
      ).toBe(false);
  });
});

it("wires persisted curves from the workspace and fixes the RPS pane range", async () => {
  const { readFileSync } = await import("node:fs");
  const workspace = readFileSync(
    "src/components/market/chart-workspace.tsx",
    "utf8",
  );
  expect(workspace).toContain("api.rpsCurve.useQuery(snapshot.symbol, {");
  expect(workspace).toMatch(
    /enabled: period === "day" && !isSectorChartSymbol\(snapshot.symbol\),\s*retry: false/,
  );
  expect(workspace).toContain('rps={period === "day" ? rps.data : undefined}');
  expect(workspace).toContain("onRpsRetry={() => void rps.refetch()}");
  const chart = readFileSync("src/components/market/chart.tsx", "utf8");
  expect(chart).toContain("rpsChartSegments(");
  expect(chart).toContain('lineStyle: segment.mode === "backfill" ? 2 : 0');
  expect(chart).toContain("pointMarkersVisible: segment.data.length === 1");
  expect(chart).toContain("priceRange: { minValue: 0, maxValue: 100 }");
  expect(chart).toContain("price: rpsOptions.threshold");
  expect(chart).toContain("RPS仅支持日线，当前周期不可用");
});
