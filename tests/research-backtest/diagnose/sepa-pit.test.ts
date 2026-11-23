import { expect, it } from "vitest";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import {
  projectFinancialFields,
  type FinancialReportSnapshot,
} from "tstdx/financial-model";
import { strategyObjectSchema } from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import { defaultExecutionCosts } from "trading-strategy-core/costs";
import { buildSepaPitSeries } from "~/server/financial/sepa-pit-series";
import {
  attachGrowthPitSignals,
  buildGrowthExitSeries,
  evaluateMarketRegimeAtDates,
  GROWTH_PIT_STRATEGY_KEYS,
  growthPitRulesFor,
  type GrowthPitStrategyKey,
} from "../../../scripts/lib/backtest-diagnose/growth-pit";

const symbol = "sz300750";
const latestPeriod = "2025-12-31";
const announced = "2026-03-27";
const available = "2026-03-30";
const tradeDate = (i: number) =>
  new Date(Date.UTC(2025, 3, i + 1)).toISOString().slice(0, 10);

function bar(date: string, close = 100, volume = 100_000): Bar {
  return {
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume,
    amount: close * volume,
  };
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
  raw[5] = 60;
  raw[196] = 60;
  raw[229] = revenue;
  raw[231] = profit;
  raw[280] = roe;
  return {
    symbol,
    financialCompany: false,
    reportDate,
    announcementDate,
    availableFrom,
    sourceFilename: `gpcw${reportDate.replaceAll("-", "")}.dat`,
    sourceSha256: "fixture",
    contentSha256: "fixture",
    recordOffset: 0,
    mappingVersion: "fixture",
    fields: projectFinancialFields(raw, false, [5, 196, 229, 231, 280]),
    warnings: [],
  };
}

const earnings = (
  latest = report(latestPeriod, announced, available, 125, 25),
) => [
  report("2024-09-30", "2024-10-28", "2024-10-29", 100, 10),
  report("2024-12-31", "2025-03-25", "2025-03-26", 100, 12),
  report("2025-09-30", "2025-10-23", "2025-10-24", 125, 16),
  latest,
];

it("keeps the Friday announcement invisible until the observed Monday trading day", () => {
  const reports = earnings();
  const result = buildSepaPitSeries(reports, [bar(announced), bar(available)]);
  expect(result).toMatchObject({
    strictReportCount: 4,
    reportDateRange: ["2024-09-30", latestPeriod],
    strictPassDays: 1,
    incompleteDays: 1,
    tolerantPassDays: 0,
    failedDays: 0,
  });
  expect(result.days).toMatchObject([
    {
      date: announced,
      gate: "incomplete",
      latestReportDate: "2025-09-30",
      qualifiedStrict: false,
      qualifiedTolerant: false,
    },
    {
      date: available,
      gate: "strict-pass",
      latestReportDate: latestPeriod,
      latestAvailableFrom: available,
      strictCount: 4,
      qualifiedStrict: true,
      qualifiedTolerant: true,
    },
  ]);
  const invalid = { ...reports.at(-1)!, availableFrom: announced };
  expect(
    buildSepaPitSeries([...reports.slice(0, -1), invalid], [bar(available)])
      .days[0]?.latestReportDate,
  ).toBe("2025-09-30");
});

it("uses FN281 percent, exposes strict and tolerant gates and preserves unknown data", () => {
  const tolerant = buildSepaPitSeries(
    earnings(report(latestPeriod, announced, available, 119, 25, 16)),
    [bar(available)],
  );
  expect(tolerant).toMatchObject({
    tolerantPassDays: 1,
    strictPassDays: 0,
    days: [
      {
        gate: "tolerant-pass",
        strictCount: 2,
        qualifiedStrict: false,
        qualifiedTolerant: true,
        strictChecks: {
          revenueGrowthTwoQuarters20: false,
          profitGrowthTwoQuarters25: true,
          margin15AndImproving: true,
          annualWeightedRoe17: false,
        },
      },
    ],
  });
  const failed = buildSepaPitSeries(
    earnings(report(latestPeriod, announced, available, 119, 25, 13)),
    [bar(available)],
  );
  expect(failed).toMatchObject({
    failedDays: 1,
    days: [{ gate: "failed", qualifiedTolerant: false }],
  });
  const incomplete = buildSepaPitSeries(
    earnings(report(latestPeriod, announced, available, 125, 25, 0)),
    [bar(available)],
  );
  expect(incomplete.days[0]).toMatchObject({
    gate: "incomplete",
    strictChecks: { annualWeightedRoe17: null },
  });
});

it("includes exact 20% revenue and 25% profit growth at the strict threshold", () => {
  const reports = earnings(report(latestPeriod, announced, available, 120, 20));
  // 20/120 > 16/100, so the margin also meets the strict gate.
  reports[1] = report("2024-12-31", "2025-03-25", "2025-03-26", 100, 16);
  const latest = buildSepaPitSeries(reports, [bar(available)]).days[0];
  expect(latest).toMatchObject({
    gate: "strict-pass",
    strictChecks: {
      revenueGrowthTwoQuarters20: true,
      profitGrowthTwoQuarters25: true,
    },
  });
});

it.each([-12, 0])(
  "never computes growth from a nonpositive prior-year profit base (%s)",
  (prior) => {
    const reports = earnings();
    reports[1] = report("2024-12-31", "2025-03-25", "2025-03-26", 100, prior);
    const latest = buildSepaPitSeries(reports, [bar(available)]).days[0];
    expect(latest?.strictChecks.profitGrowthTwoQuarters25).toBeNull();
    expect(latest?.gate).toBe("incomplete");
  },
);

it("does not substitute a nonconsecutive quarter or backfill an ambiguous duplicate", () => {
  const reports = earnings();
  const missing = buildSepaPitSeries(
    reports.filter((row) => row.reportDate !== "2025-09-30"),
    [bar(available)],
  );
  expect(missing.days[0]).toMatchObject({
    gate: "incomplete",
    strictChecks: {
      revenueGrowthTwoQuarters20: null,
      profitGrowthTwoQuarters25: null,
    },
  });

  const duplicate = {
    ...reports.at(-1)!,
    availableFrom: "2026-03-31",
    recordOffset: 500,
  };
  const result = buildSepaPitSeries(
    [...reports, duplicate],
    [bar(available), bar(duplicate.availableFrom)],
    {
      issues: [
        {
          filename: "gpcw20251231.dat",
          reason: "同一财报存在重复证券记录：300750",
        },
      ],
    },
  );
  expect(result.days).toMatchObject([
    { gate: "strict-pass" },
    {
      gate: "incomplete",
      latestReportDate: latestPeriod,
      latestAvailableFrom: null,
    },
  ]);
  expect(result.duplicateRecordIssues).toEqual([
    expect.objectContaining({
      file: "gpcw20251231.dat",
      symbol,
      recordOffsets: [0, 500],
    }),
    { file: "gpcw20251231.dat", message: "同一财报存在重复证券记录：300750" },
  ]);
  const sourceOnly = buildSepaPitSeries([], [], {
    issues: [
      {
        filename: "gpcw20251231.dat",
        reason: "同一财报存在重复证券记录：300750",
      },
    ],
  });
  expect(sourceOnly.duplicateRecordIssues).toEqual([
    result.duplicateRecordIssues[1],
  ]);
});

it("fails closed and counts unknown days when the index has a gap, ends early or lacks warmup", () => {
  const index = Array.from({ length: 285 }, (_, i) =>
    bar(tradeDate(i * 2), 300 + i),
  );
  const t = tradeDate(520);
  const gap = tradeDate(521);
  const afterLastBar = tradeDate(569);
  const result = evaluateMarketRegimeAtDates(index, [
    t,
    gap,
    afterLastBar,
    tradeDate(496),
  ]);
  expect(result).toMatchObject({
    allowedDays: 1,
    blockedDays: 0,
    unknownDays: 3,
    days: [
      {
        date: t,
        indexDate: t,
        close: 560,
        ma50: 535.5,
        distributionDays25: 0,
        allowed: true,
      },
      {
        date: gap,
        indexDate: null,
        allowed: false,
        reason: "缺少当日沪深300行情",
      },
      {
        date: afterLastBar,
        indexDate: null,
        allowed: false,
        reason: "缺少当日沪深300行情",
      },
      {
        date: tradeDate(496),
        allowed: false,
        reason: "insufficient-history",
        ma250: null,
      },
    ],
  });
});

it("keeps the regime at t when future index bars in the same evaluation change", () => {
  const index = Array.from({ length: 285 }, (_, i) =>
    bar(tradeDate(i * 2), 300 + i),
  );
  const t = tradeDate(520);
  const later = tradeDate(568);
  const baseline = evaluateMarketRegimeAtDates(index, [t, later]);
  const changed = index.map((row) =>
    row.date > t ? bar(row.date, 1, 1_000_000) : row,
  );
  const mutated = evaluateMarketRegimeAtDates(changed, [t, later]);
  expect(baseline.days[0]).toMatchObject({ date: t, allowed: true });
  expect(mutated.days[0]).toEqual(baseline.days[0]);
  expect(baseline.days[1]?.allowed).toBe(true);
  expect(mutated.days[1]?.allowed).toBe(false);
});

it("blocks five distribution days", () => {
  const declining = [
    ...Array.from({ length: 261 }, (_, i) => bar(tradeDate(i * 2), 300 + i)),
    ...Array.from({ length: 5 }, (_, i) =>
      bar(tradeDate(522 + i * 2), 559 - i, 200_000 + i),
    ),
  ];
  const last = declining.at(-1)!;
  expect(evaluateMarketRegimeAtDates(declining, [last.date])).toMatchObject({
    blockedDays: 1,
    days: [
      { reason: "distribution", distributionDays20: 5, distributionDays25: 5 },
    ],
  });
});

function request(
  key: GrowthPitStrategyKey,
  bars: readonly Bar[],
  start = bars[0]!.date,
): PortfolioRequest {
  return {
    market: "cn-equity",
    initial: 100_000,
    start,
    end: bars.at(-1)!.date,
    calendar: bars.map((row) => row.date),
    instruments: [
      {
        symbol,
        market: "cn-equity",
        // A one-price session cannot fill through the conservative quote path.
        bars: bars.map((row) =>
          row.high === row.low ? { ...row, high: row.high + 0.01 } : row,
        ),
        signalBars: bars,
        execution: {
          evidence: "fixture",
          minimum: 100,
          step: 100,
          limitUp: null,
          limitDown: null,
          tradable: true,
        },
      },
    ],
    strategies: [
      strategyObjectSchema.parse({
        id: `diag-${key}`,
        version: 1,
        market: "cn-equity",
        period: "day",
        universe: { kind: "symbols", symbols: [symbol] },
        ...growthPitRulesFor(key),
        sizing: { kind: "weight", weight: 1 },
        sleeve: "diag",
      }),
    ],
    sleeves: [{ id: "diag", share: 1, riskPerTrade: 1, maxPositions: 1 }],
    costs: {
      ...defaultExecutionCosts,
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
      transferBps: 0,
    },
  };
}

function vcpBars() {
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
  return Array.from({ length: 373 }, (_, i) => {
    if (i >= 370) return bar(tradeDate(i), 116, 200);
    if (i < 310) return bar(tradeDate(i), 50 + i * 0.08, 100);
    const offset = i - 310;
    const right = knots.findIndex(([x]) => x >= offset);
    const [x1, y1] = knots[Math.max(0, right - 1)]!;
    const [x2, y2] = knots[right]!;
    const price = x1 === x2 ? y1 : y1 + ((y2 - y1) * (offset - x1)) / (x2 - x1);
    return bar(tradeDate(i), price, i >= 365 ? 10 : i >= 318 ? 40 : 100);
  });
}

it.each([
  "strict",
  "tolerant",
  "unavailable",
  "blocked",
  "missing-index",
] as const)(
  "attaches real SEPA VCP signals with %s PIT/market evidence",
  async (scenario) => {
    const bars = vcpBars();
    const key = "research-sepa-pit-m";
    const frozen = { request: request(key, bars, bars[365]!.date) };
    const delayed = report(latestPeriod, announced, bars[371]!.date, 125, 25);
    const tolerant = report(latestPeriod, announced, available, 119, 25, 16);
    const reports = earnings(
      scenario === "unavailable"
        ? delayed
        : scenario === "tolerant"
          ? tolerant
          : undefined,
    );
    const [disclosure] = await attachGrowthPitSignals(key, frozen, {
      tdxRoot: "D:/fixture-only",
      indexBars: bars
        .map(({ date }, i) =>
          bar(date, scenario === "blocked" ? 1000 - i : 300 + i),
        )
        .filter(
          ({ date }) =>
            scenario !== "missing-index" || date !== bars[370]!.date,
        ),
      readFinancialHistory: async () => ({ reports, issues: [] }),
    });
    const qualified = scenario !== "unavailable";
    const admitted =
      qualified && scenario !== "blocked" && scenario !== "missing-index";
    expect(disclosure?.marketRegime?.unknownDays).toBe(
      Number(scenario === "missing-index"),
    );
    expect(disclosure?.funnel).toEqual({
      priceSignals: 1,
      trendVcpSignals: 1,
      pitFinanceSignals: Number(qualified),
      marketRegimeSignals: Number(admitted),
      strictPitFinanceSignals: Number(qualified && scenario !== "tolerant"),
      tolerantPitFinanceSignals: Number(scenario === "tolerant"),
    });
    expect(
      frozen.request.instruments[0]?.external?.signals?.[370],
    ).toMatchObject({
      date: bars[370]!.date,
      availableAt: bars[370]!.date,
      entry: admitted,
    });
    expect(
      runPortfolio(frozen.request).fills.map((fill) => [fill.date, fill.side]),
    ).toEqual(admitted ? [[bars[371]!.date, "buy"]] : []);
  },
);

it("validates every growth strategy and executes holding-period, fixed protection and MA exits through runPortfolio", async () => {
  const signalIndex = 350;
  const fillIndex = signalIndex + 1;
  const dates = Array.from({ length: signalIndex + 11 }, (_, i) =>
    tradeDate(i),
  );
  const bars = dates.map((date, index) => {
    // The 102 fill makes the actual stop levels 93.84 and 94.86. Signal close is 100.
    if (index === fillIndex)
      return { ...bar(date), open: 102, high: 102, low: 94.2 };
    if (index === fillIndex + 1)
      return { ...bar(date, 101), open: 92.4, low: 92.2 };
    if (index === fillIndex + 2) return bar(date, 99);
    if (index === fillIndex + 3) return bar(date, 97);
    return bar(date);
  });
  for (const key of GROWTH_PIT_STRATEGY_KEYS)
    expect(request(key, bars).strategies[0]?.entry).toMatchObject({
      kind: "external",
      id: key,
    });

  for (const [key, sellOffset, price, reason] of [
    ["research-canslim-pit-m", 6, 100, "signal"],
    ["research-sepa-pit-m", 6, 100, "time"],
    ["research-canslim-pit-stop8", 1, 92.4, "stop"],
    ["research-canslim-pit-stop7", 1, 92.4, "stop"],
    ["research-canslim-pit-ma50", 3, 97, "signal"],
    ["research-canslim-pit-ma20", 3, 97, "signal"],
  ] satisfies [GrowthPitStrategyKey, number, number, string][]) {
    const input = request(key, bars, dates[signalIndex]);
    const [instrument] = input.instruments;
    await attachGrowthPitSignals(
      key,
      { request: input },
      {
        tdxRoot: "D:/fixture-only",
        indexBars: [],
        readFinancialHistory: async () => ({ reports: [], issues: [] }),
      },
    );
    // Supply the same isolated entry pulse to all exits. The production attachment supplies each exit row.
    instrument!.external!.signals = instrument!.external!.signals!.map(
      (row, index) => ({ ...row, entry: index === signalIndex }),
    );
    const result = runPortfolio(input);
    expect(
      result.fills,
      JSON.stringify({
        key,
        orders: result.orders,
        rejections: result.rejections,
      }),
    ).toHaveLength(2);
    expect(result.fills[0]).toMatchObject({
      side: "buy",
      date: dates[fillIndex],
      price: 102,
    });
    expect(result.fills[1]).toMatchObject({
      side: "sell",
      date: dates[fillIndex + sellOffset],
      price,
    });
    expect(
      result.orders.find(
        (order) => order.side === "sell" && order.status === "filled",
      )?.trigger,
    ).toBe(reason);
    expect(
      result.rejections.some((rejection) => rejection.reason.includes("T+1")),
    ).toBe(key.endsWith("stop7"));
  }
  const ma = buildGrowthExitSeries("research-canslim-pit-ma50", bars);
  expect(ma[48]).toBeNull();
  expect(ma[49]).toBe(false);
  expect(ma[fillIndex + 2]).toBe(true);
  expect(
    buildGrowthExitSeries(
      "research-canslim-pit-ma50",
      bars.slice(0, fillIndex + 3),
    ),
  ).toEqual(ma.slice(0, fillIndex + 3));
});
