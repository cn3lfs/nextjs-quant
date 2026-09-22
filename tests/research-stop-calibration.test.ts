import { expect, it, vi } from "vitest";
import * as breakout from "../src/server/strategies/breakout/breakout";
import { researchSignals } from "../src/server/strategies/shared/research-signals";
import {
  chanStopLine,
  indicatorRespect,
  indicatorStopLines,
  researchMaeTraining,
} from "../src/lib/research-stop-calibration";
import { riskPresetTemplate } from "../src/lib/research-risk-presets";
import {
  researchPortfolio,
  type ResearchTrade,
} from "../src/server/backtest/research-portfolio";
import { applyResearchManagement } from "../src/components/research-strategy-fields";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import type { CzscResult } from "../src/lib/czsc";
import type { Bar } from "../src/lib/domain";
const bars: Bar[] = Array.from({ length: 190 }, (_, i) => ({
  date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 100000,
  amount: 10000000,
}));
const calendar = bars.map((b) => b.date);
const event: ResearchEvent = {
  symbol: "sh600000",
  key: "same",
  observedDate: calendar[150]!,
  endpointDate: calendar[150]!,
  strategyVersion: "fixed-v1",
  partition: "development",
  evidence: "fixed input",
};
const costs = {
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  slippageBps: 0,
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
  limitUp: null,
  limitDown: null,
  tradable: true,
};
const base = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: calendar[150],
  end: calendar[180],
  validationStart: calendar[175],
  costs,
});
const sample = (i: number): ResearchTrade => ({
  event: { ...event, key: String(i), observedDate: calendar[20]! },
  entryDate: calendar[21]!,
  entryIndex: 21,
  entryPrice: 100,
  quantity: 100,
  entryCost: 10000,
  exitDate: calendar[23]!,
  exitPrice: i < 60 ? 102 : 99,
  profit: i < 60 ? 200 : i < 90 ? -100 : 0,
  netReturn: i < 60 ? 0.02 : i < 90 ? -0.01 : 0,
  lastPrice: 100,
  initialStop: 95,
  exitReason: "固定开盘退出",
});
const training = (
  trades = Array.from({ length: 100 }, (_, i) => sample(i)),
  input = bars,
) =>
  researchMaeTraining(
    trades,
    new Map([[event.symbol, input]]),
    calendar,
    calendar[0]!,
    calendar[100]!,
  );
it("MAE records wins, losses and zeros; opening exit excludes the rest of that session", () => {
  const input = structuredClone(bars);
  input[22]!.low = 96;
  input[22]!.high = 104;
  input[23]!.low = 1;
  input[23]!.high = 1000;
  const t = training(undefined, input);
  expect(t).toMatchObject({
    width: 0.04,
    wins: 60,
    losses: 30,
    zeros: 10,
    reason: null,
    coverageQuantile: 0.9,
  });
  expect(t.records[0]).toMatchObject({
    mae: 0.04,
    mfe: 0.04,
    initialR: 500,
    finalR: 0.4,
    entryAtr: 2,
  });
  expect(t.records).toHaveLength(100);
  expect(t.records[99]!.profit).toBe(0);
});
it("MAE rejects validation/future/open samples, mixed versions, duplicate identity and missing daily history", () => {
  const rows = Array.from({ length: 100 }, (_, i) => sample(i));
  const contaminated = [
    ...rows,
    {
      ...sample(100),
      event: { ...sample(100).event, partition: "validation" as const },
      profit: 99999,
    },
    { ...sample(101), exitDate: calendar[120]! },
    { ...sample(102), exitDate: null },
  ];
  expect(training(contaminated)).toEqual(training(rows));
  expect(training([...rows, rows[0]!]).reason).toBe("重复交易身份");
  expect(
    training(
      rows.map((r, i) =>
        i ? r : { ...r, event: { ...r.event, strategyVersion: "changed" } },
      ),
    ).reason,
  ).toBe("策略版本混合");
  expect(
    training(
      rows,
      bars.filter((_, i) => i !== 22),
    ).width,
  ).toBeNull();
  expect(training(rows.slice(0, 99)).reason).toContain("100");
  const losers = training(rows.map((r) => ({ ...r, profit: -100 })));
  expect(losers).toMatchObject({ width: null, wins: 0, losses: 100 });
  expect(losers.records).toHaveLength(100);
});
it("training keeps distinct securities with equal event keys", () => {
  const rows = Array.from({ length: 100 }, (_, i) => sample(i));
  const other = {
    ...rows[0]!,
    event: { ...rows[0]!.event, symbol: "sz000001" },
  };
  const result = researchMaeTraining(
    [...rows, other],
    new Map([
      [event.symbol, bars],
      [other.event.symbol, bars],
    ]),
    calendar,
    calendar[0]!,
    calendar[100]!,
  );
  expect(result.records).toHaveLength(101);
  expect(result.reason).toBeNull();
});
it("MAE width changes actual initial stop and rejects a future cutoff", () => {
  const input = structuredClone(bars);
  input[22]!.low = 96;
  const t = training(undefined, input);
  const spec = applyResearchManagement(base, riskPresetTemplate("rk-mae"));
  const run = (train: typeof t | null) =>
    researchPortfolio(
      spec,
      [event],
      calendar,
      new Map([[event.symbol, bars]]),
      () => rules,
      undefined,
      undefined,
      undefined,
      train,
    );
  expect(run(t).trades[0]).toMatchObject({
    initialStop: 96,
    entryDate: calendar[151],
    quantity: 200,
  });
  expect(run(null).excluded[0]!.reason).toContain("missing");
  expect(run({ ...t, cutoff: calendar[160]! }).trades).toHaveLength(0);
});
it.each(indicatorStopLines.filter((id) => id !== "rk-sar"))(
  "%s along-line test excludes signal-day and future bars",
  (line) => {
    const date = calendar[180]!;
    const result = indicatorRespect(bars, calendar, date, line);
    expect(result).toEqual({
      allow: true,
      touches: 60,
      holds: 60,
      reason: null,
    });
    const future = bars.map((b, i) =>
      i >= 180 ? { ...b, low: 1, close: 1000, high: 1001 } : b,
    );
    expect(indicatorRespect(future, calendar, date, line)).toEqual(result);
    expect(
      indicatorRespect(
        bars.filter((_, i) => i !== 160),
        calendar,
        date,
        line,
      ).allow,
    ).toBe(false);
    expect(
      indicatorRespect(
        bars.map((b) => ({ ...b, low: 95 })),
        calendar,
        date,
        line,
      ).allow,
    ).toBe(false);
  },
);
it("indicator initial line is mandatory and not replaced by the five percent baseline", () => {
  const input = bars.map((b, i) =>
    i >= 150 ? { ...b, open: 102, high: 103, close: 102, low: 101 } : b,
  );
  const run = (
    start: ResearchEvent,
    id: "rk-indicator-ema20" | "rk-respect-ema20",
  ) =>
    researchPortfolio(
      applyResearchManagement(base, riskPresetTemplate(id)),
      [start],
      calendar,
      new Map([[event.symbol, input]]),
      () => rules,
    );
  expect(run(event, "rk-indicator-ema20").trades[0]!.initialStop).toBeCloseTo(
    100 + (2 * 2) / 21,
    10,
  );
  expect(run(event, "rk-respect-ema20").trades).toHaveLength(1);
  const noHistory = researchPortfolio(
    applyResearchManagement(base, riskPresetTemplate("rk-indicator-ma120")),
    [event],
    calendar,
    new Map([[event.symbol, input.slice(140)]]),
    () => rules,
  );
  expect(noHistory.trades).toHaveLength(0);
  expect(noHistory.excluded[0]!.reason).toContain("止损输入缺失");
});
const native = (): CzscResult => ({
  status: "structure",
  hash: "fixed-dll",
  sourceCommit: "b67f3c6",
  families: [
    {
      config: 0,
      points: [],
      signals: [
        { index: 145, date: calendar[145]!, kind: 3, quality: 1, centerId: 1 },
      ],
      centers: [
        {
          start: 120,
          end: 130,
          startDate: calendar[120]!,
          endDate: calendar[130]!,
          direction: 1,
          ZG: 98,
          ZD: 96,
          GG: 100,
          DD: 94,
        },
      ],
      movements: [],
      qualities: [],
      divergences: [],
    },
  ],
});
it("native center ownership and confirmation are required; no nearest-center substitute", () => {
  expect(chanStopLine(native(), bars.slice(0, 151), 0)).toMatchObject({
    stop: 98,
    reason: null,
    evidence: { dllHash: "fixed-dll" },
  });
  for (const changes of [
    { centerId: undefined },
    { quality: 0 },
    { kind: 1 },
    { index: 180, date: calendar[180]! },
  ]) {
    const n = native();
    Object.assign(n.families[0]!.signals[0]!, changes);
    expect(chanStopLine(n, bars.slice(0, 151), 0).stop).toBeNull();
  }
  expect(chanStopLine(native(), bars, 1100).reason).toContain("missing");
  const result = researchPortfolio(
    applyResearchManagement(base, riskPresetTemplate("rk-chan-line")),
    [{ ...event, initialStop: 98 }],
    calendar,
    new Map([[event.symbol, bars]]),
    () => rules,
  );
  expect(result.trades[0]!.initialStop).toBe(98);
});

it("chan signal adapter calls the existing DLL callback serially with exact historical prefixes", async () => {
  const source = breakout.analyzeBreakout(bars);
  const spy = vi
    .spyOn(breakout, "analyzeBreakout")
    // The signal loop now calls `analyzeBreakout(bars, 0)` once and reads
    // `points[index]` (S4 breakout rewrite; equivalence proven exhaustively in
    // .codex-runs/s4-breakout-prefix-equivalence.ts). This stub exists only to
    // force "breakout side is a signal" on every bar, so it must cover every
    // index rather than only the last prefix — the assertion this test makes
    // (serial DLL callback with exact historical prefixes) is unchanged.
    .mockImplementation((calledBars: readonly Bar[]) => {
      const points: typeof source.points = calledBars.map((bar) => ({
        ...source.latest!,
        date: bar.date,
        long: { ...source.latest!.long, status: "是" },
      }));
      return { ...source, points, latest: points.at(-1) ?? null };
    });
  let active = 0,
    maximum = 0;
  const lengths: number[] = [];
  const engine = async (prefix: readonly Bar[]) => {
    active++;
    maximum = Math.max(maximum, active);
    lengths.push(prefix.length);
    await Promise.resolve();
    active--;
    return native();
  };
  try {
    const spec = applyResearchManagement(
      base,
      riskPresetTemplate("rk-chan-line"),
    );
    const events = await researchSignals(event.symbol, bars, spec, engine);
    expect(events).toHaveLength(31);
    expect(maximum).toBe(1);
    expect(lengths).toEqual(Array.from({ length: 31 }, (_, i) => 151 + i));
    expect(events.every((e) => e.initialStop === 98)).toBe(true);
    const observed = JSON.parse(events[0]!.evidence).chanStop.evidence;
    expect(observed).toMatchObject({
      observedDate: calendar[150],
      dllHash: "fixed-dll",
      point: { centerId: 1 },
    });
    const prefix = await researchSignals(
      event.symbol,
      bars.slice(0, 161),
      { ...spec, end: calendar[160]! },
      engine,
    );
    expect(prefix).toEqual(events.slice(0, 11));
  } finally {
    spy.mockRestore();
  }
});
