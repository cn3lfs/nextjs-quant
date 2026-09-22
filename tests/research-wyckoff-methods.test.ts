import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";
import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/server/db/migrations";
import { ResearchStore } from "../src/server/backtest/research-store";
import type { Bar } from "../src/lib/domain";
import type { WyckoffHourlyInput } from "../src/lib/research-wyckoff-hourly";
import {
  researchWyckoffSeries,
  wyckoffStructureInputsSchema,
  wyckoffScore,
  type WyckoffStructureInput,
} from "../src/lib/research-wyckoff";
import { researchWyckoffStructureSeries as series } from "../src/server/strategies/shared/research-structure-weekly";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchSignals } from "../src/server/strategies/shared/research-signals";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research/research-method";
import { selectResearchStrategy } from "../src/components/research-strategy-fields";
import { runStrategyResearch } from "../src/server/backtest/research-run";
import type { ResearchDataset } from "../src/server/backtest/research-dataset";
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
const noNative = async () => {
  throw new Error("unexpected DLL");
};
const rules = {
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
};
function specFor(bars: Bar[], strategy = "wy-dual-rs") {
  return researchSpecSchema.parse({
    strategy,
    start: bars[90]!.date,
    end: bars.at(-1)!.date,
    validationStart: bars.at(-1)!.date,
    holdingDays: 60,
    maxPositions: 1,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
}
it("WY11 dual historical RS consumes raw inputs; equality, late membership and mismatched raw bars cannot enter", async () => {
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
  const spec = { ...specFor(bars), wyckoffStructureInputs: [input] };
  expect(await researchSignals("sh600000", bars, spec, noNative)).toHaveLength(
    1,
  );
  await expect(
    researchSignals(
      "sh600000",
      bars,
      { ...spec, wyckoffStructureInputs: [] },
      noNative,
    ),
  ).rejects.toThrow();
});
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
it("WY19 named targets freeze the pre-breakout range and sell initial thirds through the existing portfolio", async () => {
  const bars = jac();
  for (const price of [106, 113.5, 114, 122.5, 123, 131.5, 132])
    append(bars, {
      open: price,
      close: price,
      low: price - 0.1,
      high: price + 0.1,
    });
  for (const id of [
    "wy-target-pf",
    "wy-target-time",
    "wy-target-width",
  ] as const) {
    const spec = specFor(bars, id),
      events = await researchSignals("sh600000", bars, spec, noNative);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.structureTargets?.targets.length).toBe(
      id === "wy-target-pf" ? 1 : 3,
    );
    expect(JSON.parse(events[0]!.evidence).targetPlan.end).toBe(bars[89]!.date);
    if (id === "wy-target-width") {
      expect(events[0]!.structureTargets?.targets).toEqual([
        113.5, 122.5, 131.5,
      ]);
      const result = researchPortfolio(
        spec,
        events,
        bars.map((b) => b.date),
        new Map([["sh600000", bars]]),
        () => rules,
      );
      expect(result.trades[0]!.sales?.map((s) => s.quantity)).toEqual([
        300, 300, 300,
      ]);
      expect(result.trades[0]!.remainingQuantity).toBe(0);
    }
  }
  const bad = jac();
  bad[80]!.close = 200;
  expect(researchWyckoffSeries("wy-target-width", bad).at(-1)!.entry).toBe(
    false,
  );
});
it("raw input schema, UI switching, method snapshot and persisted task preserve complete evidence and explicit empty input", () => {
  const bars = jac(),
    r = raw(bars),
    s = { ...specFor(bars), wyckoffStructureInputs: [r] };
  expect(researchSpecSchema.parse(s).wyckoffStructureInputs).toEqual([r]);
  expect(
    wyckoffStructureInputsSchema.safeParse([{ ...r, availableAt: undefined }])
      .success,
  ).toBe(false);
  expect(researchMethodSnapshot(s).wyckoffStructureInputs).toEqual([r]);
  expect(
    selectResearchStrategy(s, "wy-score-half-kelly").wyckoffStructureInputs,
  ).toEqual([r]);
  expect(
    selectResearchStrategy(s, "ma-cross").wyckoffStructureInputs,
  ).toBeUndefined();
  expect(
    researchMethodSnapshot({ ...s, wyckoffStructureInputs: [] })
      .wyckoffStructureInputs,
  ).toEqual([]);
  const db = new Database(":memory:");
  migrate(db);
  const store = new ResearchStore(db);
  const task = store.create(s, null);
  expect(store.task(task.id)!.spec.wyckoffStructureInputs).toEqual([r]);
  db.close();
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

it("WY20 run persists raw evidence and uses B2 training admission; a source .48 hypothesis cannot open validation trades with fewer than 30 closed samples", async () => {
  const bars = jac();
  for (let i = 0; i < 5; i++)
    append(bars, { open: 106, close: 106, high: 107, low: 105 });
  const spec = researchSpecSchema.parse({
    ...specFor(bars, "wy-score-half-kelly"),
    validationStart: bars[91]!.date,
    wyckoffStructureInputs: bars.slice(90).map((_, i) => raw(bars, 90 + i)),
  });
  const dataset: ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "synthetic",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: ["sh600000"],
      source: null,
      warning: "fixture",
    },
    benchmark: { symbol: "sh000001", bars },
    calendar: bars.map((b) => b.date),
    stocks: [
      {
        symbol: "sh600000",
        name: "fixture",
        bars,
        hash: "fixture",
        actions: [],
      },
    ],
    excluded: [],
    actionCoverage: "partial",
    actionSource: { path: "fixture", modified: 0 },
    capturedAt: 0,
    hash: "fixture",
  };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "fixture",
    exportedAt: 0,
    adjustment: "none",
    corporateActionFree: [
      {
        symbol: "sh600000",
        start: bars[0]!.date,
        end: bars.at(-1)!.date,
        evidenceId: "fixture",
      },
    ],
    rows: bars.map((b) => ({
      ...rules,
      symbol: "sh600000",
      date: b.date,
      evidenceId: "fixture",
    })),
  });
  const result = await runStrategyResearch(spec, dataset, evidence, noNative);
  expect(result.events.filter((e) => !e.side)).toHaveLength(1);
  expect(result.kellyTraining).toMatchObject({
    minimumTrades: 30,
    winRate: null,
    reason: "开发期不足30笔完整闭合交易",
  });
  const validation = result.partitions.find(
    (p) => p.partition === "validation",
  )!;
  expect(validation.simulation!.trades).toEqual([]);
  expect(
    validation.simulation!.attempts.some((a) => a.reason.includes("开发期")),
  ).toBe(true);
  expect(result.wyckoffStructureInputs).toEqual(spec.wyckoffStructureInputs);
  const db = new Database(":memory:");
  migrate(db);
  const store = new ResearchStore(db),
    task = store.create(spec, evidence);
  store.finish(task.id, result);
  expect(store.result(task.id)!.wyckoffStructureInputs).toEqual(
    spec.wyckoffStructureInputs,
  );
  db.close();
});
