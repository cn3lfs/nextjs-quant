import { describe, expect, it, vi } from "vitest";
import type {
  FinancialCell,
  FinancialReportSnapshot,
} from "tstdx/financial-model";
import type { Bar } from "trading-strategy-core/bars";
import { researchCanslimHighSeries } from "trading-strategies/research/canslim/research-canslim-high";
import { settingsSchema } from "~/lib/domain";
import { buildCanslimPitSeries } from "~/server/financial/canslim-pit-series";
import { readBars } from "~/server/market/bar-store/read-bars";
import { missingCausalPriceBasis } from "~/server/research/causal-price-basis";
import {
  prepareLabBacktest,
  replayLabBacktest,
} from "~/server/research/lab-backtest";
import { runDiagnostics } from "../../../scripts/lib/backtest-diagnose/diagnostics";
import {
  prepareDiagnoseRequest,
  type PrepareDiagnoseRequestInput,
} from "../../../scripts/lib/backtest-diagnose/prepare-request";
import { renderReport } from "../../../scripts/lib/backtest-diagnose/report";
import { buildStrategy } from "../../../scripts/lib/backtest-diagnose/strategy-specs";

vi.mock("~/server/market/bar-store/read-bars", () => ({ readBars: vi.fn() }));
vi.mock("~/server/research/causal-price-basis", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/server/research/causal-price-basis")
  >()),
  readResearchPriceActions: vi.fn(async () => ({
    events: new Map(),
    issues: [],
    recordCount: 0,
    sourceSha256: "synthetic GBBQ",
  })),
}));
vi.mock("~/server/data-sources/tdx/local-financial-files", () => ({
  readLocalFinancialHistory: () => {
    throw new Error("Expected injected financial history");
  },
}));
vi.mock("~/server/research/forward-identity", () => ({
  forwardExecutionBuildHash: () => "synthetic execution build",
}));

const symbol = "sh600519";
const strategyKey = "research-canslim-pit";
const beforeAnnouncement = "2021-03-30";
const announcementDate = "2021-03-31";
const availableFrom = "2021-04-01";
const reportDate = "2020-12-31";
const postPitBreakout = "2021-04-06";
const buyDate = "2021-04-07";
const exitSignalDate = "2021-04-14";
const sellDate = "2021-04-15";
const end = "2021-04-16";
const config = settingsSchema.parse({ tdxRoot: "D:/synthetic-only" });

function financialCell(
  id: number,
  value: number | null,
  status: FinancialCell["status"] = "value",
): FinancialCell {
  const code = `FN${id}`;
  return {
    code,
    label: code,
    section: "synthetic",
    slot: id - 1,
    raw: value,
    value,
    unit: "synthetic",
    rawUnit: "synthetic",
    scale: 1,
    timing: "unknown",
    status,
    reason: status === "value" ? null : "synthetic missing field",
  };
}

function financialReports(): FinancialReportSnapshot[] {
  // The year-end snapshots contain both annual fields and the standalone Q4
  // fields. Annual EPS compounds at 50%; Q4 EPS only clears C1 in 2020.
  const rows = [
    ["2017-12-31", "2018-03-28", "2018-03-29", 2, 1.5, 19, 90, 15],
    ["2018-12-31", "2019-03-28", "2019-03-29", 3, 2, 19, 120, 20],
    ["2019-12-31", "2020-03-31", "2020-04-01", 4.5, 2, 19, 150, 25],
    [reportDate, announcementDate, availableFrom, 6.75, 3.2, 26, 210, 40],
  ] as const;
  return rows.map(
    ([
      period,
      announced,
      available,
      annualEps,
      quarterEps,
      roe,
      revenue,
      profit,
    ]) => ({
      symbol,
      financialCompany: false,
      reportDate: period,
      announcementDate: announced,
      availableFrom: available,
      sourceFilename: `gpcw${period.replaceAll("-", "")}.dat`,
      sourceSha256: "synthetic source",
      contentSha256: "synthetic content",
      recordOffset: 0,
      mappingVersion: "synthetic",
      fields: [
        financialCell(1, annualEps),
        financialCell(6, roe),
        financialCell(7, annualEps * 1.25),
        financialCell(230, revenue),
        financialCell(232, profit),
        financialCell(311, quarterEps),
      ],
      warnings: [],
    }),
  );
}

function stockBar(date: string): Bar {
  const volume = 1_000_000;
  const close =
    date === announcementDate ? 104 : date === postPitBreakout ? 108 : 100;
  const open = date === buyDate ? 106 : date === sellDate ? 101.5 : 100;
  return {
    date,
    open,
    high: Math.max(open + 1, close + 1, 103.5),
    low: 99,
    close,
    volume,
    amount: close * volume,
  };
}

const pitBoundaryBars = [
  beforeAnnouncement,
  announcementDate,
  availableFrom,
].map(stockBar);

describe("strict PIT earnings visibility", () => {
  it("first sees the 2020 report on availableFrom and qualifies on the same bar", () => {
    const result = buildCanslimPitSeries(financialReports(), pitBoundaryBars);

    expect(result).toMatchObject({
      strictReportCount: 4,
      reportDateRange: ["2017-12-31", reportDate],
      qualifiedDays: 1,
      missingDays: 0,
      conflictDays: 0,
      firstVisibleReportDate: "2019-12-31",
      latestVisibleReportDate: reportDate,
    });
    const previous = {
      qualified: false,
      latestReportDate: "2019-12-31",
      latestAvailableFrom: "2020-04-01",
      c1: { status: "computed", value: 0, points: 0 },
    };
    expect(result.days).toMatchObject([
      { date: beforeAnnouncement, ...previous },
      { date: announcementDate, ...previous },
      {
        date: availableFrom,
        qualified: true,
        latestReportDate: reportDate,
        latestAvailableFrom: availableFrom,
        c1: { status: "computed", points: 8 },
        a1: { status: "computed", points: 8 },
        a2: { status: "computed", value: 26, points: 7 },
      },
    ]);
    expect(result.days[2]!.c1.value).toBeCloseTo(60);
    expect(result.days[2]!.a1.value).toBeCloseTo(50);
  });

  it("uses a later explicit availableFrom instead of inferring it from the announcement", () => {
    const reports = financialReports();
    const delayed = "2021-04-02";
    reports.at(-1)!.availableFrom = delayed;

    const { days } = buildCanslimPitSeries(reports, [
      stockBar(availableFrom),
      stockBar(delayed),
    ]);
    expect(days).toMatchObject([
      { date: availableFrom, latestReportDate: "2019-12-31", qualified: false },
      { date: delayed, latestReportDate: reportDate, qualified: true },
    ]);
  });

  it.each([
    { invalid: "absent availableFrom", dates: { availableFrom: undefined } },
    {
      invalid: "announcement on the report date",
      dates: { announcementDate: reportDate },
    },
    {
      invalid: "announcement before the report date",
      dates: { announcementDate: "2020-12-30" },
    },
    {
      invalid: "availability on announcement day",
      dates: { availableFrom: announcementDate },
    },
    {
      invalid: "availability before announcement day",
      dates: { availableFrom: beforeAnnouncement },
    },
  ])("ignores the 2020 report with $invalid", ({ dates }) => {
    const reports = financialReports();
    const invalid = { ...reports.pop()!, ...dates };
    const priorOnly = buildCanslimPitSeries(reports, pitBoundaryBars);
    expect(
      buildCanslimPitSeries([...reports, invalid], pitBoundaryBars),
    ).toEqual(priorOnly);
    expect(priorOnly).toMatchObject({
      strictReportCount: 3,
      qualifiedDays: 0,
      latestVisibleReportDate: "2019-12-31",
    });
  });
});

describe("strict PIT field safety", () => {
  it.each([-2, 0])("rejects a certified prior-year Q4 EPS of %s", (base) => {
    const reports = financialReports();
    const prior = reports[2]!;
    prior.fields = prior.fields.map((field) =>
      field.code === "FN311" ? financialCell(311, base) : field,
    );
    const result = buildCanslimPitSeries(reports, [stockBar(availableFrom)]);
    expect(result).toMatchObject({
      conflictDays: 1,
      missingDays: 0,
      qualifiedDays: 0,
      days: [
        {
          latestReportDate: reportDate,
          qualified: false,
          c1: { status: "conflict", value: null, points: 0 },
          a1: { status: "computed", points: 8 },
          a2: { status: "computed", points: 7 },
        },
      ],
    });
  });

  describe.each(["missing", "source-zero"] as const)("%s cell", (status) => {
    it.each([
      { id: 311, gate: "c1", field: "latest Q4 EPS" },
      { id: 6, gate: "a2", field: "latest annual ROE" },
    ])(
      "blocks qualification for $field without borrowing the prior report",
      ({ id, gate }) => {
        const reports = financialReports();
        // Make 2019 qualify so that falling back to its data would pass the gate.
        const olderBase = reports[1]!;
        olderBase.fields = olderBase.fields.map((field) =>
          field.code === "FN311" ? financialCell(311, 1) : field,
        );
        const latest = reports.at(-1)!;
        latest.fields = latest.fields.map((field) =>
          field.code === `FN${id}`
            ? financialCell(id, status === "missing" ? null : 0, status)
            : field,
        );
        const result = buildCanslimPitSeries(reports, pitBoundaryBars.slice(1));

        expect(result).toMatchObject({
          missingDays: 1,
          conflictDays: 0,
          qualifiedDays: 1,
          days: [
            {
              date: announcementDate,
              latestReportDate: "2019-12-31",
              qualified: true,
            },
            {
              date: availableFrom,
              latestReportDate: reportDate,
              qualified: false,
              [gate]: { status: "missing", value: null, points: 0 },
            },
          ],
        });
      },
    );
  });
});

const input = {
  strategy: buildStrategy(strategyKey, [symbol], "single"),
  start: beforeAnnouncement,
  end,
  initial: 100_000,
  riskPerTrade: 0.02,
  maxPositions: 1,
  costScenario: "fixed",
} satisfies Omit<PrepareDiagnoseRequestInput, "config" | "forceCausalPrice">;

function stubDailyBars() {
  const bars: Bar[] = [];
  const last = Date.parse(end);
  for (
    let day = new Date("2020-01-01");
    +day <= last;
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    const date = day.toISOString().slice(0, 10);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6 && date !== "2021-04-05")
      bars.push(stockBar(date));
  }
  vi.mocked(readBars).mockImplementation(async ({ instrument, period }) => {
    const ticker = instrument.symbol;
    if (ticker !== symbol && ticker !== "sh000001")
      throw new Error(`Unexpected fixture symbol ${ticker}`);
    return {
      id: `fixture-${ticker}`,
      hash: `synthetic-${ticker}`,
      symbol: ticker,
      market: "cn-equity",
      period,
      source: "tdx-local",
      requestedSource: "local",
      adjustment: "none",
      createdAt: 0,
      bars,
      rawBars: bars,
      barStore: {
        version: "bar-store-1",
        market: "cn-equity",
        sourceFingerprint: "fixture",
        sourceVersions: ["fixture"],
        adjustment: "none",
        adjustmentReference: "raw",
        coverage: {
          from: bars[0]!.date,
          to: end,
          count: bars.length,
          historyExhausted: true,
        },
        formingDates: [],
        overlay: null,
        excluded: [],
      },
    };
  });
}

async function preparePitReplay() {
  stubDailyBars();
  const readFinancialHistory = vi.fn<
    NonNullable<PrepareDiagnoseRequestInput["readFinancialHistory"]>
  >(async (_root, ticker) => ({
    symbol: ticker,
    reports: financialReports(),
    issues: [],
    financialCompany: false,
    version: "synthetic",
    warning: "",
  }));
  const prepared = await prepareDiagnoseRequest({
    ...input,
    config,
    forceCausalPrice: false,
    readFinancialHistory,
  });
  expect(readFinancialHistory).toHaveBeenCalledExactlyOnceWith(
    config.tdxRoot,
    symbol,
    {
      asOf: end,
      strict: true,
      limit: 200,
    },
  );
  return prepared;
}

it("rejects external CANSLIM in the default lab before reading market data", async () => {
  const read = vi.fn<typeof readBars>();
  await expect(
    prepareLabBacktest(
      { type: "lab-backtest", input: { ...input, source: "local" } },
      undefined,
      read,
      undefined,
      { config },
    ),
  ).rejects.toThrow("该策略需要原生/时点外部证据");
  expect(read).not.toHaveBeenCalled();
});

it("rejects replay with a valid causal proof but missing external.signals", async () => {
  const { frozen } = await preparePitReplay();
  delete frozen.request.instruments[0]!.external!.signals;
  expect(() => replayLabBacktest(frozen)).toThrow(
    `${symbol}：外部时点策略缺少逐日信号输入（external.signals）`,
  );
});

it("rejects replay with frozen external signals but no causal price proof", async () => {
  const { frozen } = await preparePitReplay();
  delete frozen.sources.find((source) => source.symbol === symbol)!.causalPrice;
  expect(() => replayLabBacktest(frozen)).toThrow(
    `${symbol}：${missingCausalPriceBasis}`,
  );
});

it("counts both price breakouts, trades only the PIT-visible one and reports the counts", async () => {
  const { frozen, canslimPit } = await preparePitReplay();
  const instrument = frozen.request.instruments[0]!;
  expect(instrument.bars.length).toBeGreaterThanOrEqual(320);
  const priceEntries = researchCanslimHighSeries(
    "canslim-high-98",
    instrument.signalBars,
  ).filter(({ entry }) => entry);
  expect(priceEntries.map(({ date }) => date)).toEqual([
    announcementDate,
    postPitBreakout,
  ]);
  const signals = instrument.external!.signals!;
  expect(signals.find(({ date }) => date === announcementDate)?.entry).toBe(
    false,
  );
  expect(signals.filter(({ entry }) => entry)).toEqual([
    {
      id: strategyKey,
      date: postPitBreakout,
      availableAt: postPitBreakout,
      entry: true,
      exit: false,
    },
  ]);
  expect(canslimPit).toMatchObject([
    {
      symbol,
      strictReportCount: 4,
      reportDateRange: ["2017-12-31", reportDate],
      qualifiedDays: 11,
      missingDays: 0,
      conflictDays: 0,
      priceSignalCount: 2,
      pitFilteredSignalCount: 1,
      sourceIssuesCount: 0,
    },
  ]);

  const replay = replayLabBacktest(frozen);
  expect(replay.result.fills).toMatchObject([
    { side: "buy", signalAt: postPitBreakout, date: buyDate },
    { side: "sell", signalAt: exitSignalDate, date: sellDate, holdingAfter: 0 },
  ]);
  const [buy, sell] = replay.result.fills;
  // Shared exit parity: research-growth entering on the same breakout must sell on the exact same session.
  const control = await prepareDiagnoseRequest({
    ...input,
    strategy: buildStrategy("research-growth", [symbol], "single"),
    start: availableFrom,
    config,
    forceCausalPrice: true,
  });
  const controlReplay = replayLabBacktest(control.frozen);
  expect(controlReplay.result.fills).toMatchObject([
    { side: "buy", signalAt: postPitBreakout, date: buyDate },
    { side: "sell", signalAt: exitSignalDate, date: sellDate, holdingAfter: 0 },
  ]);
  // The fixed scenario adds/subtracts 5 bp from each open.
  expect(buy!.price).toBeCloseTo(106.053, 8);
  expect(sell!.price).toBeCloseTo(101.44925, 8);
  expect(sell!.quantity).toBe(buy!.quantity);

  const diagnostics = runDiagnostics({
    request: frozen.request,
    frozen,
    replay,
  });
  expect(diagnostics.status, JSON.stringify(diagnostics.findings)).toBe("ok");
  expect(diagnostics.counts).toMatchObject({
    fills: 2,
    rejections: 0,
    closedTrades: 1,
  });

  const markdown = renderReport([
    {
      ...diagnostics,
      strategy: strategyKey,
      symbols: [symbol],
      mode: "per-symbol",
      runPath: "synthetic",
      start: input.start,
      end,
      canslimPit,
    },
  ]);
  const pitSection = markdown
    .split("\n## ")
    .find((section) => section.startsWith("成长 PIT 财务披露\n"));
  expect(pitSection).toContain(
    "| 价格触发数 | PIT 过滤后信号 | 财务包问题数 |",
  );
  expect(pitSection).toContain(
    "| sh600519 | 4 | 2017-12-31 ~ 2020-12-31 | 11 | 0 | 0 | 2 | 1 | 0 |",
  );
});
