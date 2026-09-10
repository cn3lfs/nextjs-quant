import { expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Snapshot } from "../src/lib/domain";
import { monthlyBars } from "../src/server/monthly-bars";
import { weeklyBars } from "../src/server/weekly-bars";
import { ChartViewStore } from "../src/server/chart-view-store";
import { migrate } from "../src/server/db/migrations";
import {
  chartCost,
  chartViewSchema,
  defaultChartView,
  defaultParameters,
  indicatorLabel,
  keyboardRange,
  structureAvailability,
} from "../src/lib/chart-view";
import { chartIndicators, chartTime } from "../src/lib/chart-data";
import { ma, macd, kdj, rsi, boll } from "../src/lib/indicators";
import { drawingSegments } from "../src/lib/chart-drawings";
function source(first = "2026-07-01", last = "2026-09-10"): Snapshot {
  const bars: Snapshot["bars"] = [];
  for (let t = Date.parse(first); t <= Date.parse(last); t += 86400000) {
    const d = new Date(t);
    if ([0, 6].includes(d.getUTCDay())) continue;
    const i = bars.length;
    bars.push({
      date: d.toISOString().slice(0, 10),
      open: 20 + i,
      close: 21 + i,
      high: 22 + i,
      low: 19 + i,
      volume: i + 1,
      amount: 100,
    });
  }
  return {
    id: "q1-fixture",
    symbol: "sh600519",
    source: "controlled",
    hash: "fixture",
    createdAt: 0,
    adjustment: "none",
    period: "day",
    bars,
  };
}
it("monthly cutoff across months: exclude unfinished month, exact 15:05 boundary and historical cutoff; OHLC sums", () => {
  const s = source(),
    calendar = {
      days: s.bars.map((b) => b.date),
      hash: "controlled",
      source: "fixture",
    },
    now = Date.parse("2026-08-31T15:05:00+08:00"),
    copy = structuredClone(s);
  const before = monthlyBars(s, calendar, now - 1),
    after = monthlyBars(s, calendar, now);
  expect(before.bars.map((b) => b.date)).toEqual(["2026-07-31"]);
  expect(after.bars.map((b) => b.date)).toEqual(["2026-07-31", "2026-08-31"]);
  const august = s.bars.filter((b) => b.date.startsWith("2026-08"));
  expect(after.bars[1]).toEqual({
    date: "2026-08-31",
    open: august[0]!.open,
    close: august.at(-1)!.close,
    high: august.at(-1)!.high,
    low: august[0]!.low,
    volume: august.reduce((a, b) => a + b.volume, 0),
    amount: 2100,
  });
  expect(
    monthlyBars({ ...s, historicalAsOf: "2026-08-28" }, calendar, now).bars,
  ).toEqual(before.bars);
  expect(s).toEqual(copy);
  expect(monthlyBars(s, calendar, now)).toEqual(after);
});
it("monthly calendar is strict: unknown, missing, conflict, confirmed holiday, empty and malformed", () => {
  const s = source("2026-08-01", "2026-08-31"),
    days = s.bars.map((b) => b.date),
    now = Date.parse("2026-09-01"),
    calendar = { days, hash: "x", source: "x" };
  const missing = { ...s, bars: s.bars.slice(1) };
  expect(monthlyBars(missing, calendar, now).excluded[0]?.reason).toBe(
    "missing-days",
  );
  expect(
    monthlyBars(missing, { ...calendar, days: days.slice(1) }, now).excluded[0]
      ?.reason,
  ).toBe("calendar-unknown");
  expect(
    monthlyBars(
      missing,
      { ...calendar, days: days.slice(1), closedDays: [days[0]!] },
      now,
    ).bars,
  ).toHaveLength(1);
  expect(
    monthlyBars(
      s,
      { ...calendar, days: days.slice(1), closedDays: [days[0]!] },
      now,
    ).excluded[0]?.reason,
  ).toBe("calendar-conflict");
  expect(() =>
    monthlyBars({ ...s, bars: [s.bars[1]!, s.bars[0]!] }, calendar, now),
  ).toThrow();
  expect(monthlyBars({ ...s, bars: [] }, calendar, now).bars).toEqual([]);
});
it("weekly chart reuses completion semantics across week/year boundaries", () => {
  const s = source("2025-12-29", "2026-01-09"),
    calendar = { days: s.bars.map((b) => b.date), hash: "x", source: "x" };
  expect(
    weeklyBars(s, calendar, Date.parse("2026-01-09T15:04:59+08:00")).bars.map(
      (b) => b.date,
    ),
  ).toEqual(["2026-01-02"]);
  expect(
    weeklyBars(s, calendar, Date.parse("2026-01-09T15:05:00+08:00")).bars.map(
      (b) => b.date,
    ),
  ).toEqual(["2026-01-02", "2026-01-09"]);
  expect(chartTime("2026-01-02", "week")).toBe("2026-01-02");
});
it("incremental migration preserves existing tables and durable view edits/deletes are isolated by symbol AND period", () => {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO records VALUES(?,?,?,?)").run(
    "preserved",
    "fixture",
    "{}",
    1,
  );
  const store = new ChartViewStore(db),
    key = { symbol: "sh600519", period: "week" };
  const view = structuredClone(defaultChartView);
  view.dark = true;
  view.parameters.macd = [3, 8, 2];
  view.drawings = [
    {
      id: crypto.randomUUID(),
      kind: "rectangle",
      a: { date: "2026-07-03", price: 20 },
      b: { date: "2026-07-10", price: 30 },
      color: "#2563eb",
    },
  ];
  store.save({ ...key, view });
  migrate(db);
  expect(new ChartViewStore(db).read(key)).toEqual(view);
  expect(store.read({ ...key, period: "month" })).toEqual(defaultChartView);
  expect(store.read({ ...key, symbol: "sz000001" })).toEqual(defaultChartView);
  view.drawings[0]!.a.price = 22;
  store.save({ ...key, view });
  expect(store.read(key).drawings[0]!.a.price).toBe(22);
  view.drawings = [];
  store.save({ ...key, view });
  expect(store.read(key).drawings).toEqual([]);
  expect(db.prepare("SELECT id FROM records").get()).toEqual({
    id: "preserved",
  });
  expect(() =>
    store.save({
      ...key,
      view: {
        ...view,
        parameters: { ...view.parameters, ma: [0, 10, 20, 60] },
      },
    }),
  ).toThrow();
  db.close();
});
it("all adjustable chart reads call the shared indicator functions with unchanged default strategy results", () => {
  const bars = source().bars,
    p = {
      ma: [2, 4, 6, 8],
      macd: [3, 7, 2],
      kdj: [4, 2, 5],
      rsi: [2, 5, 8],
      boll: [4, 1.5],
    } as typeof defaultParameters,
    v = chartIndicators(bars, p);
  expect(v.MA5).toEqual(ma(bars, 2));
  expect(v.MA60).toEqual(ma(bars, 8));
  expect(v.DIF).toEqual(macd(bars, 3, 7, 2).map((x) => x.dif));
  expect(v.MACD).toEqual(macd(bars, 3, 7, 2).map((x) => x.macd));
  expect(v.K).toEqual(kdj(bars, 4, 2, 5).map((x) => x.k));
  expect(v.D).toEqual(kdj(bars, 4, 2, 5).map((x) => x.d));
  expect(v.RSI12).toEqual(rsi(bars, [2, 5, 8]).map((x) => x.rsi12));
  expect(v.BOLL上).toEqual(boll(bars, 4, 1.5).map((x) => x.upper));
  expect(macd(bars)).toEqual(macd(bars, ...defaultParameters.macd));
  expect(kdj(bars)).toEqual(kdj(bars, ...defaultParameters.kdj));
  expect(rsi(bars)).toEqual(rsi(bars, defaultParameters.rsi));
  expect(indicatorLabel("MA5", p)).toBe("MA2");
  expect(indicatorLabel("RSI24", p)).toBe("RSI8");
});
it("custom periods have independently hand-computed values, warmup and validation", () => {
  const bars = [10, 12, 11].map((close, i) => ({
    date: `2026-01-0${i + 1}`,
    open: close,
    close,
    high: close + 1,
    low: close - 1,
    volume: 1,
    amount: 1,
  }));
  // EMA2 second=34/3, EMA3 second=11, DIF=1/3; signal EMA2=2/9; histogram=2/9.
  expect(macd(bars, 2, 3, 2)[1]!.macd).toBeCloseTo(2 / 9, 12);
  // RSV2 at bar1=(12-9)/(13-9)*100=75; K and D seed at 75.
  expect(kdj(bars, 2, 2, 4)[0]!.k).toBeNull();
  expect(kdj(bars, 2, 2, 4)[1]!.k).toBe(75);
  // RSI2 gains [2,0] smooth to 1, abs [2,1] smooth to 1.5 -> 200/3.
  expect(rsi(bars, [2, 3, 4])[2]!.rsi6).toBeCloseTo(200 / 3, 12);
  expect(() => macd(bars, 0, 3, 2)).toThrow();
  expect(() => kdj(bars, 2, 0, 4)).toThrow();
  expect(() => rsi(bars, [2, NaN, 4])).toThrow();
});
it("drawing geometry for four tools uses anchors; fib is arithmetic price retracement even on log coordinates", () => {
  const d = {
    id: crypto.randomUUID(),
    kind: "trend" as const,
    a: { date: "2026-07-03", price: 100 },
    b: { date: "2026-07-10", price: 200 },
    color: "#2563eb",
  };
  expect(drawingSegments(d)[0]).toMatchObject({ a: d.a, b: d.b });
  expect(drawingSegments({ ...d, kind: "horizontal" })[0]!.b.price).toBe(100);
  expect(drawingSegments({ ...d, kind: "rectangle" })[0]).toMatchObject({
    a: d.a,
    b: d.b,
  });
  drawingSegments({ ...d, kind: "fibonacci" }).forEach((s, i) =>
    expect(s.a.price).toBeCloseTo(
      [100, 123.6, 138.2, 150, 161.8, 178.6, 200][i]!,
      10,
    ),
  );
});
it("log/theme settings survive validation; keyboard center/zoom and cost/no-position semantics; new-cycle structures unavailable", () => {
  expect(
    chartViewSchema.parse({
      ...defaultChartView,
      logarithmic: true,
      dark: true,
    }),
  ).toMatchObject({ logarithmic: true, dark: true });
  expect(keyboardRange({ from: 0, to: 100 }, "ArrowLeft")).toEqual({
    from: -10,
    to: 90,
  });
  expect(keyboardRange({ from: 0, to: 100 }, "ArrowRight")).toEqual({
    from: 10,
    to: 110,
  });
  expect(keyboardRange({ from: 0, to: 100 }, "ArrowUp")).toEqual({
    from: 10,
    to: 90,
  });
  expect(keyboardRange({ from: 0, to: 100 }, "ArrowDown")).toEqual({
    from: -12.5,
    to: 112.5,
  });
  expect(keyboardRange({ from: 0, to: 100 }, "a")).toBeNull();
  expect(chartCost(undefined)).toBeNull();
  expect(chartCost({ quantity: 0, adjustedCost: 10 })).toBeNull();
  expect(chartCost({ quantity: 100, adjustedCost: 10 })).toBe(10);
  for (const p of ["week", "month"] as const)
    expect(structureAvailability(p)).toEqual({ czsc: false, breakout: false });
});
