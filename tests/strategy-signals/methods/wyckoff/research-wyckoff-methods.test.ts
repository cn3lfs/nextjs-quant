import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { Bar } from "../../../../src/lib/domain";
import type { WyckoffHourlyInput } from "trading-strategies/research/wyckoff/research-wyckoff-hourly";
import {
  wyckoffScore,
  researchWyckoffSeries,
  type WyckoffStructureInput,
} from "trading-strategies/research/wyckoff/research-wyckoff";
import { researchWyckoffStructureSeries as series } from "../../../../src/server/strategies/shared/research-structure-weekly";

it("WY19 rejects a pre-breakout range invalidated by an extreme close", () => {
  const bars = jac();
  bars[80]!.close = 200;
  expect(researchWyckoffSeries("wy-target-width", bars).at(-1)!.entry).toBe(
    false,
  );
});

function fixture(): Bar[] {
  const anchors = [
    [0, 80],
    [40, 95],
    [50, 100],
    [60, 104],
    [65, 96],
    [70, 104],
    [75, 96],
    [80, 104],
    [85, 96],
    [89, 102],
  ];
  return Array.from({ length: 90 }, (_, i) => {
    const r = anchors.findIndex((a) => a[0]! >= i),
      a = anchors[Math.max(0, r - 1)]!,
      b = anchors[r]!;
    const close =
      a[1]! + ((b[1]! - a[1]!) * (i - a[0]!)) / Math.max(1, b[0]! - a[0]!);
    return {
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: close - 0.1,
      close,
      high: close + 0.5,
      low: close - 0.5,
      volume: 100,
      amount: close * 100,
    };
  });
}
function append(bars: Bar[], row: Partial<Bar>) {
  const i = bars.length;
  bars.push({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: 105,
    close: 105.2,
    high: 105.5,
    low: 104.5,
    volume: 100,
    amount: 10500,
    ...row,
  });
  return bars;
}
function jac() {
  const bars = fixture();
  append(bars, { open: 102, low: 102, high: 106, close: 105.5, volume: 150 });
  append(bars, { open: 105.2, low: 104.5, high: 105.8, close: 105.6 });
  return bars;
}
function aggregate(b: Bar, h: Bar[]) {
  Object.assign(b, {
    open: h[0]!.open,
    close: h[3]!.close,
    high: Math.max(...h.map((x) => x.high)),
    low: Math.min(...h.map((x) => x.low)),
    volume: h.reduce((a, x) => a + x.volume, 0),
    amount: h.reduce((a, x) => a + x.amount, 0),
  });
}
function hourlyFixture() {
  const days: string[] = [];
  for (let t = Date.UTC(2020, 0, 1); days.length < 100; t += 86400000) {
    const d = new Date(t);
    if (![0, 6].includes(d.getUTCDay()))
      days.push(d.toISOString().slice(0, 10));
  }
  const anchors = [
    [0, 80],
    [40, 95],
    [50, 100],
    [60, 104],
    [65, 96],
    [70, 104],
    [75, 96],
    [80, 104],
    [85, 96],
    [89, 102],
    [99, 102],
  ];
  const bars: Bar[] = days.map((date, i) => {
    const r = anchors.findIndex((a) => a[0]! >= i),
      a = anchors[Math.max(0, r - 1)]!,
      b = anchors[r]!;
    const close =
      a[1]! + ((b[1]! - a[1]!) * (i - a[0]!)) / Math.max(1, b[0]! - a[0]!);
    return {
      date,
      open: close - 0.1,
      close,
      high: close + 0.5,
      low: close - 0.5,
      volume: 100,
      amount: close * 100,
    };
  });
  const all = bars.flatMap((b) =>
    ["10:30", "11:30", "14:00", "15:00"].map((time) => ({
      ...b,
      date: `${b.date}T${time}:00+08:00`,
      volume: b.volume / 4,
      amount: b.amount / 4,
    })),
  );
  Object.assign(all[90 * 4]!, {
    open: 96,
    close: 95.6,
    low: 95,
    high: 96.2,
    volume: 12.5,
  });
  Object.assign(all[90 * 4 + 1]!, {
    open: 95.6,
    close: 97,
    low: 95.2,
    high: 97.2,
    volume: 37.5,
  });
  Object.assign(all[92 * 4]!, {
    open: 104,
    close: 104.6,
    low: 103.8,
    high: 105,
    volume: 25,
  });
  Object.assign(all[92 * 4 + 1]!, {
    open: 104.6,
    close: 103,
    low: 102.8,
    high: 104.8,
    volume: 37.5,
  });
  for (let i = 90; i < bars.length; i++)
    aggregate(bars[i]!, all.slice(i * 4, i * 4 + 4));
  const inputs: WyckoffHourlyInput[] = days.slice(85).map((date) => {
    const i = days.indexOf(date);
    return {
      symbol: "sh600000",
      date,
      source: "fixed/hourlyBars",
      availableAt: `${date}T15:00:00+08:00`,
      adjustment: "none",
      hours: all.slice((i - 5) * 4, (i + 1) * 4),
    };
  });
  return { bars, days, inputs };
}

function raw(bars: Bar[], i = bars.length - 1): WyckoffStructureInput {
  const date = bars[i]!.date;
  const stock = {
    id: "stock-fixture",
    symbol: "sh600000",
    period: "day" as const,
    source: "fixture",
    hash: "fixture",
    adjustment: "none" as const,
    createdAt: 0,
    bars: structuredClone(bars.slice(0, i + 1)),
  };
  return {
    symbol: stock.symbol,
    date,
    source: "fixture",
    availableAt: `${date}T15:00:00+08:00`,
    stock,
    calendar: {
      days: bars.map((b) => b.date),
      closedDays: [],
      source: "fixture",
      hash: "calendar-fixture",
      availableAt: "2018-01-01T00:00:00+08:00",
    },
    benchmarks: (["industry", "market"] as const).map((role, j) => ({
      snapshot: {
        ...stock,
        id: role,
        symbol: j ? "sh000300" : "sh000001",
        bars: stock.bars.map((b) => ({
          ...b,
          open: 100,
          close: 100,
          high: 101,
          low: 99,
        })),
      },
      identity: {
        role,
        stock: stock.symbol,
        benchmark: j ? "sh000300" : "sh000001",
        name: role,
        source: "fixture-history",
        effectiveFrom: bars[0]!.date,
        effectiveTo: date,
        availableAt: "2018-01-01T00:00:00+08:00",
        capturedAt: "2018-01-01T00:00:00+08:00",
      },
      availableAt: `${date}T15:00:00+08:00`,
    })),
    assessment: {
      phase: "accumulation",
      quality: "single",
      tr: 70,
      vsa: 70,
      mtf: 70,
      rs: 70,
      market: 70,
      source: "fixed-historical-assessment",
      availableAt: `${date}T15:00:00+08:00`,
    },
  };
}
it("WY20 weighted stage scores preserve source hypotheses and exact 70 threshold; distribution and late assessments veto", () => {
  const bars = jac(),
    days = bars.map((b) => b.date),
    r = raw(bars);
  expect(wyckoffScore(r.assessment)).toMatchObject({
    value: 70,
    assumedWinRate: 0.48,
    probabilitySource: "原方法假设，非实测胜率",
  });
  expect(
    series("wy-score-half-kelly", bars, days, "sh600000", [r]).at(-1)!.entry,
  ).toBe(true);
  // Complete old output, including original point/target/evidence order, frozen before extraction.
  expect(
    createHash("sha256")
      .update(
        JSON.stringify(
          series("wy-score-half-kelly", bars, days, "sh600000", [r]).at(-1),
        ),
      )
      .digest("hex"),
  ).toBe("d3801b2f48dbdbf96a1f8c9d45d23d544793aa60825cae23c5a42b47e75b5452");
  for (const mutate of [
    (a: NonNullable<WyckoffStructureInput["assessment"]>) => {
      a.tr = 69.99;
    },
    (a: NonNullable<WyckoffStructureInput["assessment"]>) => {
      a.phase = "distribution";
    },
    (a: NonNullable<WyckoffStructureInput["assessment"]>) => {
      a.availableAt = "2030-01-01T15:00:00+08:00";
    },
  ]) {
    const n = structuredClone(r);
    mutate(n.assessment!);
    expect(
      series("wy-score-half-kelly", bars, days, "sh600000", [n]).at(-1)!.entry,
    ).toBe(false);
  }
});
it("WY10 requires completed weekly HH/HL plus the existing daily/hourly Spring, never substitutes daily bars", () => {
  const f = hourlyFixture();
  const earlier: Bar[] = [];
  let t = Date.parse(f.days[0]!) - 86400000;
  while (earlier.length < 240) {
    const d = new Date(t);
    if (![0, 6].includes(d.getUTCDay()))
      earlier.unshift({ ...f.bars[0]!, date: d.toISOString().slice(0, 10) });
    t -= 86400000;
  }
  earlier.forEach((b, i) => {
    const p = 45 + i * 0.12 + Math.sin(i / 10) * 6;
    Object.assign(b, { open: p, close: p, high: p + 0.5, low: p - 0.5 });
  });
  const bars = [...earlier, ...f.bars],
    days = bars.map((b) => b.date),
    r = raw(bars, 330);
  r.weeklyAvailableAt = `${days[329]}T15:05:00+08:00`;
  const point = series(
    "wy-week-day-hour",
    bars,
    days,
    "sh600000",
    [r],
    f.inputs,
  )[330]!;
  expect(point.reason).toBeNull();
  expect(point.inputEvidence).toMatchObject({ aligned: true });
  expect(point.entry).toBe(true);
  const missing = structuredClone(r);
  missing.calendar.days = missing.calendar.days.filter((d) => d !== days[100]);
  expect(
    series(
      "wy-week-day-hour",
      bars,
      days,
      "sh600000",
      [missing],
      f.inputs,
    )[330]!.entry,
  ).toBe(false);
  expect(
    series("wy-week-day-hour", bars, days, "sh600000", [r], [])[330]!.entry,
  ).toBe(false);
});

it("WY11 dual historical RS consumes raw inputs; equality, late membership and mismatched raw bars cannot enter", () => {
  const bars = jac(),
    days = bars.map((b) => b.date),
    input = raw(bars);
  expect(
    series("wy-dual-rs", bars, days, "sh600000", [input]).at(-1)!.entry,
  ).toBe(true);
  for (const mutate of [
    (r: WyckoffStructureInput) => {
      r.benchmarks![0]!.snapshot.bars = structuredClone(r.stock.bars);
    },
    (r: WyckoffStructureInput) => {
      r.benchmarks![0]!.identity.availableAt = `${r.date}T15:00:00+08:00`;
    },
    (r: WyckoffStructureInput) => {
      r.stock.bars[0]!.close += 0.01;
    },
  ]) {
    const r = structuredClone(input);
    mutate(r);
    expect(
      series("wy-dual-rs", bars, days, "sh600000", [r]).at(-1)!.entry,
    ).toBe(false);
  }
});
