import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPortfolio } from "quant-backtest";
import {
  spotPairPresets,
  prepareTheoryScreeners,
  type MacroObservation,
  type ValuePitCandidate,
} from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import {
  financialMappingVersion,
  projectFinancialFields,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
import { settingsSchema } from "~/lib/domain";
import { put, sqlite } from "~/server/db";
import { PaperRepository } from "~/server/db/paper-repository";
import { insertLimitObservation } from "~/server/db/limit-sentiment-observations";
import { upsertMacroSeries } from "~/server/db/macro-store";
import type { LimitPoolRow } from "~/server/data-sources/eastmoney/em-limit-pool";
import {
  LIMIT_SENTIMENT_VERSION,
  summarizeLimitPools,
} from "~/server/market/limit-sentiment";
import { sentimentRegimeSnapshot } from "~/server/market/limit-sentiment-regime";
import * as financialFiles from "~/server/data-sources/tdx/local-financial-files";
import { buildLocalFinancialArchive } from "~/server/financial/local-financial-archive";
import { saveSettings } from "~/server/infra/settings";
import * as paperActions from "~/server/market/bar-store/corporate-actions";
import { advancePaper } from "~/server/paper/advance";
import { loadPaperInput } from "~/server/paper/inputs";
import { promoteResearchToPaper } from "~/server/paper/promote-from-research";
import * as researchPriceBasis from "~/server/research/causal-price-basis";
import {
  evaluateValuePitSnapshot,
  previewMacroClockAllocation,
  previewPairSwitchAllocation,
} from "~/server/research/value-pit-service";

const rejectFetch = vi.fn<typeof fetch>(async () => {
  throw new Error("Wave 4/5 previews must use local evidence");
});
beforeEach(() => {
  rejectFetch.mockClear();
  vi.stubGlobal("fetch", rejectFetch);
  sqlite()
    .prepare("DELETE FROM records WHERE kind IN (?, ?, ?)")
    .run("macro-pit-series", "limit-sentiment", "limit-sentiment-observation");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(rejectFetch).not.toHaveBeenCalled();
});

it("projects the stored macro vintage visible at the replay cutoff", () => {
  const date = "2025-03-20";
  expect(previewMacroClockAllocation({ asOfDate: date })).toMatchObject({
    regime: "unknown",
    targets: {},
    scores: { pmiChange: null, inflationChange: null, termSpread: null },
  });
  const prior: Omit<MacroObservation, "seriesId" | "value"> = {
    reportPeriod: "2025-01-31",
    availableAt: "2025-02-17",
    publicationBasis: "official",
  };
  const current = {
    ...prior,
    reportPeriod: "2025-02-28",
    availableAt: "2025-03-17",
  };
  const meta = {
    source: "fixture",
    fetchedAt: Date.parse("2025-03-20T14:00:00+08:00"),
  };
  upsertMacroSeries(
    "pmi-mfg",
    [
      { ...prior, seriesId: "pmi-mfg", value: 49 },
      { ...current, seriesId: "pmi-mfg", value: 50 },
    ],
    meta,
  );
  expect(previewMacroClockAllocation({ asOfDate: date }).regime).toBe(
    "unknown",
  );
  upsertMacroSeries(
    "cpi-yoy",
    [
      { ...prior, seriesId: "cpi-yoy", value: 1 },
      { ...current, seriesId: "cpi-yoy", value: 0.5 },
    ],
    meta,
  );
  const preview = previewMacroClockAllocation({ asOfDate: date });
  expect(preview).toMatchObject({
    strategyId: "macro-clock-etf-rotation",
    date,
    availableAt: date,
    regime: "recovery",
    targets: { sh510300: 0.4, sz159915: 0.4, sh510880: 0.2 },
    scores: { pmiChange: 1, inflationChange: -0.5 },
    sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  upsertMacroSeries(
    "cpi-yoy",
    [{ ...current, seriesId: "cpi-yoy", value: 2 }],
    {
      ...meta,
      fetchedAt: Date.parse("2025-03-20T15:00:00+08:00"),
    },
  );
  expect(previewMacroClockAllocation({ asOfDate: date })).toEqual(preview);
  expect(previewMacroClockAllocation({ asOfDate: "2025-03-21" }).regime).toBe(
    "overheat",
  );
});

const pair = spotPairPresets[0];
const pairDates = Array.from(
  { length: 100 },
  (_, index) => new Date(Date.UTC(2025, 0, 1 + index)),
)
  .filter((date) => date.getUTCDay() % 6 !== 0)
  .map((date) => date.toISOString().slice(0, 10));
const signalDate = pairDates[65]!;
const executionDate = pairDates[66]!;
const candle = (date: string, close: number): Bar => ({
  date,
  open: close,
  high: close * 1.005,
  low: close * 0.995,
  close,
  volume: 1_000_000,
  amount: close * 1_000_000,
});
const etfBars = {
  [pair.legA]: pairDates.map((date, i) =>
    candle(
      date,
      3 * Math.exp(i * 0.005 + 0.002 * Math.sin(i) + (i === 65 ? 0.1 : 0)),
    ),
  ),
  [pair.legB]: pairDates.map((date, i) =>
    candle(date, 3 * Math.exp(i * 0.005)),
  ),
};
const readPairBars = (symbol: string) =>
  etfBars[symbol as keyof typeof etfBars];

it("freezes causal spot pair weights and executes them at the next open", async () => {
  const input = {
    pairId: pair.id,
    asOfDate: signalDate,
    readCalendar: () => pairDates,
  };
  const preview = await previewPairSwitchAllocation({
    ...input,
    readBars: readPairBars,
  });
  expect(preview).toMatchObject({
    strategyId: "stat-pair-switch-zscore",
    pairId: pair.id,
    date: signalDate,
    availableAt: signalDate,
    status: "ok",
    activeLeg: "B",
    targets: { [pair.legA]: 0, [pair.legB]: 1 },
    sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(preview.zScore).toBeGreaterThan(1.5);
  expect(
    Object.values(preview.targets).reduce((sum, weight) => sum + weight, 0),
  ).toBeLessThanOrEqual(1);
  expect(
    await previewPairSwitchAllocation({
      ...input,
      readBars: (symbol) =>
        readPairBars(symbol).filter(({ date }) => date <= signalDate),
    }),
  ).toEqual(preview);

  const { strategyId } = preview;
  const symbols = [pair.legA, pair.legB];
  const result = runPortfolio({
    market: "cn-equity",
    initial: 100_000,
    start: signalDate,
    end: executionDate,
    calendar: pairDates.slice(0, 67),
    strategies: [
      {
        id: strategyId,
        version: 1,
        market: "cn-equity",
        period: "day",
        universe: { kind: "symbols", symbols },
        entry: { kind: "constant", value: false },
        exit: { rule: { kind: "constant", value: false } },
        sizing: { kind: "weight", weight: 1 },
        sleeve: strategyId,
      },
    ],
    sleeves: [{ id: strategyId, share: 1, riskPerTrade: 1, maxPositions: 2 }],
    costs: {
      version: "cost-experiment-1",
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
    instruments: symbols.map((symbol) => ({
      symbol,
      market: "cn-equity",
      bars: readPairBars(symbol).slice(0, 67),
      signalBars: readPairBars(symbol).slice(0, 67),
      execution: {
        minimum: 100,
        step: 100,
        tradable: true,
        limitUp: null,
        limitDown: null,
        evidence: "fixture",
      },
    })),
    scheduledTargets: [preview],
  });
  expect(result.fills, JSON.stringify(result.orders)).toMatchObject([
    { date: executionDate, symbol: pair.legB, side: "buy" },
  ]);
  expect(result.orders[0]?.targetSourceHash).toBe(preview.sourceHash);
});

it.each(["terminal", "interior", "shared interior", "before close"] as const)(
  "fails closed on a %s gap in completed pair bars",
  async (gap) => {
    if (gap === "before close")
      vi.spyOn(Date, "now").mockReturnValue(
        Date.parse(`${signalDate}T14:59:59+08:00`),
      );
    const result = await previewPairSwitchAllocation({
      pairId: pair.id,
      asOfDate: signalDate,
      readCalendar: () => pairDates,
      readBars: (symbol) =>
        gap === "before close" ||
        (gap !== "shared interior" && symbol === pair.legA)
          ? readPairBars(symbol)
          : readPairBars(symbol).filter(
              ({ date }) =>
                date !== (gap === "terminal" ? signalDate : pairDates[63]),
            ),
    });
    expect(result).toMatchObject({
      date: signalDate,
      status: "unknown",
      activeLeg: "neutral",
      zScore: null,
      beta: null,
      targets: {},
      scores: {},
    });
    expect(result.targets).toEqual({});
  },
);

const valueDate = "2025-03-20";
const future = "2025-03-21";
const eligible = "sh600000";
const laterDisclosure = "sh600001";
const laterPrice = "sh600002";
const missing = "sh600003";
function candidate(
  symbol: string,
  patch: Partial<ValuePitCandidate> = {},
): ValuePitCandidate {
  return {
    symbol,
    asOf: valueDate,
    availableAt: valueDate,
    isFinancial: false,
    price: 10,
    marketCap: 80,
    enterpriseValue: 100,
    ebit: 10,
    investedCapital: 50,
    peTtm: 20,
    netProfitGrowthYoY: 0.2,
    operatingCashFlow: 9,
    netIncome: 10,
    roa: 0.1,
    priorRoa: 0.08,
    cfoToAssets: 0.12,
    leverage: 0.3,
    priorLeverage: 0.4,
    currentRatio: 2,
    priorCurrentRatio: 1,
    grossMargin: 0.4,
    priorGrossMargin: 0.3,
    assetTurnover: 1.2,
    priorAssetTurnover: 1,
    ttmCashDividendPerShare: 0.5,
    volatility60d: 0.2,
    ...patch,
  };
}

function writeLocalDaily(root: string, symbol: string, bars: readonly Bar[]) {
  const dir = join(root, "vipdoc", symbol.slice(0, 2), "lday");
  mkdirSync(dir, { recursive: true });
  const data = Buffer.alloc(bars.length * 32);
  for (const [i, bar] of bars.entries()) {
    const offset = i * 32;
    data.writeUInt32LE(Number(bar.date.replaceAll("-", "")), offset);
    for (const [j, price] of [bar.open, bar.high, bar.low, bar.close].entries())
      data.writeUInt32LE(Math.round(price * 100), offset + 4 * (j + 1));
    data.writeFloatLE(bar.amount!, offset + 20);
    data.writeUInt32LE(bar.volume, offset + 24);
  }
  writeFileSync(join(dir, `${symbol}.day`), data);
}

it("uses local daily bars, in-window GBBQ dividends and only archived financial bytes in a historical snapshot", async () => {
  const root = join(process.env.QUANT_DATA_DIR!, "value-pit-tdx");
  writeLocalDaily(
    root,
    eligible,
    [
      "2024-12-23",
      "2024-12-24",
      "2024-12-25",
      "2024-12-26",
      "2024-12-27",
      "2024-12-30",
      "2024-12-31",
      ...pairDates.filter((date) => date <= valueDate),
    ].map((date, i) => candle(date, 10 + (i % 2) * 0.1)),
  );
  const report = (cashFlow: number): FinancialReportSnapshot => {
    const fields = Array<number>(107).fill(0);
    fields[106] = cashFlow;
    return {
      symbol: eligible,
      financialCompany: false,
      reportDate: "2024-12-31",
      announcementDate: "2025-03-17",
      availableFrom: "2025-03-18",
      sourceFilename: "fixture.dat",
      sourceSha256: "a".repeat(64),
      contentSha256: "b".repeat(64),
      recordOffset: 0,
      mappingVersion: financialMappingVersion,
      fields: projectFinancialFields(fields, false, [106]),
      warnings: [],
    };
  };
  const history = (cashFlow: number) => ({
    symbol: eligible,
    reports: [report(cashFlow)],
    issues: [],
    financialCompany: false,
    version: financialMappingVersion,
    warning: "",
  });
  const readFinancials = vi.spyOn(financialFiles, "readLocalFinancialHistory");
  readFinancials.mockResolvedValue(history(100));
  const makeDividend = (date: string) => ({
    date,
    category: 1,
    name: "除息",
    dividend: 0.1,
  });
  const readActions = vi.spyOn(researchPriceBasis, "readResearchPriceActions");
  const setDividends = (dates: string[]) =>
    readActions.mockResolvedValue({
      events: new Map([[eligible, dates.map(makeDividend)]]),
      issues: [],
      recordCount: dates.length,
      sourceSha256: "c".repeat(64),
    });
  setDividends(["2025-03-14"]);
  const clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(Date.parse("2025-03-21T16:00:00+08:00"));
  const input = {
    strategyId: "value-dividend-lowvol-pit" as const,
    symbols: [eligible],
    asOfDate: valueDate,
    tdxRoot: root,
  };
  expect(await evaluateValuePitSnapshot(input)).toMatchObject({
    targets: {},
    excluded: [eligible],
  });
  clock.mockReturnValue(Date.parse(`${valueDate}T16:00:00+08:00`));
  expect(await evaluateValuePitSnapshot(input)).toMatchObject({
    targets: {},
    excluded: [eligible],
    disclosure: expect.stringContaining("收盘后刷新"),
  });

  clock.mockReturnValue(Date.parse("2025-03-19T16:00:00+08:00"));
  const archive = await buildLocalFinancialArchive(root, eligible);
  put("local-financial-archive", archive.id, archive);
  clock.mockReturnValue(Date.parse("2025-03-21T16:00:00+08:00"));
  readFinancials.mockResolvedValue(history(-100));
  const preview = await evaluateValuePitSnapshot(input);
  expect(preview).toMatchObject({
    targets: { [eligible]: 1 },
    excluded: [],
    vintageBasis: "local-financial-archive",
    priceBasis: "raw-close-and-gbbq-first-raw-anchor-1",
    gbbqVintageBasis: "current-local-file-exdate-filtered",
    disclosure: expect.stringContaining("无法排除追溯修订"),
  });
  expect(readFinancials).toHaveBeenLastCalledWith(root, eligible, {
    asOf: valueDate,
    strict: true,
  });
  setDividends(["2024-03-20", "2025-03-14", "2025-03-21"]);
  expect(await evaluateValuePitSnapshot(input)).toEqual(preview);
  setDividends(["2024-03-20", "2025-03-21"]);
  expect(await evaluateValuePitSnapshot(input)).toMatchObject({
    targets: {},
    excluded: [eligible],
  });
});

it("keeps the theory screener's frozen stop and price scale after a future split", async () => {
  const symbol = eligible;
  const root = join(process.env.QUANT_DATA_DIR!, "paper-split-tdx");
  const calendar = pairDates.slice(0, 68);
  const benchmark = calendar.map((date) => candle(date, 10));
  const bars = calendar.map((date) => {
    const bar = candle(
      date,
      date < signalDate ? 10 : date === signalDate ? 10.5 : 5.25,
    );
    return { ...bar, high: bar.close + 0.1, low: bar.close - 0.1 };
  });
  writeLocalDaily(root, "sh000906", benchmark);
  writeLocalDaily(root, symbol, bars);
  saveSettings(settingsSchema.parse({ tdxRoot: root, calendar }));
  vi.spyOn(paperActions, "corporateActions").mockResolvedValue({
    events: new Map([
      [
        symbol,
        [{ date: executionDate, category: 1, name: "送转", bonusRatio: 1 }],
      ],
    ]),
    path: "fixture",
    fingerprint: "fixture",
    modified: 0,
  });
  const repo = new PaperRepository();
  const account = promoteResearchToPaper(
    {
      name: "固定复权基准",
      strategyKey: "screener:f04-turtle-donchian",
      symbols: [symbol],
      initial: 100_000,
    },
    repo,
    Date.parse(`${signalDate}T08:00:00+08:00`),
  );
  const firstTick = Date.parse(`${executionDate}T12:00:00+08:00`);
  const first = (await loadPaperInput(account, firstTick))!;
  expect(first.decisions?.[0]).toMatchObject({ date: signalDate, entry: true });
  const levelsAtSignal = (bars: readonly Bar[]) => {
    const index = bars.findIndex(({ date }) => date === signalDate);
    const match = prepareTheoryScreeners(
      { symbol, bars },
      { families: ["trend-breakout"], methodIds: ["f04-turtle-donchian"] },
    ).at(index)[0]!;
    return { stop: match.stopPrice, target: match.targetPrice };
  };
  const levels = levelsAtSignal(first.request.instruments[0]!.signalBars);
  expect(levels.stop).toBeGreaterThan(0);
  expect(levels.target).toBeGreaterThan(10.5);
  advancePaper(repo, account.id, first, firstTick);
  const secondTick = Date.parse(`${calendar[67]}T12:00:00+08:00`);
  const full = (await loadPaperInput(account, secondTick))!;
  expect(levelsAtSignal(full.request.instruments[0]!.signalBars)).toEqual(
    levels,
  );
  expect(
    full.request.instruments[0]?.signalBars.filter(
      ({ date }) => date <= signalDate,
    ),
  ).toEqual(first.request.instruments[0]?.signalBars);
  const followUp = (await loadPaperInput(
    repo.account(account.id)!,
    secondTick,
  ))!;
  expect(followUp.request.instruments[0]?.bars[0]?.close).toBe(5.25);
  expect(followUp.request.instruments[0]?.signalBars[0]?.close).toBe(10.5);

  const checkpoint = repo.state(account.id)!;
  const instrument = checkpoint.request.instruments[0]!;
  instrument.signalBars = instrument.signalBars.map((bar) => ({
    ...bar,
    open: bar.open / 2,
    high: bar.high / 2,
    low: bar.low / 2,
    close: bar.close / 2,
  }));
  repo.saveState(account.id, checkpoint);
  const onLegacyScale = (await loadPaperInput(
    repo.account(account.id)!,
    secondTick,
  ))!;
  expect(onLegacyScale.request.instruments[0]?.signalBars[0]?.close).toBe(5.25);
});
it.each([
  ["value-magic-formula-pit", 2],
  ["value-fscore-local8-pit", 8],
  ["value-dividend-lowvol-pit", 2],
  ["value-garp-pit", 1],
] as const)(
  "freezes %s targets with only visible candidates",
  async (strategyId, score) => {
    const input = {
      strategyId,
      asOfDate: valueDate,
      symbols: [missing, laterPrice, laterDisclosure, eligible],
      topK: 1,
    };
    const baseline = await evaluateValuePitSnapshot({
      ...input,
      loadCandidate: (symbol) =>
        symbol === eligible ? candidate(symbol) : null,
    });
    const loadCandidate = vi.fn(
      (symbol: string) =>
        ({
          [eligible]: [
            candidate(symbol, {
              availableAt: future,
              ebit: 0,
              peTtm: 0,
              roa: null,
              price: 0,
            }),
            candidate(symbol),
          ],
          [laterDisclosure]: candidate(symbol, { availableAt: future }),
          [laterPrice]: candidate(symbol, { asOf: future }),
        })[symbol] ?? null,
    );
    const result = await evaluateValuePitSnapshot({ ...input, loadCandidate });
    expect(result).toEqual(baseline);
    expect(result).toMatchObject({
      strategyId,
      date: valueDate,
      availableAt: valueDate,
      targets: { [eligible]: 1 },
      scores: { [eligible]: score },
      excluded: [laterDisclosure, laterPrice, missing],
    });
    expect(Object.isFrozen(result.targets)).toBe(true);
    expect(loadCandidate).toHaveBeenCalledWith(eligible, valueDate);
  },
);

const observationDate = "2025-03-20";
function storeObservation(date: string) {
  insertLimitObservation({
    date,
    minute: "15:00",
    at: Date.parse(`${date}T15:00:00+08:00`),
    limitUp: 99,
    broken: 0,
    limitDown: 0,
  });
}

it("does not construct a daily regime from empty storage or intraday observations", () => {
  const options = { asOfDate: observationDate };
  const result = sentimentRegimeSnapshot(options);
  expect(result).toMatchObject({
    asOf: observationDate,
    forwardOnly: true,
    phase: "unknown",
    historyDays: 0,
    stats: null,
    exposureScale: null,
    allowNewEntries: false,
    candidates: [],
  });
  storeObservation(observationDate);
  expect(sentimentRegimeSnapshot(options)).toEqual(result);
});

function poolRow(index: number): LimitPoolRow {
  const symbol = `sh${600000 + index}`;
  return {
    symbol,
    name: symbol,
    price: 10,
    changePct: 10,
    amount: 2e8,
    floatCap: null,
    turnover: 5,
    industry: "",
    streak: index === 0 ? 4 : 1,
    firstSeal: null,
    lastSeal: null,
    sealFund: 1e7,
    breaks: 1,
    limitPrice: 10,
    stat: null,
  };
}

it("projects a finalized ferment regime and qualifying candidates only", () => {
  const zt = Array.from({ length: 50 }, (_, index) => poolRow(index));
  const pools = { zt, zb: [], dt: [], yzt: zt.slice(0, 4) };
  for (const [date, final] of [
    ["2025-03-19", true],
    [observationDate, true],
    ["2025-03-21", false],
    ["2025-03-24", true],
  ] as const) {
    put("limit-sentiment", `limit-sentiment:${date}`, {
      version: LIMIT_SENTIMENT_VERSION,
      available: true,
      final,
      fetchedAt: Date.parse(`${date}T16:00:00+08:00`),
      pools,
      ...summarizeLimitPools(date, pools),
    });
  }
  storeObservation(observationDate);
  expect(sentimentRegimeSnapshot({ asOfDate: observationDate })).toMatchObject({
    forwardOnly: true,
    phase: "ferment",
    exposureScale: 1,
    allowNewEntries: true,
    historyDays: 2,
    stats: {
      date: observationDate,
      maxHeight: 4,
      limitUp: 50,
      promotionRate: 100,
    },
    candidates: [{ symbol: eligible, streak: 4 }],
    disclosure: expect.stringContaining("1 条本机盘中观测"),
  });
  for (const asOfDate of ["2025-03-21", "2025-03-22"]) {
    expect(sentimentRegimeSnapshot({ asOfDate })).toMatchObject({
      asOf: asOfDate,
      forwardOnly: true,
      phase: "unknown",
      exposureScale: null,
      allowNewEntries: false,
      stats: null,
      candidates: [],
      reason: expect.stringContaining(asOfDate),
    });
  }
  put("limit-sentiment", `limit-sentiment:${observationDate}`, {
    version: LIMIT_SENTIMENT_VERSION,
    date: observationDate,
    available: true,
    final: true,
    fetchedAt: Date.parse(`${observationDate}T16:00:00+08:00`),
    pools,
    stats: { limitUp: "50" },
  });
  expect(sentimentRegimeSnapshot({ asOfDate: observationDate })).toMatchObject({
    phase: "unknown",
    allowNewEntries: false,
    candidates: [],
    reason: expect.stringContaining(observationDate),
    historyDays: 1,
  });
});
