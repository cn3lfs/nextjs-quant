import { describe, expect, it } from "vitest";
import { runPortfolio } from "quant-backtest";
import { resolveInstrumentRule } from "quant-execution";
import type { Bar } from "trading-strategy-core/bars";
import {
  executionCostsSchema,
  isCnEtfSymbol,
} from "trading-strategy-core/costs";
import {
  etfRotationCatalog,
  etfRotationUniverse,
  etfRotationUniverseFor,
  generateEtfRotationTargets,
  type EtfRotationConfig,
  type EtfRotationInput,
} from "trading-strategies";
import { buildExecutionRealityReport } from "~/server/research/execution-reality";
import {
  runEtfRotationBacktest,
  type EtfRotationMarketData,
} from "~/server/research/etf-rotation";

const equity = "sh510300";
const bond = "sh511010";
const gold = "sh518880";
const qdii = "sh513100";
const sectors = [
  "sh512480",
  "sh512880",
  "sh512800",
  "sh512010",
  "sz159928",
] as const;
const daily = [
  "2024-01-22",
  "2024-01-23",
  "2024-01-24",
  "2024-01-25",
  "2024-01-26",
  "2024-01-29",
] as const;
const monthly = ["2024-01-29", "2024-01-30", "2024-01-31", "2024-02-01"];

function pool(...symbols: string[]) {
  return etfRotationUniverse.filter(({ symbol }) => symbols.includes(symbol));
}

function input(
  calendar: readonly string[],
  prices: Readonly<Record<string, readonly number[]>>,
  from = 1,
  through = calendar.length - 1,
): EtfRotationInput {
  return Object.freeze({
    calendar: Object.freeze([...calendar]),
    start: calendar[from]!,
    end: calendar[through]!,
    priceBasis: "gbbq-first-raw-anchor-1",
    closes: Object.freeze(
      Object.fromEntries(
        Object.entries(prices).map(([symbol, closes]) => [
          symbol,
          Object.freeze(
            closes.map((close, i) =>
              Object.freeze({ date: calendar[i]!, close }),
            ),
          ),
        ]),
      ),
    ),
  });
}

describe("registered ETF rotation strategies", () => {
  it("identifies 21 unique ETF codes, 11 sectors and the pre-2015 comparison universe", () => {
    expect(etfRotationCatalog.map(({ id }) => id)).toEqual([
      "etf-dual-momentum",
      "etf-sector-rotation",
      "etf-risk-budget",
    ]);
    expect(new Set(etfRotationUniverse.map(({ symbol }) => symbol)).size).toBe(
      21,
    );
    expect(
      etfRotationUniverse.every(({ symbol }) => isCnEtfSymbol(symbol)),
    ).toBe(true);
    expect(
      etfRotationUniverse.filter(({ assetClass }) => assetClass === "sector"),
    ).toHaveLength(11);
    const legacy = etfRotationUniverseFor({
      strategyId: "etf-dual-momentum",
      pool: "legacy-long-history",
    });
    expect(legacy).toHaveLength(9);
    expect(legacy.some(({ symbol }) => symbol === "sh588000")).toBe(false);
  });

  it.each([
    { strategyId: "etf-dual-momentum", cadence: "daily", momentumWindow: 1 },
    {
      strategyId: "etf-sector-rotation",
      cadence: "daily",
      momentumWindows: [1],
    },
    { strategyId: "etf-risk-budget", volatilityWindow: 2 },
  ] satisfies EtfRotationConfig[])(
    "keeps snapshots and hashes identical when future closes are appended for $strategyId",
    async (config) => {
      const calendar = [...monthly, "2024-02-02", "2024-02-29", "2024-03-01"];
      const series = {
        [equity]: [10, 12, 11, 15, 13, 14, 99],
        [gold]: [10, 11, 10, 12, 9, 8, 88],
        [bond]: [10, 9, 9.5, 11, 11.1, 10, 77],
        [qdii]: [10, 11, 14, 15, 16, 17, 66],
        [sectors[0]]: [10, 11, 13, 14, 15, 16, 55],
      };
      const cut = 2;
      const prefix = input(
        calendar.slice(0, cut + 2),
        Object.fromEntries(
          Object.entries(series).map(([symbol, values]) => [
            symbol,
            values.slice(0, cut + 1),
          ]),
        ),
        1,
        cut,
      );
      const before = await generateEtfRotationTargets(config, prefix);
      const full = await generateEtfRotationTargets(
        config,
        input(calendar, series),
      );
      expect(before.snapshots.length).toBeGreaterThan(0);
      expect(full.snapshots.filter(({ date }) => date <= prefix.end)).toEqual(
        before.snapshots,
      );
      expect(
        full.scheduledTargets.filter(({ date }) => date <= prefix.end),
      ).toEqual(before.scheduledTargets);
      expect(before.snapshots[0]!.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.isFrozen(before.snapshots[0]!.targets)).toBe(true);
      const symbol =
        config.strategyId === "etf-sector-rotation" ? sectors[0] : equity;
      const observations = prefix.closes[symbol]!;
      const changed = await generateEtfRotationTargets(config, {
        ...prefix,
        closes: {
          ...prefix.closes,
          [symbol]: [
            ...observations.slice(0, -1),
            { ...observations.at(-1)!, close: 17 },
          ],
        },
      });
      expect(changed.snapshots.at(-1)!.sourceHash).not.toBe(
        before.snapshots.at(-1)!.sourceHash,
      );
    },
  );

  it("deduplicates the same index and sends empty dual momentum slots to treasury or cash", async () => {
    const duplicate = {
      ...pool(equity)[0]!,
      symbol: "sh510310",
      name: "沪深300ETF同指数样本",
    };
    const prices = input(daily.slice(0, 3), {
      [equity]: [10, 13, 12],
      [duplicate.symbol]: [10, 12, 11],
      [qdii]: [10, 11, 9],
      [bond]: [10, 10, 10],
    });
    const universe = [...pool(equity, bond, qdii), duplicate];
    const config = {
      strategyId: "etf-dual-momentum",
      cadence: "daily",
      topK: 3,
      momentumWindow: 1,
    } as const;
    const schedule = await generateEtfRotationTargets(config, {
      ...prices,
      universe,
    });
    const [first, second] = schedule.snapshots;
    expect(first!.targets).toEqual({
      [equity]: 1 / 3,
      [qdii]: 1 / 3,
      [bond]: 1 / 3,
    });
    expect(
      first!.evidence.rows.find(({ symbol }) => symbol === duplicate.symbol)
        ?.reason,
    ).toBe("same-index");
    expect(first!.evidence.qdii).toEqual({
      symbols: [qdii],
      signalPrice: "completed-domestic-cny-close",
      premiumDiscount: "unobserved",
      premiumDiscountRisk: "domestic-price-may-diverge-from-overseas-nav",
      iopv: "unobserved",
      usesOverseasClose: false,
    });
    expect(second!.targets).toEqual({ [bond]: 1 });
    const cash = await generateEtfRotationTargets(
      { ...config, defense: "cash" },
      { ...prices, universe },
    );
    expect(cash.snapshots[1]!.targets).toEqual({});
    expect(cash.snapshots[1]!.evidence.cashWeight).toBe(1);
    const missingDefense = await generateEtfRotationTargets(config, {
      ...prices,
      universe,
      closes: { ...prices.closes, [bond]: [] },
    });
    expect(missingDefense.snapshots[1]!.evidence.cashWeight).toBe(1);
  });

  it("retains sectors ranked third and fourth, exits at fifth and schedules every rebalance", async () => {
    const rankedReturns = [
      [5, 2, 2, 5, 1],
      [4, 4, 5, 4, 5],
      [3, 5, 4, 3, 4],
      [2, 1.5, 3, 2, 3],
      [1, 1, 1, 1, 2],
    ];
    const prices = Object.fromEntries(
      sectors.map((symbol, i) => [
        symbol,
        rankedReturns[i]!.reduce(
          (closes, gain) => [...closes, closes.at(-1)! * (1 + gain / 100)],
          [10],
        ),
      ]),
    );
    const config = {
      strategyId: "etf-sector-rotation",
      cadence: "daily",
      momentumWindows: [1],
    } as const;
    const market = { ...input(daily, prices), universe: pool(...sectors) };
    const buffered = await generateEtfRotationTargets(config, market);
    const plain = await generateEtfRotationTargets(
      { ...config, exitRankBuffer: 0 },
      market,
    );
    const first = sectors[0];
    expect(
      buffered.snapshots.map(({ evidence }) => {
        const row = evidence.rows.find(({ symbol }) => symbol === first)!;
        return [row.rank, row.reason];
      }),
    ).toEqual([
      [1, "selected"],
      [3, "retained"],
      [4, "retained"],
      [1, "retained"],
      [5, "rank-cutoff"],
    ]);
    expect(buffered.snapshots[1]!.evidence.holdRankLimit).toBe(4);
    expect(buffered.scheduledTargets.map(({ date }) => date)).toEqual(
      daily.slice(1),
    );
    expect(
      buffered.scheduledTargets
        .filter(({ evidence }) => evidence.changedTargets)
        .map(({ date }) => date),
    ).toEqual([daily[1], daily[5]]);
    expect(
      plain.scheduledTargets.filter(({ evidence }) => evidence.changedTargets),
    ).toHaveLength(4);
    expect(buffered.scheduledTargets.at(-1)!.targets[first]).toBeUndefined();
    expect(buffered.scheduledTargets.at(-1)!.targets[sectors[2]]).toBe(0.5);
  });

  it("normalizes hand-computed inverse sample vol, halves trends and caps treasury, with a 60/40 control", async () => {
    const market = input(monthly, {
      [equity]: [100, 110, 99, 200],
      [bond]: [100, 105, 99.75, 200],
      [gold]: [100, 120, 96, 200],
    });
    const config = {
      strategyId: "etf-risk-budget",
      volatilityWindow: 2,
    } as const;
    const inverse = await generateEtfRotationTargets(config, market);
    expect(inverse.snapshots).toHaveLength(1);
    const snapshot = inverse.snapshots[0]!;
    expect(snapshot.date).toBe("2024-01-31");
    expect(snapshot.targets[equity]).toBeCloseTo(2 / 7, 14);
    expect(snapshot.targets[bond]).toBeCloseTo(4 / 7, 14);
    expect(snapshot.targets[gold]).toBeCloseTo(1 / 7, 14);
    expect(
      snapshot.evidence.rows.find(({ symbol }) => symbol === equity)
        ?.volatility,
    ).toBeCloseTo(Math.sqrt(0.02), 14);
    const trend = (
      await generateEtfRotationTargets({ ...config, trendWindow: 3 }, market)
    ).snapshots[0]!;
    expect(trend.targets[equity]).toBeCloseTo(1 / 7, 14);
    expect(trend.targets[gold]).toBeCloseTo(1 / 14, 14);
    expect(trend.targets[bond]).toBeCloseTo(0.6, 14);
    expect(trend.evidence.cashWeight).toBeCloseTo(0.4 - 3 / 14, 14);
    const staticWeights = (
      await generateEtfRotationTargets(
        { ...config, mode: "static-60-40" },
        market,
      )
    ).snapshots[0]!;
    expect(staticWeights.targets).toEqual({ [equity]: 0.6, [bond]: 0.4 });
    const incomplete = (
      await generateEtfRotationTargets(
        { ...config, trendWindow: 3 },
        input(monthly, {
          [equity]: [100, 100, 100],
          [bond]: [100, 105, 99.75],
          [gold]: [100, 120],
        }),
      )
    ).snapshots[0]!;
    expect(incomplete.targets).toEqual({ [bond]: 0.6 });
    expect(
      incomplete.evidence.rows.find(({ symbol }) => symbol === equity)?.reason,
    ).toBe("zero-volatility");
    expect(
      incomplete.evidence.rows.find(({ symbol }) => symbol === gold)?.reason,
    ).toBe("missing-history");
  });

  it("rejects an overnight timestamp and does not infer month-end from an arbitrary cutoff", async () => {
    const config = {
      strategyId: "etf-dual-momentum",
      momentumWindow: 1,
    } as const;
    const market = input(monthly.slice(0, 2), { [qdii]: [10, 20] });
    expect(
      (await generateEtfRotationTargets(config, market)).snapshots,
    ).toEqual([]);
    await expect(
      generateEtfRotationTargets(config, {
        ...market,
        closes: { [qdii]: [{ date: "2024-01-30T22:00:00+08:00", close: 50 }] },
      }),
    ).rejects.toThrow("Invalid ETF close");
  });
});

function bar(date: string, close: number, open = close): Readonly<Bar> {
  return Object.freeze({
    date,
    open,
    close,
    high: Math.max(open, close) * 1.1,
    low: Math.min(open, close) * 0.9,
    amount: 10_000_000,
    volume: 1_000_000,
  });
}

const costs = executionCostsSchema.parse({
  commissionBps: 10,
  minimumCommission: 0,
  sellTaxBps: 20,
  transferBps: 30,
  slippageBps: 0,
});

function frozenData(calendar: readonly string[]): EtfRotationMarketData {
  const equityBars = calendar.map((date, i) =>
    bar(
      date,
      i === calendar.length - 4 ? 11 : i >= calendar.length - 3 ? 5 : 10,
      i >= calendar.length - 3 ? 5 : 10,
    ),
  );
  return Object.freeze({
    calendar: Object.freeze([...calendar]),
    calendarBasis: "synthetic Shanghai trading sessions",
    actionsSource: "synthetic GBBQ fixture",
    series: Object.freeze({
      [equity]: Object.freeze({
        bars: Object.freeze(equityBars),
        events: Object.freeze([
          Object.freeze({
            date: calendar.at(-3)!,
            category: 11,
            name: "split",
            shrinkRatio: 2,
          }),
        ]),
      }),
      [bond]: Object.freeze({
        bars: Object.freeze(calendar.map((date) => bar(date, 10))),
        events: Object.freeze([]),
      }),
      [gold]: Object.freeze({
        bars: Object.freeze(calendar.map((date) => bar(date, 10))),
        events: Object.freeze([]),
      }),
    }),
  });
}

const runnerConfig = {
  strategyId: "etf-dual-momentum",
  cadence: "daily",
  topK: 1,
  momentumWindow: 1,
} as const;

describe("ETF rotation portfolio and execution reality", () => {
  it("rejects an intraday end session even when its daily bar has arrived", async () => {
    const intraday = daily[5]!;
    const previousClose = daily[4]!;
    const request = {
      config: runnerConfig,
      initial: 100_000,
      start: daily[1]!,
      end: intraday,
      now: Date.parse(`${intraday}T10:30:00+08:00`),
      source: { kind: "frozen", data: frozenData(daily) },
      universe: pool(equity, bond, gold),
      costs,
    } as const;
    await expect(runEtfRotationBacktest(request)).rejects.toThrow(
      /later than the latest completed session.*2024-01-26/,
    );

    const previous = await runEtfRotationBacktest({
      ...request,
      end: previousClose,
    });
    expect(previous.portfolio.calendar.at(-1)).toBe(previousClose);
    for (const instrument of previous.portfolio.instruments) {
      expect(instrument.bars.at(-1)?.date).toBe(previousClose);
      expect(instrument.signalBars.at(-1)?.date).toBe(previousClose);
    }
    expect(previous.schedule.scheduledTargets.at(-1)?.date).toBe(previousClose);

    const completed = await runEtfRotationBacktest({
      ...request,
      now: Date.parse(`${intraday}T15:05:00+08:00`),
    });
    expect(completed.schedule.scheduledTargets.at(-1)?.date).toBe(intraday);
  });

  it("retries a limit-up sector buy at the next open without trading the fully allocated sector", async () => {
    const [blocked, held] = sectors;
    const [warmup, signal, limitDay, retryDay] = daily;
    const limit = 12.1;
    const result = await runEtfRotationBacktest({
      config: {
        strategyId: "etf-sector-rotation",
        cadence: "daily",
        momentumWindows: [1],
      },
      initial: 100_000,
      start: signal,
      end: retryDay,
      universe: pool(blocked, held),
      costs: { ...costs, commissionBps: 0 },
      source: {
        kind: "frozen",
        data: {
          calendar: daily,
          calendarBasis: "synthetic Shanghai trading sessions",
          actionsSource: "synthetic GBBQ fixture",
          series: {
            [blocked]: {
              bars: [
                bar(warmup, 10),
                bar(signal, 11),
                { ...bar(limitDay, limit), high: limit, low: limit },
                bar(retryDay, 12.625, 12.5),
              ],
              events: [],
              execution: {
                [limitDay]: {
                  tradable: true,
                  limitUp: limit,
                  limitDown: null,
                  evidence: "synthetic ETF price limit",
                },
              },
            },
            [held]: {
              bars: [
                bar(warmup, 8),
                bar(signal, 9),
                bar(limitDay, 10),
                bar(retryDay, 10.1, 10),
              ],
              events: [],
            },
          },
        },
      },
    });
    const rejected = result.backtest.orders.find(
      (order) => order.symbol === blocked && order.signalAt === signal,
    );
    expect(rejected).toMatchObject({ side: "buy", status: "rejected" });
    expect(result.backtest.rejections).toContainEqual({
      orderId: rejected!.id,
      date: limitDay,
      reason: "开盘涨停，无法证明买入成交",
    });
    expect(result.backtest.fills).toMatchObject([
      {
        symbol: held,
        signalAt: signal,
        date: limitDay,
        side: "buy",
        quantity: 5_000,
      },
      {
        symbol: blocked,
        signalAt: limitDay,
        date: retryDay,
        side: "buy",
        price: 12.5,
        quantity: 4_000,
      },
    ]);
    const [first, retry] = result.schedule.scheduledTargets;
    expect(first!.targets).toEqual({ [blocked]: 0.5, [held]: 0.5 });
    expect(retry).toMatchObject({
      date: limitDay,
      targets: first!.targets,
      evidence: { changedTargets: false },
    });
    expect(
      result.backtest.orders.filter(({ symbol }) => symbol === held),
    ).toHaveLength(1);
  });

  it("reads a pinned ETF panel, keeping the raw price, causal split and missing amount distinct", async () => {
    const fixture = frozenData(daily);
    const { bars, events } = fixture.series[equity]!;
    const result = await runEtfRotationBacktest({
      config: runnerConfig,
      initial: 100_000,
      start: daily[2]!,
      end: daily[5]!,
      universe: pool(equity),
      source: {
        kind: "market-panel",
        panel: {
          manifest: {
            dates: daily,
            symbols: [
              {
                symbol: equity,
                kind: "etf",
                priceScale: 1000,
                industryCode: 0,
                firstDate: daily[0]!,
                lastDate: daily[5]!,
                eventOffset: 0,
                eventBytes: 1,
                eventHash: "a".repeat(64),
              },
            ],
            sources: { "T0002/hq_cache/gbbq": "b".repeat(64) },
          },
          sliceSymbol(symbol, start, end) {
            expect([symbol, start, end]).toEqual([equity, daily[0], daily[5]]);
            const atoms = (key: "open" | "high" | "low" | "close") =>
              Int32Array.from(bars, (row) => Math.round(row[key] * 1000));
            return {
              dates: [...daily],
              openAtoms: atoms("open"),
              highAtoms: atoms("high"),
              lowAtoms: atoms("low"),
              closeAtoms: atoms("close"),
              volume: Float64Array.from(bars, (row) => row.volume),
              amount: Float64Array.from(bars, (row, i) =>
                i === 2 ? NaN : row.amount,
              ),
              adjFactor: Float32Array.from(bars, (_, i) => (i >= 3 ? 2 : 1)),
              turnover: new Float32Array(bars.length),
              marketCap: new Float32Array(bars.length),
              industryCode: new Uint16Array(bars.length),
              statusFlags: new Uint16Array(bars.length),
              prevCloseAtoms: new Int32Array(bars.length),
              valid: new Uint8Array(bars.length),
            };
          },
          events: () =>
            events.map((raw) => ({
              kind: "gbbq",
              availableFrom: raw.date,
              raw,
            })),
        },
      },
      costs,
    });
    const [instrument] = result.portfolio.instruments;
    expect(instrument!.bars[3]!.close).toBe(5);
    expect(instrument!.signalBars[3]!.close).toBe(10);
    expect(result.data.coverage[0]!.missingAmountDays).toBe(1);
    expect(result.backtest.fills[0]).toMatchObject({
      date: daily[3],
      price: 5,
    });
  });

  it("matches next-open raw prices, applies GBBQ only to signal basis and charges commission only on ETF fills", async () => {
    const fixture = frozenData(daily);
    const result = await runEtfRotationBacktest({
      config: runnerConfig,
      initial: 100_000,
      start: daily[2]!,
      end: daily[5]!,
      source: { kind: "frozen", data: fixture },
      universe: pool(equity, bond, gold),
      costs,
    });
    const equityInstrument = result.portfolio.instruments.find(
      ({ symbol }) => symbol === equity,
    )!;
    expect(
      equityInstrument.signalBars.find(({ date }) => date === daily[3])?.close,
    ).toBe(10);
    expect(
      equityInstrument.bars.find(({ date }) => date === daily[3])?.close,
    ).toBe(5);
    expect(result.backtest.fills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: equity,
          signalAt: daily[2],
          date: daily[3],
          side: "buy",
          price: 5,
        }),
        expect.objectContaining({
          symbol: equity,
          signalAt: daily[3],
          date: daily[4],
          side: "sell",
          price: 5,
        }),
        expect.objectContaining({
          symbol: bond,
          date: daily[4],
          side: "buy",
          price: 10,
        }),
      ]),
    );
    for (const fill of result.backtest.fills)
      expect(fill.fee).toBeCloseTo(fill.price * fill.quantity * 0.001, 10);
    const prefix = await runEtfRotationBacktest({
      config: runnerConfig,
      initial: 100_000,
      start: daily[2]!,
      end: daily[2]!,
      source: { kind: "frozen", data: fixture },
      universe: pool(equity, bond, gold),
      costs,
    });
    expect(prefix.schedule.snapshots).toEqual(
      result.schedule.snapshots.slice(0, 1),
    );
  });

  it("uses Wave 0 same-day bond and gold settlement in runPortfolio, with an equity ETF T+1 control", async () => {
    const result = await runEtfRotationBacktest({
      config: runnerConfig,
      initial: 300_000,
      start: daily[0]!,
      end: daily[2]!,
      source: { kind: "frozen", data: frozenData(daily) },
      universe: pool(equity, bond, gold),
      costs,
    });
    // Scheduled-only ETF strategies have no stop; an explicit research control
    // triggers a same-bar protective sell against the identical instruments.
    const reopened = runPortfolio({
      ...result.portfolio,
      scheduledTargets: undefined,
      strategies: result.portfolio.strategies.map((strategy) => ({
        ...strategy,
        entry: { kind: "constant", value: true },
        exit: { stop: { kind: "fixed", fraction: 0.05 } },
        sizing: { kind: "weight", weight: 0.2 },
      })),
    });
    for (const symbol of [bond, gold]) {
      expect(
        reopened.fills
          .filter((fill) => fill.date === daily[1] && fill.symbol === symbol)
          .map(({ side }) => side),
      ).toEqual(["buy", "sell"]);
    }
    expect(
      reopened.fills
        .filter((fill) => fill.date === daily[1] && fill.symbol === equity)
        .map(({ side }) => side),
    ).toEqual(["buy"]);
    expect(reopened.rejections.some((row) => row.reason.includes("T+1"))).toBe(
      true,
    );
    expect(resolveInstrumentRule(qdii, "2015-01-16").settlementCycle).toBe(
      "T+1",
    );
    expect(resolveInstrumentRule(qdii, "2015-01-19").settlementCycle).toBe(
      "T+0",
    );
  });

  it("supplies identical frozen targets to the nine execution scenarios and four crisis slices", async () => {
    const calendar = Array.from(
      { length: 29 },
      (_, i) => `2024-01-${String(i + 1).padStart(2, "0")}`,
    );
    const result = await runEtfRotationBacktest({
      config: runnerConfig,
      initial: 100_000,
      start: calendar.at(-4)!,
      end: calendar.at(-1)!,
      source: { kind: "frozen", data: frozenData(calendar) },
      universe: pool(equity, bond, gold),
      riskPolicy: { riskPerTrade: 1, maxTotalStopRisk: 1 },
      executionReality: {
        maxOpenGapPct: null,
        impact: { model: "sqrt", coefficientBps: 0 },
      },
      costs,
    });
    const report = result.executionReality!;
    expect(result.portfolio.riskPolicy?.maxEtfWeight).toBe(1);
    expect(result.portfolio.scheduledTargets).toBe(
      result.schedule.scheduledTargets,
    );
    expect(result.executionRealityInput?.portfolio.scheduledTargets).toBe(
      result.schedule.scheduledTargets,
    );
    expect(report.targetCount).toBe(result.schedule.scheduledTargets.length);
    expect(report.matrix).toHaveLength(9);
    expect(report.additionalScenarios).toHaveLength(0);
    expect(report.matrix[0]!.fills.length).toBeGreaterThan(0);
    expect(report.matrix[0]!.fills[0]!.quote.targetSourceHash).toBe(
      result.schedule.scheduledTargets[0]!.sourceHash,
    );
    for (const cell of report.matrix)
      expect(cell.crisisSlices.map(({ id }) => id)).toEqual([
        "2015",
        "2018",
        "2022-24",
        "2024-09",
      ]);
    expect(report.matrix[1]!.executionCoverage.missingQuotes).toBeGreaterThan(
      0,
    );
    expect(
      buildExecutionRealityReport(result.executionRealityInput!)
        .targetStreamHash,
    ).toBe(report.targetStreamHash);
  });
});
