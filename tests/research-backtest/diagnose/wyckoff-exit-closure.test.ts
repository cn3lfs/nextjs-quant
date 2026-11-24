import { expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import { replayDailyStudy } from "quant-backtest";
import {
  createExtendedStudyRule,
  createStudyDecision,
  prepareStrategy,
  studyWarmup,
  wyckoffTrendVol10Diagnostic,
  type StudyStrategy,
  type StrategyObjectInput,
} from "trading-strategies";
import { analyzeWyckoffFunnel } from "~/server/research/diagnose/wyckoff-funnel";

function bar(index: number, close: number, overrides: Partial<Bar> = {}): Bar {
  return {
    date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
    open: close - 0.1,
    close,
    high: close + 0.5,
    low: close - 0.5,
    volume: 100,
    amount: close * 100,
    ...overrides,
  };
}

function jacBars() {
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
  ] as const;
  const bars = Array.from({ length: 150 }, (_, index) => {
    const i = index - 60;
    if (i < 0) return bar(index, 80);
    const right = anchors.findIndex(([at]) => at >= i);
    const [start, from] = anchors[Math.max(0, right - 1)]!;
    const [end, to] = anchors[right]!;
    return bar(
      index,
      from + ((to - from) * (i - start)) / Math.max(1, end - start),
    );
  });
  bars.push(
    bar(150, 105, { open: 102, low: 102, high: 105.1, volume: 150 }),
    bar(151, 105, { open: 104.9, low: 104.6, high: 105.2 }),
  );
  return bars;
}

function prepare(id: StudyStrategy, bars: readonly Bar[]) {
  const strategy: StrategyObjectInput = {
    id,
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: ["sh600519"] },
    entry: { kind: "study-rule", strategy: id, side: "entry" },
    exit: { rule: { kind: "study-rule", strategy: id, side: "exit" } },
    sizing: { kind: "weight", weight: 1 },
    sleeve: "test",
  };
  return prepareStrategy(strategy, bars);
}

const exits = [
  {
    id: "research-wy-ut-exit",
    afterEntry: [
      bar(152, 104, { open: 104, high: 106.2, low: 103 }),
      bar(153, 103, { open: 104, high: 105.5, low: 102, volume: 180 }),
    ],
    fraction: undefined,
  },
  {
    id: "research-wy-sow-lpsy",
    afterEntry: [
      bar(152, 99, { open: 105.2, high: 105.4, low: 98, volume: 180 }),
      bar(153, 99, { open: 99, high: 100, low: 98.5 }),
      bar(154, 99.5, { open: 99.2, high: 100, low: 99, volume: 40 }),
      bar(155, 98.5, { open: 99, high: 99.8, low: 98 }),
    ],
    fraction: 0.5,
  },
  {
    id: "research-wy-ice-exit",
    afterEntry: [bar(152, 94, { open: 99, high: 99, low: 93, volume: 180 })],
    fraction: undefined,
  },
] as const;

it("gives a confirmed UT priority when LPSY confirms at the same close", () => {
  const rows = [...jacBars(), ...exits[1].afterEntry];
  rows[155] = { ...rows[155]!, volume: 200 };
  const rule = createExtendedStudyRule("research-wy-sow-lpsy", rows)!;
  const decision = rule(155, { entry: 105, entryIndex: 152 });
  expect(decision).toMatchObject({
    enter: false,
    exit: true,
    reason: "UT 确认全平",
  });
  expect(decision.exitFraction).toBeUndefined();
});

it("rejects partial exits in both legacy daily-study entry points", () => {
  const id = "research-wy-sow-lpsy";
  const rows = [...jacBars(), ...exits[1].afterEntry];
  expect(() =>
    replayDailyStudy(rows, [], {
      strategy: id,
      start: rows[150]!.date,
      end: rows[155]!.date,
      initial: 110000,
    }),
  ).toThrow(/部分减仓.*runPortfolio.*backtest-diagnose/);
  const decide = createStudyDecision(id, rows, rows, 110000, 150);
  expect(() =>
    decide(155, {
      cash: 5000,
      shares: 1000,
      entry: 105,
      entryIndex: 152,
      anchor: 0,
      core: 0,
      sleeveCap: 0,
      initialized: true,
      lastAllocationMonth: "",
      installments: 0,
    }),
  ).toThrow(/部分减仓.*runPortfolio/);
});

it.each(exits)(
  "preserves JAC entry and the named $id exit in StrategyDecision",
  ({ id, afterEntry, fraction }) => {
    const bars = [...jacBars(), ...afterEntry];
    const rule = prepare(id, bars);
    const position = { entry: 105, entryIndex: 152, signalIndex: 151 };
    expect(rule.evaluate(151)).toMatchObject({ entry: true, exit: false });
    for (let i = 152; i < bars.length - 1; i++)
      expect(rule.evaluate(i, position).exit).toBe(false);
    const index = bars.length - 1;
    expect(rule.evaluate(index, position)).toEqual({
      entry: false,
      exit: true,
      stopLevel: null,
      ...(fraction === undefined ? {} : { exitFraction: fraction }),
    });
    expect(rule.evaluate(index).exit).toBe(false);
    if (fraction !== undefined)
      expect(
        createExtendedStudyRule(id, bars)!(index, position).reason,
      ).toContain("50%");
  },
);

it("keeps the zero-day JAC guard from overriding the named close exit", () => {
  const bars = [
    ...jacBars(),
    bar(152, 102),
    bar(153, 94, { open: 99, high: 99, low: 93, volume: 100 }),
  ];
  for (const { id } of exits) {
    const rule = prepare(id, bars);
    expect(rule.evaluate(151).entry).toBe(true);
    expect(
      rule.evaluate(153, { entry: 102, entryIndex: 152, signalIndex: 151 })
        .exit,
    ).toBe(false);
  }
});

function trendBars(next: Partial<Bar> = {}) {
  const bars = Array.from({ length: 150 }, (_, i) => bar(i, 100 + i * 0.2));
  const ma20 = bars.slice(-20).reduce((sum, row) => sum + row.close, 0) / 20;
  bars.push(
    bar(150, ma20 + 0.3, {
      open: ma20 + 1,
      low: ma20,
      high: ma20 + 1.2,
      volume: 40,
    }),
    bar(151, ma20 + 1.5, {
      open: ma20 + 1,
      low: ma20,
      high: ma20 + 2,
      volume: 150,
      ...next,
    }),
  );
  return bars;
}

const allPass = {
  candidatesWithNextBar: 1,
  holdCandidateLow: 1,
  closeAboveCandidateHigh: 1,
  volumeGe15xMean20: 1,
  volumeGe10xMean20: 1,
  validNextBarNoReason: 1,
  holdAndCloseAboveHigh: 1,
  allFourConfirmed: 1,
};

it("uses inclusive low/volume edges, a strict high break, and counts invalid rows independently", () => {
  const id = "wy-trend-pullback-daily";
  const original = trendBars();
  const start = original[150]!.date;
  const end = original[151]!.date;
  for (const { bars, calendar, delta } of [
    { bars: original, calendar: undefined, delta: {} },
    {
      bars: trendBars({ volume: 110 }),
      calendar: undefined,
      delta: { volumeGe15xMean20: 0, allFourConfirmed: 0 },
    },
    {
      bars: trendBars({ low: original[150]!.low - 0.01 }),
      calendar: undefined,
      delta: {
        holdCandidateLow: 0,
        holdAndCloseAboveHigh: 0,
        allFourConfirmed: 0,
      },
    },
    {
      bars: trendBars({ close: original[150]!.high }),
      calendar: undefined,
      delta: {
        closeAboveCandidateHigh: 0,
        holdAndCloseAboveHigh: 0,
        allFourConfirmed: 0,
      },
    },
    {
      bars: original,
      calendar: original.slice(0, -1).map(({ date }) => date),
      delta: { validNextBarNoReason: 0, allFourConfirmed: 0 },
    },
  ]) {
    const result = analyzeWyckoffFunnel(id, bars, start, end, calendar);
    expect(result.candidates).toBe(1);
    expect(result.nextDayBreakdown).toEqual({ ...allPass, ...delta });
    expect(result.nextDayBreakdown?.allFourConfirmed).toBe(
      result.nextDayVolumeConfirm,
    );
  }
  expect(analyzeWyckoffFunnel(id, original, end, end)).toMatchObject({
    carryInCandidates: 1,
    nextDayBreakdown: allPass,
  });
  expect(analyzeWyckoffFunnel(id, original, start, start)).toMatchObject({
    candidates: 1,
    nextDayVolumeConfirm: 0,
    nextDayBreakdown: { candidatesWithNextBar: 0, allFourConfirmed: 0 },
  });
});

it("accepts 1.1 times prior volume only in the diagnostic and keeps the frozen exit guard", () => {
  const bars = trendBars({ volume: 110 });
  bars.push(bar(152, 129), bar(153, bars[150]!.low - 0.1));
  const diagnostic = prepare(wyckoffTrendVol10Diagnostic, bars);
  const original = prepare("research-wy-trend-pullback-protected", bars);
  expect(studyWarmup(wyckoffTrendVol10Diagnostic)).toBe(
    studyWarmup("research-wy-trend-pullback-protected"),
  );
  expect(diagnostic.evaluate(151).entry).toBe(true);
  expect(original.evaluate(151).entry).toBe(false);
  expect(
    diagnostic.evaluate(153, { entry: 129, entryIndex: 152, signalIndex: 151 })
      .exit,
  ).toBe(true);
  expect(
    prepare(wyckoffTrendVol10Diagnostic, trendBars({ volume: 99 })).evaluate(
      151,
    ).entry,
  ).toBe(false);
});
