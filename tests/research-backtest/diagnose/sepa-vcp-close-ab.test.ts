import { expect, it, vi } from "vitest";
import type { PortfolioInstrument, PortfolioRequest } from "quant-backtest";
import {
  projectFinancialFields,
  type FinancialReportSnapshot,
} from "tstdx/financial-model";
import { createTheoryStructureRule } from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import {
  attachGrowthPitSignals,
  growthPitRulesFor,
  growthPitWarmupBars,
  SEPA_VCP_CLOSE_STRATEGY_KEYS,
  type GrowthPitStrategyKey,
} from "~/server/research/diagnose/growth-pit";

const [priceKey, pitKey, strictKey] = SEPA_VCP_CLOSE_STRATEGY_KEYS;
const symbol = "sz300750";
const announced = "2026-03-27";
const available = "2026-03-30";
const makeBar = (date: string, close: number, volume: number): Bar => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume,
  amount: close * volume,
});

function businessDates(dateAt140: string) {
  const origin = Date.parse(dateAt140);
  const dates = Array.from(
    { length: 560 },
    (_, i) => new Date(origin + (i - 280) * 86400000),
  )
    .filter((date) => date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
    .map((date) => date.toISOString().slice(0, 10));
  const center = dates.indexOf(dateAt140);
  return dates.slice(center - 140, center + 130);
}

function priceBars(anchor: string, breakouts: readonly number[]) {
  const bars = businessDates(anchor).map((date) => ({
    ...makeBar(date, 110, 1000),
    high: 111,
    low: 109,
  }));
  for (const index of breakouts) {
    bars[index - 40]!.high = 120;
    bars[index - 30]!.low = 90;
    bars[index - 20]!.high = 115;
    bars[index - 10]!.low = 100;
    for (let i = index - 20; i <= index - 10; i++) bars[i]!.volume = 100;
    Object.assign(bars[index]!, {
      close: 117,
      high: 118,
      low: 110,
      volume: 2000,
    });
  }
  return bars;
}

function report(
  reportDate: string,
  announcementDate: string,
  availableFrom: string,
  revenue: number,
  profit: number,
  roe = 20,
): FinancialReportSnapshot {
  const raw = Array<number>(281).fill(0);
  raw[229] = revenue;
  raw[231] = profit;
  raw[280] = roe;
  return {
    symbol,
    financialCompany: false,
    reportDate,
    announcementDate,
    availableFrom,
    sourceFilename: "fixture.dat",
    sourceSha256: "fixture",
    contentSha256: "fixture",
    recordOffset: 0,
    mappingVersion: "fixture",
    warnings: [],
    fields: projectFinancialFields(raw, false, [229, 231, 280]),
  };
}

const reports = [
  report("2024-09-30", "2024-10-28", "2024-10-29", 100, 10),
  report("2024-12-31", "2025-03-25", "2025-03-26", 100, 12),
  report("2025-03-31", "2025-04-25", "2025-04-28", 100, 12),
  report("2025-09-30", "2025-10-23", "2025-10-24", 125, 16),
  report("2025-12-31", announced, available, 125, 17.5),
  report("2026-03-31", "2026-04-29", "2026-04-30", 125, 25),
];
const readFinancialHistory = vi.fn(async () => ({ reports, issues: [] }));

async function evaluate(key: GrowthPitStrategyKey, bars: readonly Bar[]) {
  const calendar = bars.map(({ date }) => date);
  const instrument: PortfolioInstrument = {
    symbol,
    market: "cn-equity",
    bars,
    signalBars: bars,
    execution: {
      evidence: "fixture",
      limitUp: null,
      limitDown: null,
      tradable: true,
    },
  };
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: 100000,
    start: calendar[0]!,
    end: calendar.at(-1)!,
    calendar,
    instruments: [instrument],
    strategies: [],
    sleeves: [],
  };
  const [disclosure] = await attachGrowthPitSignals(
    key,
    { request },
    {
      tdxRoot: "fixture-only",
      signalCalendar: calendar,
      readFinancialHistory,
    },
  );
  return {
    dates: instrument.external?.signals
      ?.filter((row) => row.entry)
      .map(({ date }) => date),
    disclosure,
  };
}

it("produces proper subsets with one price rule, a common calendar and identical six-bar exits", async () => {
  const bars = priceBars("2026-02-20", [140, 185, 230]);
  const theory = createTheoryStructureRule("theory-vcp-close", bars)!;
  const theoryDates = bars
    .filter(
      (_, index) =>
        index >= 140 && theory(index, { entry: 0, entryIndex: index }).enter,
    )
    .map(({ date }) => date);
  readFinancialHistory.mockClear();
  const price = await evaluate(priceKey, bars);
  expect(readFinancialHistory).not.toHaveBeenCalled();
  const pit = await evaluate(pitKey, bars);
  const strict = await evaluate(strictKey, bars);
  const dates = [140, 185, 230].map((index) => bars[index]!.date);
  expect(theoryDates).toEqual(dates);
  expect(price.dates).toEqual(theoryDates);
  expect(pit.dates).toEqual(dates.slice(1));
  expect(strict.dates).toEqual(dates.slice(2));
  expect(strict.disclosure?.funnel).toMatchObject({
    priceSignals: 3,
    pitFinanceSignals: 1,
  });
  for (const key of SEPA_VCP_CLOSE_STRATEGY_KEYS)
    expect(growthPitRulesFor(key).exit).toEqual({ maxBars: 6 });
});

it.each([
  ["2026-03-26", false],
  [announced, false],
  [available, true],
])(
  "uses the report only from its first post-announcement session for a %s breakout",
  async (date, allowed) => {
    const bars = priceBars(date, [140]).slice(0, 145);
    expect((await evaluate(priceKey, bars)).dates).toEqual([date]);
    expect((await evaluate(pitKey, bars)).dates).toEqual(allowed ? [date] : []);
  },
);

it("preserves the original SEPA VCP and its tolerant PIT gate at 300-bar warmup", async () => {
  const key = "research-sepa-pit";
  const knots = [
    [0, 90],
    [8, 100],
    [16, 80],
    [24, 108],
    [32, 98],
    [40, 112],
    [48, 107],
    [56, 114],
    [59, 113],
  ] as const;
  const bars = Array.from({ length: 373 }, (_, i) => {
    const date = new Date(Date.UTC(2025, 3, i + 1)).toISOString().slice(0, 10);
    if (i < 310) return makeBar(date, 50 + i * 0.08, 100);
    if (i >= 370) return makeBar(date, 116, 200);
    const offset = i - 310;
    const right = knots.findIndex(([index]) => index >= offset);
    const [leftIndex, leftPrice] = knots[Math.max(0, right - 1)]!;
    const [rightIndex, rightPrice] = knots[right]!;
    const close =
      leftPrice +
      ((rightPrice - leftPrice) * (offset - leftIndex)) /
        Math.max(1, rightIndex - leftIndex);
    return makeBar(date, close, i >= 365 ? 10 : i >= 318 ? 40 : 100);
  });
  expect(growthPitWarmupBars(key)).toBe(300);
  expect(growthPitRulesFor(key)).toEqual({
    entry: { kind: "external", id: key, side: "entry" },
    exit: { maxBars: 6 },
  });
  const result = await evaluate(key, bars);
  expect(result.dates).toEqual([bars[370]!.date]);
  expect(result.disclosure?.funnel).toMatchObject({
    strictPitFinanceSignals: 0,
    tolerantPitFinanceSignals: 1,
  });
});
