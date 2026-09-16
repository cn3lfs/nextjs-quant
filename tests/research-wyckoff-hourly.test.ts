import { wyckoffHourlyFromMinutes } from "../src/server/research-wyckoff-hourly";
import { runStrategyResearch } from "../src/server/research-run";
import type { ResearchDataset } from "../src/server/research-dataset";
import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  researchWyckoffHourlySeries as series,
  wyckoffHourlyInputsSchema,
  type WyckoffHourlyInput,
} from "../src/lib/research-wyckoff-hourly";
import { researchWyckoffSeries } from "../src/lib/research-wyckoff";
import { hourlyBars } from "../src/server/hourly-bars";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchSignals } from "../src/server/research-signals";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";
import { selectResearchStrategy } from "../src/components/research-strategy-fields";

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
it("runs real hourly-generated entry then UT against held shares, preserving evidence in snapshot", async () => {
  const { bars, days, inputs } = fixture();
  const spec = researchSpecSchema.parse({
    strategy: "wy-daily-hourly",
    start: days[90],
    end: days[95],
    validationStart: days[92],
    holdingDays: 20,
    wyckoffHourlyInputs: inputs,
    maxPositions: 1,
  });
  const events = await researchSignals(
    "sh600000",
    bars,
    spec,
    async () => {
      throw Error("no DLL");
    },
    undefined,
    undefined,
    days,
  );
  expect(events).toHaveLength(1);
  expect(events[0]!.observedDate).toBe(days[90]);
  const result = researchPortfolio(
    spec,
    events,
    days,
    new Map([["sh600000", bars]]),
    () => ({
      evidence: "fixture",
      minimumBuy: 100,
      buyStep: 100,
      maximumOrder: 100000,
      minimumSell: 100,
      sellStep: 100,
      maximumSell: 100000,
      sellOddLotAll: true,
      tradable: true,
      limitUp: null,
      limitDown: null,
    }),
  );
  expect(result.trades).toHaveLength(1);
  expect(result.trades[0]).toMatchObject({
    entryDate: days[91],
    exitDate: days[93],
  });
  expect(researchMethodSnapshot(spec)).toHaveProperty(
    "wyckoffHourlyInputs",
    inputs,
  );
  expect(selectResearchStrategy(spec, "dual-breakout")).not.toHaveProperty(
    "wyckoffHourlyInputs",
  );
  expect(
    wyckoffHourlyInputsSchema.safeParse([inputs[0], inputs[0]]).success,
  ).toBe(false);
  await expect(
    researchSignals(
      "sh600000",
      bars,
      { ...spec, end: "2023-01-01" },
      async () => {
        throw Error("no DLL");
      },
    ),
  ).rejects.toThrow("小时研究窗口");
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

it("replays the actual dataset minute adapter, retains hourly observations, and never falls back from an explicit empty override", async () => {
  const { bars, days, inputs } = fixture();
  const hours = [
    ...new Map(inputs.flatMap((r) => r.hours).map((h) => [h.date, h])).values(),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const minutes = hours.flatMap((h) =>
    Array.from({ length: 12 }, (_, j) => ({
      ...h,
      date:
        new Date(Date.parse(h.date) - (11 - j) * 5 * 60000 + 8 * 3600000)
          .toISOString()
          .slice(0, 19) + "+08:00",
      volume: h.volume / 12,
      amount: h.amount / 12,
    })),
  );
  const stock = {
    symbol: "sh600000",
    name: "fixed",
    bars,
    hash: "fixed",
    actions: [],
    minuteBars: minutes,
    minuteSource: {
      source: "fixture",
      hash: "minute-fixed",
      start: minutes[0]!.date,
      end: minutes.at(-1)!.date,
    },
  };
  const rows = wyckoffHourlyFromMinutes(stock, days, days[95]!);
  expect(rows.find((r) => r.date === days[90])!.hours).toHaveLength(24);
  expect(rows.every((r) => r.date <= days[95]!)).toBe(true);
  const missing = wyckoffHourlyFromMinutes(
    {
      ...stock,
      minuteBars: minutes.filter(
        (m) => m.date !== `${days[90]}T09:35:00+08:00`,
      ),
    },
    days,
    days[95]!,
  );
  expect(missing.some((r) => r.date === days[90])).toBe(false);
  const spec = researchSpecSchema.parse({
    strategy: "wy-daily-hourly",
    start: days[90],
    end: days[95],
    validationStart: days[92],
  });
  const dataset: ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "synthetic",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: [stock.symbol],
      source: null,
      warning: "fixture",
    },
    benchmark: { symbol: "sh000001", bars },
    calendar: days,
    stocks: [stock],
    excluded: [],
    actionCoverage: "partial",
    actionSource: { path: "fixture", modified: 0 },
    capturedAt: 0,
    hash: "fixed",
  };
  const result = await runStrategyResearch(spec, dataset, null, async () => {
    throw Error("no DLL");
  });
  expect(result.events).toHaveLength(1);
  expect(result.spec).toEqual(spec);
  expect(
    result
      .structureObservations!.flatMap((r) => r.events)
      .some((e) => e.kind === "ut" && e.state === "confirmed"),
  ).toBe(true);
  expect(result.events[0]!.evidence).toContain(
    "minute-fixed/a-share-hourly-1/历史收盘可知模型",
  );
  const empty = await runStrategyResearch(
    { ...spec, wyckoffHourlyInputs: [] },
    dataset,
    null,
    async () => {
      throw Error("no DLL");
    },
  );
  expect(empty.events).toEqual([]);
  expect(
    empty.exclusions.some((e) => e.reason.includes("没有可用策略输入")),
  ).toBe(true);
});
