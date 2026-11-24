import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildExecutionRealityReport,
  executionRealityCrises,
  parseExecutionRealityLc5,
  type ExecutionRealityInput,
  type ExecutionRealityVolumeEvidence,
  type ExecutionRealityWindow,
} from "~/server/research/execution-reality";

const symbol = "sh600000";
const start = "2024-09-23";
const firstFill = "2024-09-24";
const sellDate = "2024-09-25";
const end = "2024-10-18";
const endLabel = (date: string, end: string) => `${date}T${end}:00+08:00`;
const ends = ["09:40", "09:45", "09:50", "09:55", "10:00", "10:05"];

function calendar() {
  const dates: string[] = [];
  for (
    const cursor = new Date("2024-08-15T00:00:00Z");
    cursor <= new Date(`${end}T00:00:00Z`);
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const day = cursor.toISOString().slice(0, 10);
    if (
      cursor.getUTCDay() > 0 &&
      cursor.getUTCDay() < 6 &&
      !(day >= "2024-10-01" && day <= "2024-10-07") &&
      !["2024-09-16", "2024-09-17"].includes(day)
    )
      dates.push(day);
  }
  return dates;
}

function fixture(): ExecutionRealityInput {
  const dates = calendar();
  const bars = dates.map((date) => ({
    date,
    open: date === sellDate ? 10.8 : 10,
    high: 12,
    low: 9,
    close: date === firstFill ? 10.2 : date === sellDate ? 10.8 : 10,
    volume: 100_000,
    amount: date === firstFill ? 100_000_000 : 1_000_000,
  }));
  return {
    portfolioSourceHash: "a".repeat(64),
    portfolio: {
      market: "cn-equity",
      start,
      end,
      calendar: dates,
      instruments: [
        {
          symbol,
          market: "cn-equity",
          bars,
          signalBars: bars,
          execution: {
            tradable: true,
            evidence: "fixture",
            limitDown: null,
            limitUp: null,
          },
        },
      ],
      strategies: [
        {
          id: "frozen",
          version: 1,
          market: "cn-equity",
          period: "day",
          universe: { kind: "symbols", symbols: [symbol] },
          entry: { kind: "constant", value: false },
          exit: { rule: { kind: "constant", value: false } },
          sizing: { kind: "weight", weight: 1 },
          sleeve: "test",
        },
      ],
      sleeves: [{ id: "test", share: 1, riskPerTrade: 1, maxPositions: 1 }],
      costs: {
        version: "cost-experiment-1",
        commissionBps: 3,
        minimumCommission: 0,
        sellTaxBps: 0,
        slippageBps: 5,
      },
      scheduledTargets: [
        {
          strategyId: "frozen",
          date: start,
          availableAt: start,
          sourceHash: "b".repeat(64),
          targets: { [symbol]: 0.105 },
        },
        {
          strategyId: "frozen",
          date: firstFill,
          availableAt: firstFill,
          sourceHash: "c".repeat(64),
          targets: {},
        },
      ],
    },
    impact: { model: "sqrt", coefficientBps: 500 },
  };
}

type Row = {
  date: string;
  end: string;
  price: number;
  low?: number;
  volume: number;
  amount?: number;
};
const morning = (date: string, prices: readonly number[]): Row[] => [
  { date, end: "09:35", price: 15, volume: 100 },
  ...ends.map((end, i) => ({
    date,
    end,
    price: prices[i]!,
    volume: 100 * (i + 1),
  })),
];

function lc5Fixture(
  rows: Row[],
  override: ExecutionRealityVolumeEvidence["byEnd"] = {},
  sourceSymbol = symbol,
) {
  const bytes = Buffer.alloc(rows.length * 32);
  const byEnd: Record<string, ExecutionRealityVolumeEvidence["byEnd"][string]> =
    {};
  for (const [index, row] of rows.entries()) {
    const offset = index * 32;
    bytes.writeUInt16LE(
      (2024 - 2004) * 2048 + +row.date.slice(5, 7) * 100 + +row.date.slice(8),
      offset,
    );
    bytes.writeUInt16LE(
      +row.end.slice(0, 2) * 60 + +row.end.slice(3),
      offset + 2,
    );
    bytes.writeFloatLE(row.price, offset + 4);
    bytes.writeFloatLE(row.price + 0.15, offset + 8);
    bytes.writeFloatLE(row.low ?? row.price - 0.15, offset + 12);
    bytes.writeFloatLE(row.price, offset + 16);
    bytes.writeFloatLE(row.amount ?? row.volume * row.price, offset + 20);
    bytes.writeUInt32LE(row.volume, offset + 24);
    byEnd[endLabel(row.date, row.end)] = {
      quality: "actual",
      volumeUnit: sourceSymbol === symbol ? "shares" : "fund-units",
      amountUnit: "CNY",
    };
  }
  return {
    symbol: sourceSymbol,
    bytes,
    referenceYear: 2024,
    volumeEvidence: {
      sourceHash: createHash("sha256").update(bytes).digest("hex"),
      auditHash: "d".repeat(64),
      byEnd: { ...byEnd, ...override },
    },
  };
}

const buyRows = () => morning(firstFill, [10.1, 10.3, 10.4, 10.6, 10.8, 11]);
const sellRows = () => morning(sellDate, [10.8, 10.8, 10.8, 10.8, 10.8, 10.8]);
const run = (
  input: ExecutionRealityInput,
  window: ExecutionRealityWindow = "open",
) => {
  const report = buildExecutionRealityReport(input);
  return [...report.matrix, ...report.additionalScenarios].find(
    (row) => row.window === window && row.initial === 100_000,
  )!;
};

describe("LC5 volume and right-end evidence", () => {
  it("uses the exact 09:40, 09:50 and 10:05 labels and volume-weights all six intervals", () => {
    const source = parseExecutionRealityLc5(lc5Fixture(buyRows()));
    expect(source.window(firstFill, "09:35-09:40")).toMatchObject({
      referencePrice: 10.1,
      quantity: 100,
      intervalEnds: [endLabel(firstFill, "09:40")],
    });
    expect(source.window(firstFill, "09:45-09:50")).toMatchObject({
      referencePrice: 10.4,
      quantity: 300,
    });
    expect(source.window(firstFill, "10:00-10:05")).toMatchObject({
      referencePrice: 11,
      quantity: 600,
    });
    expect(source.window(firstFill, "09:35-10:05")).toMatchObject({
      status: "available",
      quantity: 2100,
      amount: 22_430,
      referencePrice: 22_430 / 2100,
      intervalEnds: ends.map((end) => endLabel(firstFill, end)),
    });
  });

  it("rejects the missing, duplicate, estimated, unaudited and wrong-unit interval and still permits an unaffected sibling", () => {
    const rows = buyRows();
    const at = endLabel(firstFill, "09:40");
    const duplicates = [rows[0]!, rows[1]!, rows[1]!, ...rows.slice(2)];
    const assertUnavailable = (
      input: Parameters<typeof parseExecutionRealityLc5>[0],
      reason: string,
    ) => {
      const source = parseExecutionRealityLc5(input);
      expect(source.window(firstFill, "09:35-09:40")).toEqual({
        status: "unavailable",
        reason,
        intervalEnd: at,
      });
      expect(source.window(firstFill, "09:35-10:05")).toMatchObject({
        status: "unavailable",
        reason,
      });
      if (input.volumeEvidence)
        expect(source.window(firstFill, "09:45-09:50")).toMatchObject({
          status: "available",
        });
    };
    assertUnavailable(
      lc5Fixture(rows.filter((row) => row.end !== "09:40")),
      "missing-interval",
    );
    assertUnavailable(lc5Fixture(duplicates), "duplicate-interval");
    assertUnavailable(
      lc5Fixture(rows, {
        [at]: { quality: "estimated", volumeUnit: "shares", amountUnit: "CNY" },
      }),
      "estimated-volume",
    );
    assertUnavailable(
      { ...lc5Fixture(rows), volumeEvidence: undefined },
      "unverified-volume",
    );
    assertUnavailable(
      lc5Fixture(rows, {
        [at]: {
          quality: "actual",
          volumeUnit: "fund-units",
          amountUnit: "CNY",
        },
      }),
      "invalid-units",
    );
    assertUnavailable(
      lc5Fixture(
        rows.map((row) =>
          row.end === "09:40" ? { ...row, amount: 100 * 1010 } : row,
        ),
      ),
      "amount-volume-outside-ohlc",
    );
    const etf = parseExecutionRealityLc5(lc5Fixture(rows, {}, "sh510300"));
    expect(etf.window(firstFill, "09:35-09:40")).toMatchObject({
      status: "available",
      volumeUnit: "fund-units",
    });
  });

  it("binds the external evidence to the frozen LC5 bytes and rejects malformed records", () => {
    const source = lc5Fixture(buyRows());
    expect(() =>
      parseExecutionRealityLc5({
        ...source,
        bytes: Buffer.alloc(source.bytes.length),
      }),
    ).toThrow("does not identify");
    expect(() =>
      parseExecutionRealityLc5({
        ...source,
        bytes: Buffer.alloc(31),
        volumeEvidence: undefined,
      }),
    ).toThrow("32 字节");
  });
});

describe("frozen capital and execution-window scenarios", () => {
  it("uses identical frozen target hashes across nine primary and six supplemental scenarios and posts actual lots and commissions", () => {
    const input = fixture();
    input.lc5 = [
      parseExecutionRealityLc5(lc5Fixture([...buyRows(), ...sellRows()])),
    ];
    const snapshot = JSON.stringify(input.portfolio);
    const report = buildExecutionRealityReport(input);
    expect(report.matrix).toHaveLength(9);
    expect(report.additionalScenarios).toHaveLength(6);
    expect(
      report.matrix.map(({ initial, window }) => [initial, window]),
    ).toEqual([
      [100_000, "open"],
      [100_000, "09:35-09:40"],
      [100_000, "09:45-09:50"],
      [300_000, "open"],
      [300_000, "09:35-09:40"],
      [300_000, "09:45-09:50"],
      [1_000_000, "open"],
      [1_000_000, "09:35-09:40"],
      [1_000_000, "09:45-09:50"],
    ]);
    expect(
      report.matrix[0]!.fills.map((fill) => fill.quote.targetSourceHash),
    ).toEqual(["b".repeat(64), "c".repeat(64)]);
    expect(report.matrix[1]!.fills[0]!.quote.targetSourceHash).toBe(
      "b".repeat(64),
    );
    expect(
      report.matrix[0]!.fills.map(({ side, quantity, price, fee }) => [
        side,
        quantity,
        price,
        fee,
      ]),
    ).toEqual([
      ["buy", 1000, 10.06, 5],
      ["sell", 1000, 10.77, 5],
    ]);
    expect(report.matrix[0]!.finalCash).toBe(100_700);
    expect(report.matrix[0]!.minimumCommissionDrag).toBeCloseTo(
      5 - 3.018 + (5 - 3.231),
      9,
    );
    expect(report.matrix[0]!.fills[0]!.instrumentRule).toMatchObject({
      minimumBuyQuantity: 100,
      buyQuantityStep: 100,
      priceTick: 0.01,
    });
    expect(report.matrix[3]!.fills[0]!.fee).toBeGreaterThan(5);
    expect(buildExecutionRealityReport(input)).toEqual(report);
    expect(JSON.stringify(input.portfolio)).toBe(snapshot);
  });

  it("prices both square-root and linear impact at the executed notional using exactly the prior 20 sessions", () => {
    const input = fixture();
    const [buy, sell] = run(input).fills;
    expect(buy!.quote.adv20).toEqual({
      amount: 1_000_000,
      missingDates: [],
      dates: input.portfolio.calendar.slice(
        input.portfolio.calendar.indexOf(firstFill) - 20,
        input.portfolio.calendar.indexOf(firstFill),
      ),
    });
    expect(buy!.advParticipation).toBe(0.01);
    expect(buy!.modeledSlippageBps).toBe(55);
    expect(sell!.quote.adv20!.amount).toBe(5_950_000);
    expect(sell!.advParticipation).toBeCloseTo(10_800 / 5_950_000, 12);
    expect(sell!.modeledSlippageBps).toBeCloseTo(
      5 + 500 * Math.sqrt(10_800 / 5_950_000),
      10,
    );
    expect(sell!.realizedSlippageBps).toBeGreaterThan(0);
    expect(sell!.quote.openGapPct).toBeGreaterThan(3);
    const linear = run({
      ...input,
      impact: { model: "linear", coefficientBps: 500 },
    }).fills[0]!;
    expect(linear.modeledSlippageBps).toBe(10);
    expect(linear.price).toBe(10.01);
  });

  it("rejects buy chase at the true open, window VWAP or final impacted tick while permitting a sell above the same limit", () => {
    const input = fixture();
    input.lc5 = [
      parseExecutionRealityLc5(lc5Fixture([...buyRows(), ...sellRows()])),
    ];
    const window = run(input, "09:45-09:50");
    expect(window.rejections[0]).toMatchObject({
      reason: "max-open-gap-exceeded",
      quote: {
        status: "rejected",
        gapTrigger: "window-vwap",
        open: 10,
        rejectedPrice: 10.4,
        buyPriceCeiling: 10.3,
        openingReference: { date: start, price: 10 },
      },
    });
    expect(
      window.daily.find(({ date }) => date === firstFill)!.dailyReturn,
    ).toBe(0);
    const impacted = run({ ...input, maxOpenGapPct: 0.5 });
    expect(impacted.rejections[0]).toMatchObject({
      reason: "max-open-gap-exceeded",
      quote: {
        gapTrigger: "impacted-price",
        rejectedPrice: 10.06,
        rejectedQuantity: 1000,
      },
    });
    expect(run({ ...input, maxOpenGapPct: 0.6 }).fills[0]!.price).toBe(10.06);
    const original = input.portfolio.instruments[0]!;
    const bars = original.bars.map((bar) =>
      bar.date === firstFill ? { ...bar, open: 10.31 } : bar,
    );
    const openedHigh = run({
      ...input,
      portfolio: {
        ...input.portfolio,
        instruments: [{ ...original, bars, signalBars: bars }],
      },
    });
    expect(openedHigh.rejections[0]).toMatchObject({
      reason: "max-open-gap-exceeded",
      quote: { gapTrigger: "opening-price", rejectedPrice: 10.31 },
    });
    expect(run(input).fills[1]).toMatchObject({
      side: "sell",
      quote: { buyPriceCeiling: null, status: "available" },
    });
  });

  it("marks unavailable intraday or stale-gap evidence and rejects a missing prior amount without using another session", () => {
    const input = fixture();
    const missingMinutes = run(input, "09:35-09:40");
    expect(missingMinutes.rejections[0]).toMatchObject({
      reason: "missing-minute-source",
      quote: { status: "missing" },
    });
    const original = input.portfolio.instruments[0]!;
    const missingDate =
      input.portfolio.calendar[
        input.portfolio.calendar.indexOf(firstFill) - 10
      ]!;
    const missingAmount = original.bars.map((bar) =>
      bar.date === missingDate ? { ...bar, amount: 0 } : bar,
    );
    const adv = run({
      ...input,
      portfolio: {
        ...input.portfolio,
        instruments: [
          { ...original, bars: missingAmount, signalBars: missingAmount },
        ],
      },
    });
    expect(adv.rejections[0]).toMatchObject({
      reason: "missing-adv20",
      quote: {
        adv20: { amount: null, missingDates: [missingDate] },
        status: "missing",
      },
    });
    expect(adv.rejections[0]!.quote!.adv20!.dates).toHaveLength(20);
    const missingPrevious = original.bars.filter(({ date }) => date !== start);
    const stale = run({
      ...input,
      portfolio: {
        ...input.portfolio,
        instruments: [
          { ...original, bars: missingPrevious, signalBars: missingPrevious },
        ],
      },
    });
    expect(stale.rejections[0]).toMatchObject({
      reason: "missing-opening-reference",
      quote: { openingReference: null, status: "missing" },
    });
  });

  it("reports a target smaller than the minimum lot without filling fractional shares", () => {
    const input = fixture();
    input.portfolio.scheduledTargets = [
      { ...input.portfolio.scheduledTargets[0]!, targets: { [symbol]: 0.006 } },
    ];
    const report = buildExecutionRealityReport(input);
    expect(report.matrix[0]).toMatchObject({
      fills: [],
      finalCash: 100_000,
      lotOrBudgetRejections: 1,
    });
    expect(report.matrix[3]!.fills[0]).toMatchObject({ quantity: 100, fee: 5 });
  });

  it("shares the exact observed minute quantity across sleeves without filling a second lot", () => {
    const input = fixture();
    const strategy = input.portfolio.strategies[0]!;
    const target = input.portfolio.scheduledTargets[0]!;
    input.portfolio.end = firstFill;
    input.portfolio.strategies = [
      strategy,
      { ...strategy, id: "other", sleeve: "z-other" },
    ];
    input.portfolio.sleeves = [
      { ...input.portfolio.sleeves[0]!, share: 0.5 },
      { ...input.portfolio.sleeves[0]!, id: "z-other", share: 0.5 },
    ];
    input.portfolio.scheduledTargets = [
      target,
      { ...target, strategyId: "other" },
    ];
    input.lc5 = [parseExecutionRealityLc5(lc5Fixture(buyRows()))];
    const window = run(input, "09:35-09:40");
    expect(
      window.fills.map(({ sleeve, quantity }) => [sleeve, quantity]),
    ).toEqual([["test", 100]]);
    expect(window.fills[0]!.quote.windowQuantity).toBe(100);
    expect(window.rejections).toHaveLength(1);
    expect(window.rejections[0]!.quote).toMatchObject({
      status: "available",
      windowQuantity: 100,
    });
    expect(window.dailyCoverage.nullDays).toBe(0);
  });

  it("fixes staged quantities at the auction and charges six child commissions at six causal prices", () => {
    const input = fixture();
    input.maxOpenGapPct = null;
    input.portfolio.end = firstFill;
    input.impact = { model: "linear", coefficientBps: 0 };
    input.portfolio.costs = { ...input.portfolio.costs!, slippageBps: 0 };
    const rows = buyRows().map((row) => ({ ...row, volume: 1000 }));
    input.lc5 = [parseExecutionRealityLc5(lc5Fixture(rows))];
    const staged = run(input, "09:35-10:05");
    expect(
      staged.fills.map(({ quote, quantity, fee, price }) => [
        quote.sliceEnd,
        quote.plannedQuantity,
        quantity,
        fee,
        price,
      ]),
    ).toEqual([
      ["09:40", 200, 200, 5, 10.1],
      ["09:45", 200, 200, 5, 10.3],
      ["09:50", 200, 200, 5, 10.4],
      ["09:55", 200, 200, 5, 10.6],
      ["10:00", 100, 100, 5, 10.8],
      ["10:05", 100, 100, 5, 11],
    ]);
    expect(
      new Set(staged.fills.map(({ quote }) => quote.parentOrderId)).size,
    ).toBe(1);
    expect(
      staged.fills.every(
        ({ quote }) =>
          quote.parentOrderId !== null && quote.intervalEnds.length === 1,
      ),
    ).toBe(true);
    expect(staged.totalFees).toBe(30);
    expect(staged.finalCash).toBe(89_510);
    expect(staged.daily.at(-1)!.equity).toBe(99_710);
    const single = run(input);
    expect(single.fills.map(({ quantity, fee }) => [quantity, fee])).toEqual([
      [1000, 5],
    ]);
    expect(single.finalCash).toBe(89_995);
    expect(single.daily.at(-1)!.equity).toBe(100_195);

    input.lc5 = [
      parseExecutionRealityLc5(
        lc5Fixture(rows.filter(({ end }) => end !== "09:45")),
      ),
    ];
    const missing = run(input, "09:35-10:05");
    expect(missing.rejections[0]).toMatchObject({
      reason: "missing-interval",
      quote: { sliceEnd: "09:45", plannedQuantity: 200, status: "missing" },
    });
    expect(
      missing.fills.map(({ quantity, conditionalOnUncertainExecution }) => [
        quantity,
        conditionalOnUncertainExecution,
      ]),
    ).toEqual([
      [200, false],
      [200, true],
      [200, true],
      [100, true],
      [100, true],
    ]);
    expect(missing.performance).toBeNull();
  });

  it("leaves a daily-only ATR protection trigger unknown after a delayed entry", () => {
    const input = fixture();
    input.portfolio.end = firstFill;
    input.portfolio.riskPolicy = { riskPerTrade: 0.02, atrStopMultiple: 1 };
    const instrument = input.portfolio.instruments[0]!;
    const bars = instrument.bars.map((bar) => ({
      ...bar,
      high: bar.date === sellDate ? 11 : 10.3,
      low: bar.date === firstFill ? 8 : 9.8,
    }));
    input.portfolio.instruments = [{ ...instrument, bars, signalBars: bars }];
    input.lc5 = [parseExecutionRealityLc5(lc5Fixture(buyRows()))];
    const delayed = run(input, "09:35-09:40");
    expect(delayed.fills.map(({ side }) => side)).toEqual(["buy"]);
    expect(delayed.rejections).toContainEqual(
      expect.objectContaining({
        reason: "ambiguous-protection-chronology",
        quote: expect.objectContaining({
          phase: "protection",
          status: "missing",
          referencePrice: null,
        }),
      }),
    );
    expect(delayed.firstUncertainExecutionDate).toBe(firstFill);
    expect(delayed.performance).toBeNull();
  });

  it("marks a delayed sale's chronology unknown when a daily stop is crossed and the opening prefix is incomplete", () => {
    const input = fixture();
    input.portfolio.end = sellDate;
    input.portfolio.riskPolicy = { riskPerTrade: 0.02, atrStopMultiple: 1 };
    const instrument = input.portfolio.instruments[0]!;
    const bars = instrument.bars.map((bar) => ({
      ...bar,
      high: bar.date === sellDate ? 11 : 10.3,
      low: bar.date === sellDate ? 8 : 9.9,
    }));
    input.portfolio.instruments = [{ ...instrument, bars, signalBars: bars }];
    input.lc5 = [
      parseExecutionRealityLc5(
        lc5Fixture([...buyRows(), ...sellRows().slice(1)]),
      ),
    ];
    const delayed = run(input, "09:35-09:40");
    expect(delayed.fills.map(({ side }) => side)).toEqual(["buy"]);
    expect(delayed.rejections).toContainEqual(
      expect.objectContaining({
        date: sellDate,
        reason: "ambiguous-protection-chronology",
        quote: expect.objectContaining({
          phase: "opening",
          side: "sell",
          status: "missing",
        }),
      }),
    );
    expect(delayed.firstUncertainExecutionDate).toBe(sellDate);
    expect(
      delayed.daily.find(({ date }) => date === firstFill)!.equity,
    ).not.toBeNull();
    expect(delayed.daily.at(-1)).toMatchObject({
      equity: null,
      reason: "unknown-execution",
    });
  });

  function standingStopFixture(
    windowPrice: number,
    afternoonLow: number,
    firstLow = 10.05,
  ) {
    const input = fixture();
    input.portfolio.end = sellDate;
    input.portfolio.riskPolicy = {
      atrStopMultiple: 0.5,
      riskPerTrade: 1,
      maxSingleInstrumentWeight: 1,
      maxIndustryWeight: 1,
      maxTotalStopRisk: 1,
    };
    input.portfolio.scheduledTargets = [
      { ...input.portfolio.scheduledTargets[0]!, targets: { [symbol]: 0.06 } },
      { ...input.portfolio.scheduledTargets[1]!, targets: { [symbol]: 0.12 } },
    ];
    const instrument = input.portfolio.instruments[0]!;
    const bars = instrument.bars.map((bar) => ({
      ...bar,
      open: 10.2,
      close: 10.2,
      high: 11,
      low: bar.date === sellDate ? Math.min(firstLow, afternoonLow) : 10.05,
    }));
    input.portfolio.instruments = [{ ...instrument, bars, signalBars: bars }];
    input.portfolio.costs = { ...input.portfolio.costs!, slippageBps: 0 };
    input.impact = { model: "linear", coefficientBps: 0 };
    const rows = [
      ...["09:35", ...ends].map((end) => ({
        date: firstFill,
        end,
        price: 10.2,
        volume: 10_000,
      })),
      {
        date: sellDate,
        end: "09:35",
        price: 10.2,
        low: firstLow,
        volume: 10_000,
      },
      ...ends.map((end) => ({
        date: sellDate,
        end,
        price: windowPrice,
        volume: 10_000,
      })),
      {
        date: sellDate,
        end: "14:00",
        price: 10.2,
        low: afternoonLow,
        volume: 10_000,
      },
    ];
    input.lc5 = [parseExecutionRealityLc5(lc5Fixture(rows))];
    return input;
  }

  it.each([
    "09:35-09:40",
    "09:45-09:50",
    "10:00-10:05",
    "09:35-10:05",
  ] as const)(
    "preserves every morning buy fill and chase rejection in %s when only the 14:00 low crosses the standing stop",
    (window) => {
      const compare = (price: number) => {
        const normal = run(standingStopFixture(price, 10.05), window);
        const afternoonStop = run(standingStopFixture(price, 8.5), window);
        const openingBuys = (scenario: typeof normal) => ({
          fills: scenario.fills.filter(
            (fill) => fill.date === sellDate && fill.side === "buy",
          ),
          rejections: scenario.rejections.filter(
            ({ date, quote }) =>
              date === sellDate &&
              quote?.phase === "opening" &&
              quote.side === "buy",
          ),
        });
        expect(openingBuys(afternoonStop)).toEqual(openingBuys(normal));
        return openingBuys(normal);
      };
      const bought = compare(10.2);
      expect(bought.fills.length).toBeGreaterThan(0);
      expect(bought.fills.every(({ price }) => price === 10.2)).toBe(true);
      expect(bought.rejections).toEqual([]);
      const chased = compare(10.8);
      expect(chased.fills).toEqual([]);
      expect(chased.rejections.length).toBeGreaterThan(0);
      expect(
        chased.rejections.every(
          ({ reason, quote }) =>
            reason === "max-open-gap-exceeded" && quote?.rejectedPrice === 10.8,
        ),
      ).toBe(true);
    },
  );

  it("detects a standing stop touched before the selected execution window starts", () => {
    const delayed = run(standingStopFixture(10.2, 10.05, 8.5), "09:45-09:50");
    expect(delayed.fills.filter(({ date }) => date === sellDate)).toEqual([]);
    expect(delayed.rejections).toContainEqual(
      expect.objectContaining({
        date: sellDate,
        reason: "ambiguous-protection-chronology",
        quote: expect.objectContaining({
          phase: "opening",
          side: "buy",
          status: "missing",
        }),
      }),
    );
  });

  it("executes account drawdown reductions at the next open in a staged scenario", () => {
    const input = standingStopFixture(10.2, 10.05);
    input.portfolio.riskPolicy = {
      ...input.portfolio.riskPolicy,
      atrStopMultiple: 2,
    };
    input.portfolio.scheduledTargets = [
      {
        ...input.portfolio.scheduledTargets[0]!,
        targets: { [symbol]: 1 },
      },
    ];
    const instrument = input.portfolio.instruments[0]!;
    const bars = instrument.bars.map((bar) =>
      bar.date === firstFill ? { ...bar, close: 9.6, low: 9.6 } : bar,
    );
    input.portfolio.instruments = [{ ...instrument, bars, signalBars: bars }];
    const delayed = run(input, "09:35-10:05");
    const sales = delayed.fills.filter(({ side }) => side === "sell");
    expect(sales).toMatchObject([
      {
        date: sellDate,
        price: 10.2,
        quantity: 4_900,
        holdingAfter: 4_900,
        quote: { window: "open", phase: "opening", sliceEnd: null },
      },
    ]);
    expect(delayed.rejections).toEqual([]);
  });

  it("counts a missing auction input even when it prevents defining the staged child orders", () => {
    const input = fixture();
    const instrument = input.portfolio.instruments[0]!;
    const bars = instrument.bars.filter(({ date }) => date !== firstFill);
    input.portfolio.instruments = [{ ...instrument, bars, signalBars: bars }];
    input.lc5 = [parseExecutionRealityLc5(lc5Fixture(buyRows()))];
    const staged = run(input, "09:35-10:05");
    expect(staged.fills).toEqual([]);
    expect(staged.rejections[0]!.quote).toMatchObject({
      reason: "missing-auction-planning-input",
      status: "missing",
      sliceEnd: null,
      plannedQuantity: null,
    });
    expect(staged.executionCoverage).toMatchObject({
      requestedQuotes: 1,
      missingQuotes: 1,
    });
    expect(staged.firstUncertainExecutionDate).toBe(firstFill);
    expect(staged.performance).toBeNull();
  });

  it("slices four exact crisis bounds from the continuous daily return stream and propagates missing quotes", () => {
    expect(
      executionRealityCrises.map(({ start, end }) => [start, end]),
    ).toEqual([
      ["2015-06-12", "2015-09-15"],
      ["2018-01-29", "2018-12-28"],
      ["2022-01-04", "2024-02-05"],
      ["2024-09-24", "2024-10-18"],
    ]);
    const input = fixture();
    const first = run(input).crisisSlices[3]!;
    expect(first.insufficientCoverage).toBe(false);
    expect(first.coveredDays).toBe(first.points.length);
    expect(first.points[0]!.nav).toBeCloseTo(1.00135, 12);
    expect(first.points[0]!.dailyReturn).toBeCloseTo(0.00135, 12);
    expect(first.periodReturn).toBeCloseTo(0.007, 12);
    expect(first.maxDrawdown).toBe(0);
    const gap = run(input, "09:35-09:40").crisisSlices[3]!;
    expect(gap).toMatchObject({
      insufficientCoverage: true,
      performance: null,
      periodReturn: null,
      maxDrawdown: null,
      reason: "incomplete-daily-returns",
    });
    expect(gap.points[0]).toMatchObject({
      equity: null,
      nav: null,
      dailyReturn: null,
    });
    expect(gap.points[1]).toMatchObject({
      equity: null,
      nav: null,
      dailyReturn: null,
      reason: "unknown-execution",
    });
    expect(gap.coverage.nullDays).toBe(gap.points.length);
    expect(run(input, "09:35-09:40")).toMatchObject({
      performance: null,
      firstUncertainExecutionDate: firstFill,
      finalCash: null,
    });
    expect(run(input).crisisSlices[0]).toMatchObject({
      coveredDays: 0,
      insufficientCoverage: true,
      reason: "calendar-does-not-cover-window",
    });
  });

  it("preserves the pre-crisis holding and NAV across all four windows", () => {
    const input = fixture();
    const { portfolio } = input;
    const dates: string[] = [];
    for (
      const cursor = new Date("2015-04-01T00:00:00Z");
      cursor <= new Date(`${end}T00:00:00Z`);
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      if (cursor.getUTCDay() > 0 && cursor.getUTCDay() < 6)
        dates.push(cursor.toISOString().slice(0, 10));
    }
    const closes = new Map(
      executionRealityCrises.flatMap(
        ({ start, end }) =>
          [
            [dates[dates.indexOf(start) - 1]!, 12],
            [start, 11],
            [end, 10],
          ] as const,
      ),
    );
    const bars = dates.map((date) => ({
      date,
      open: 10,
      high: 12,
      low: 10,
      close: closes.get(date) ?? 10,
      volume: 100_000,
      amount: 1_000_000,
    }));
    portfolio.start = "2015-05-04";
    portfolio.calendar = dates;
    portfolio.instruments = [
      { ...portfolio.instruments[0]!, bars, signalBars: bars },
    ];
    portfolio.scheduledTargets = [
      {
        ...portfolio.scheduledTargets[0]!,
        date: portfolio.start,
        availableAt: portfolio.start,
      },
    ];
    portfolio.costs = { ...portfolio.costs!, slippageBps: 0 };
    input.impact = { model: "linear", coefficientBps: 0 };
    input.includeExtendedWindows = false;

    const result = run(input);
    expect(
      result.fills.map(({ quantity, price, fee }) => [quantity, price, fee]),
    ).toEqual([[1000, 10, 5]]);
    // One 1,000-share purchase leaves 89,995 cash. Every window starts
    // after a 12 CNY close, so NAV goes from 1.01995 to 1.00995 to 0.99995.
    for (const slice of result.crisisSlices) {
      expect(slice.insufficientCoverage).toBe(false);
      expect(slice.coveredDays).toBe(slice.points.length);
      expect(slice.points[0]!.nav).toBeCloseTo(100_995 / 100_000, 12);
      expect(slice.points[0]!.dailyReturn).toBeCloseTo(
        100_995 / 101_995 - 1,
        12,
      );
      expect(slice.points.at(-1)!.nav).toBeCloseTo(99_995 / 100_000, 12);
      expect(slice.periodReturn).toBeCloseTo(99_995 / 101_995 - 1, 12);
      expect(slice.maxDrawdown).toBeCloseTo(1 - 99_995 / 101_995, 12);
    }
  });
});
