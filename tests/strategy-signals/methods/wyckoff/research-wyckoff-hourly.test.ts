import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import {
  researchWyckoffHourlySeries as series,
  type WyckoffHourlyInput,
} from "trading-strategies/research/wyckoff/research-wyckoff-hourly";
import { researchWyckoffSeries } from "trading-strategies/research/wyckoff/research-wyckoff";
import { hourlyBars } from "../../../../src/server/market/hourly-bars";

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
function fixture() {
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
it("freezes the pre-hour daily region and separates hourly candidate/confirmation", () => {
  const { bars, days, inputs } = fixture();
  const daily = researchWyckoffSeries("wy-spring-daily", bars, days);
  expect(daily[90]!.structure).toMatchObject({
    support: 95.5,
    resistance: 104.5,
    asOf: days[89],
  });
  const p = series(bars, days, inputs, "sh600000");
  expect(p[90]!.entry).toBe(true);
  const e = p[90]!.events.find(
    (e) => e.state === "confirmed" && e.kind === "spring",
  )!;
  expect(e).toMatchObject({
    candidateAt: `${days[90]}T10:30:00+08:00`,
    confirmedAt: `${days[90]}T11:30:00+08:00`,
    facts: { support: 95.5, regionAt: days[89], meanVolume: 25 },
  });
  expect(p[92]!.exit).toBe(true);
});
it("requires subsequent reclaim and >=1.5 candidate baseline volume, rejects new lows and equality", () => {
  for (const change of [
    { close: 95.5, volume: 37.5 },
    { close: 97, volume: 37.49 },
    { close: 97, volume: 37.5, low: 94.9 },
  ]) {
    const { bars, days, inputs } = fixture();
    // Shared hour objects intentionally preserve matching overlapping snapshots.
    const h = inputs.find((r) => r.date === days[90])!.hours[21]!;
    Object.assign(h, change);
    for (const r of inputs)
      for (const x of r.hours) if (x.date === h.date) Object.assign(x, h);
    // Prevent a later valid recovery from confirming the candidate.
    for (const r of inputs)
      for (const x of r.hours)
        if (x.date.startsWith(days[90]!) && x.date > h.date) x.volume = 25;
    aggregate(
      bars[90]!,
      inputs.find((r) => r.date === days[90])!.hours.slice(-4),
    );
    const p = series(bars, days, inputs, "sh600000")[90]!;
    expect(p.reason).toBeNull();
    expect(p.entry).toBe(false);
  }
});
it("missing hourly slots, late evidence, changed history and wrong symbol are unavailable", () => {
  for (const kind of ["slot", "late", "revision", "symbol"]) {
    const { bars, days, inputs } = fixture();
    const r = inputs.find((r) => r.date === days[90])!;
    if (kind === "slot") r.hours = r.hours.slice(1);
    if (kind === "late") r.availableAt = `${days[91]}T15:00:00+08:00`;
    if (kind === "revision")
      r.hours = [{ ...r.hours[0]!, volume: 99 }, ...r.hours.slice(1)];
    if (kind === "symbol") r.symbol = "sz000001";
    const p = series(bars, days, inputs, "sh600000")[90]!;
    expect(p.entry).toBe(false);
    expect(p.reason).toContain("待数据");
  }
});
it("consumes complete existing five-minute-to-hour adapter output", () => {
  const { bars, days, inputs } = fixture(),
    r = inputs.find((r) => r.date === days[90])!;
  const minutes = r.hours.flatMap((h) =>
    Array.from({ length: 12 }, (_, j) => {
      const t = Date.parse(h.date) - (11 - j) * 5 * 60000;
      return {
        ...h,
        date: new Date(t + 8 * 3600000).toISOString().slice(0, 19) + "+08:00",
        volume: h.volume / 12,
        amount: h.amount / 12,
      };
    }),
  );
  const result = hourlyBars(
    {
      id: "fixed",
      symbol: r.symbol,
      period: "5m",
      adjustment: "none",
      source: "fixture",
      createdAt: 0,
      hash: "fixed",
      bars: minutes,
    },
    Date.parse(r.availableAt),
  );
  expect(result.excluded).toEqual([]);
  expect(result.bars).toHaveLength(24);
  r.hours = result.bars;
  // Start at this evidence snapshot so floating point aggregation isn't a revision of a different source.
  expect(series(bars, days, [r], "sh600000")[90]!.entry).toBe(true);
});

it("carries a last-hour candidate overnight and cancels it when the next day is unavailable", () => {
  const { bars, days, inputs } = fixture();
  const day90 = inputs.find((r) => r.date === days[90])!.hours.slice(-4);
  for (const h of day90)
    Object.assign(h, { open: 100, close: 100, high: 101, low: 99, volume: 25 });
  Object.assign(day90[3]!, {
    open: 96,
    close: 95.6,
    high: 96.2,
    low: 95,
    volume: 12.5,
  });
  const day91 = inputs.find((r) => r.date === days[91])!.hours.slice(-4);
  Object.assign(day91[0]!, {
    open: 95.6,
    close: 97,
    high: 97.2,
    low: 95.2,
    volume: 37.5,
  });
  aggregate(bars[90]!, day90);
  aggregate(bars[91]!, day91);
  const p = series(bars, days, inputs, "sh600000");
  expect(p[90]!.entry).toBe(false);
  expect(p[91]!.entry).toBe(true);
  expect(p[91]!.events.find((e) => e.state === "confirmed")).toMatchObject({
    candidateAt: `${days[90]}T15:00:00+08:00`,
    confirmedAt: `${days[91]}T10:30:00+08:00`,
    facts: { regionAt: days[89] },
  });
  const missing = series(
    bars,
    days,
    inputs.filter((r) => r.date !== days[91]),
    "sh600000",
  );
  expect(missing[91]!.entry).toBe(false);
  expect(missing[91]!.events.find((e) => e.kind === "spring")).toMatchObject({
    state: "cancelled",
    confirmedAt: null,
  });
});
it("rejects daily/hourly price and unit conflicts instead of manufacturing an entry", () => {
  for (const kind of ["price", "unit"]) {
    const { bars, days, inputs } = fixture();
    if (kind === "price") bars[90]!.low = 96;
    else bars[90]!.volume *= 100;
    const p = series(bars, days, inputs, "sh600000")[90]!;
    expect(p.entry).toBe(false);
    expect(p.reason).toContain("小时聚合必须");
  }
});
