import { expect, it } from "vitest";
import type { Bar } from "../../src/lib/domain";
import {
  canslimMarketBinaryIds as canslimMarketIds,
  type CanslimMarketId,
} from "../../src/lib/research/methods/canslim/research-canslim-market-strategies";
import { researchCanslimMarketScore } from "../../src/server/strategies/canslim/research-canslim-market-score";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
import { researchSignals } from "../../src/server/strategies/shared/research-signals";
import { researchPortfolio } from "../../src/server/backtest/research-portfolio";
import { researchMethodSnapshot } from "../../src/server/research/research-method";
import { runStrategyResearch } from "../../src/server/backtest/research-run";
import type { ResearchDataset } from "../../src/server/backtest/research-dataset";
import { researchMarketEvidenceSchema } from "../../src/lib/research/factors/research-market-evidence";
import { canslimMarketTierIds } from "../../src/lib/research/methods/canslim/research-canslim-market-strategies";

const bars = (): Bar[] =>
  Array.from({ length: 300 }, (_, i) => ({
    date: new Date(Date.UTC(2023, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    high: 110,
    low: 90,
    close: 100,
    volume: 100,
    amount: 10000,
  }));
function fixture(id: CanslimMarketId) {
  const stocks = bars(),
    index = bars();
  if (id.endsWith("ma250")) index[260]!.close = 102;
  else if (id.endsWith("follow10"))
    Object.assign(index[260]!, { close: 101.5, volume: 151 });
  else {
    for (let i = 260; i < index.length; i++) {
      index[i]!.close = 100 - Math.min(5, i - 259);
      if (i < 265) index[i]!.volume = 100 + (i - 259) * 20;
    }
  }
  const market = {
    symbol: "sh000300",
    source: "fixture",
    hash: "fixture",
    bars: index,
  };
  const calendar = stocks.map((b) => b.date);
  return { stocks, index, market, calendar };
}
it.each(canslimMarketIds)(
  "%s uses only matching CSI300 prefix and confirms a real next-open event",
  async (id) => {
    const { stocks, index, market, calendar } = fixture(id);
    const day = id.endsWith("distribution20") ? 280 : 260;
    const full = researchCanslimMarketScore(id, stocks, calendar, market);
    expect(full.filter((p) => p.entry).map((p) => p.date)).toEqual([
      stocks[day]!.date,
    ]);
    expect(full[day - 1]!.diagnostic.points).toBe(0);
    expect(full[day]!.diagnostic.points).toBe(
      id.endsWith("ma250") ? 10 : id.endsWith("follow10") ? 8 : 5,
    );
    for (const end of [260, 261, 280, 281])
      expect(
        researchCanslimMarketScore(
          id,
          stocks.slice(0, end),
          calendar.slice(0, end),
          { ...market, bars: index.slice(0, end) },
        ),
      ).toEqual(full.slice(0, end));
    index[290]!.close = 1000;
    expect(
      researchCanslimMarketScore(id, stocks, calendar, market).slice(0, 290),
    ).toEqual(full.slice(0, 290));
    const spec = researchSpecSchema.parse({
      strategy: id,
      symbols: ["sh600000"],
      start: stocks[255]!.date,
      end: stocks[289]!.date,
      validationStart: stocks[287]!.date,
      holdingDays: 2,
    });
    const events = await researchSignals(
      "sh600000",
      stocks,
      spec,
      async () => {
        throw Error("native");
      },
      () => false,
      () => {},
      calendar,
      market,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.observedDate).toBe(stocks[day]!.date);
    expect(JSON.stringify(researchMethodSnapshot(spec))).toContain(
      "canslim-analyst/SKILL.md",
    );
    const result = researchPortfolio(
      spec,
      events,
      calendar,
      new Map([["sh600000", stocks]]),
      () => ({
        evidence: "fixture",
        tradable: true,
        limitUp: null,
        limitDown: null,
        minimumBuy: 100,
        buyStep: 100,
        maximumOrder: 100000,
        minimumSell: 100,
        sellStep: 100,
        maximumSell: 100000,
        sellOddLotAll: true,
      }),
    );
    expect(result.trades[0]).toMatchObject({
      entryDate: stocks[day + 1]!.date,
      exitDate: stocks[day + 3]!.date,
    });
  },
);
it.each(canslimMarketIds)(
  "%s preserves missing data and does not substitute another index or stock",
  (id) => {
    const { stocks, index, market, calendar } = fixture(id);
    expect(
      researchCanslimMarketScore(id, stocks, calendar).every(
        (p) => p.diagnostic.points === null,
      ),
    ).toBe(true);
    expect(
      researchCanslimMarketScore(id, stocks, calendar, {
        ...market,
        symbol: "sh000001",
      }).every((p) => p.diagnostic.points === null),
    ).toBe(true);
    const day = id.endsWith("distribution20") ? 280 : 260;
    index[day]!.volume = 0;
    expect(
      researchCanslimMarketScore(id, stocks, calendar, market)[day],
    ).toMatchObject({ entry: false, diagnostic: { points: null } });
    index[day]!.volume = 100;
    index.splice(day - 2, 1);
    expect(
      researchCanslimMarketScore(id, stocks, calendar, market)[day],
    ).toMatchObject({ entry: false, diagnostic: { points: null } });
  },
);
it("keeps MA equality, 1.5% price equality and strict 1.5 volume boundary distinct", () => {
  const { stocks, index, market, calendar } = fixture(
    "canslim-market-entry-follow10",
  );
  index[260]!.volume = 150;
  expect(
    researchCanslimMarketScore(
      "canslim-market-entry-follow10",
      stocks,
      calendar,
      market,
    )[260]!.diagnostic.points,
  ).toBe(0);
  index[260]!.volume = 150.001;
  expect(
    researchCanslimMarketScore(
      "canslim-market-entry-follow10",
      stocks,
      calendar,
      market,
    )[260]!.diagnostic.points,
  ).toBe(8);
  index[260]!.close = 101.499;
  expect(
    researchCanslimMarketScore(
      "canslim-market-entry-follow10",
      stocks,
      calendar,
      market,
    )[260]!.diagnostic.points,
  ).toBe(0);
  expect(
    researchCanslimMarketScore("canslim-market-entry-ma250", stocks, calendar, {
      ...market,
      bars: bars(),
    })[260]!.diagnostic.points,
  ).toBe(0);
});

it("runs the frozen CSI300 snapshot through the real dataset path and refuses incomplete action proof", async () => {
  const { stocks, market, calendar } = fixture("canslim-market-entry-ma250");
  const spec = researchSpecSchema.parse({
    strategy: "canslim-market-entry-ma250",
    symbols: ["sh600000"],
    start: stocks[255]!.date,
    end: stocks[289]!.date,
    validationStart: stocks[287]!.date,
    holdingDays: 2,
  });
  const dataset: ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "fixture",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: spec.symbols!,
      source: null,
      warning: "fixture",
    },
    benchmark: { symbol: "sh000001", bars: stocks },
    calendar,
    stocks: [
      {
        symbol: "sh600000",
        name: "fixture",
        bars: stocks,
        hash: "fixture",
        actions: [],
      },
    ],
    excluded: [],
    actionCoverage: "partial",
    actionSource: { path: "fixture", modified: 0 },
    capturedAt: 0,
    hash: "fixture",
    method: researchMethodSnapshot(spec),
    canslimMarket: market,
  };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "fixture",
    exportedAt: 0,
    adjustment: "none",
    corporateActionFree: [
      {
        symbol: "sh600000",
        start: stocks[230]!.date,
        end: spec.end,
        evidenceId: "fixture",
      },
    ],
    rows: stocks.map((b) => ({
      symbol: "sh600000",
      date: b.date,
      evidenceId: "fixture",
      tradable: true,
      limitUp: null,
      limitDown: null,
      minimumBuy: 100,
      buyStep: 100,
      maximumOrder: 100000,
      minimumSell: 100,
      sellStep: 100,
      maximumSell: 100000,
      sellOddLotAll: true,
    })),
  });
  const native = async (): Promise<never> => {
    throw Error("native");
  };
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  expect(result.events).toHaveLength(1);
  expect(result.partitions[0]!.simulation!.trades[0]).toMatchObject({
    entryDate: stocks[261]!.date,
    exitDate: stocks[263]!.date,
  });
  // This CANSLIM-M strategy is not a cup strategy, so admission runs on the
  // stock-wide prepareResearchAdjustedCoverage gate only; corporateActionFree
  // is legacy evidence metadata the engine no longer consumes, so shrinking
  // it must not change the trade.
  evidence.corporateActionFree[0]!.start = stocks[231]!.date;
  const missing = await runStrategyResearch(spec, dataset, evidence, native);
  expect(missing.events).toHaveLength(1);
  expect(missing.partitions.flatMap((p) => p.simulation!.trades)).toEqual(
    result.partitions.flatMap((p) => p.simulation!.trades),
  );
  const noIndex = { ...dataset };
  delete noIndex.canslimMarket;
  const unavailable = await runStrategyResearch(
    spec,
    noIndex,
    evidence,
    native,
  );
  expect(unavailable.events).toHaveLength(0);
  expect(unavailable.exclusions.some((e) => e.reason.includes("缺失"))).toBe(
    true,
  );
  // A bare category-1 record (no dividend/bonus/rights amounts) has zero
  // price effect, so adjustmentFactors computes a complete, unperturbed
  // factor series for it — admission is decided by whether the price
  // adjustment prefix is derivable, not by whether any action exists in the
  // window, so this must not exclude the stock either.
  dataset.stocks[0]!.actions.push({
    date: stocks[230]!.date,
    category: 1,
    name: "fixture",
  });
  expect(
    (await runStrategyResearch(spec, dataset, evidence, native)).events,
  ).toHaveLength(1);
});

it.each(canslimMarketTierIds)(
  "%s retains source tiers and a threshold-crossing executable adapter",
  async (id) => {
    const input = bars();
    if (id.endsWith("ma250") || id.endsWith("ma200"))
      for (let i = 260; i < input.length; i++) input[i]!.close = 110;
    else if (id.endsWith("follow10"))
      input.forEach((b, i) => {
        b.low = i === 260 ? 90 : i > 260 ? 95 : 99;
        b.close = i === 260 ? 99 : i < 264 ? 100 : 102;
        b.volume = i === 264 ? 151 : 100;
      });
    else
      for (const i of [260, 262, 264]) {
        input[i]!.close = 99;
        input[i]!.volume = 150;
      }
    const stock = bars(),
      calendar = stock.map((b) => b.date),
      market = {
        symbol: "sh000300",
        source: "fixture",
        hash: "fixture",
        bars: input,
      };
    const full = researchCanslimMarketScore(id, stock, calendar, market);
    const day =
      id.endsWith("ma250") || id.endsWith("ma200")
        ? 263
        : id.endsWith("follow10")
          ? 264
          : 280;
    expect(full[day]!.entry).toBe(true);
    if (id.endsWith("ma250") || id.endsWith("ma200")) {
      expect(full[259]!.diagnostic.points).toBe(5);
      expect(full.slice(260, 263).map((p) => p.diagnostic.points)).toEqual([
        7, 7, 7,
      ]);
      expect(full[263]!.diagnostic.points).toBe(10);
    } else if (id.endsWith("follow10")) {
      expect(full[264]!.diagnostic.points).toBe(8);
      input[267]!.low = 94;
      const changed = researchCanslimMarketScore(id, stock, calendar, market);
      expect(changed[267]!.diagnostic.points).toBe(0);
      expect(changed.slice(0, 267)).toEqual(full.slice(0, 267));
      input[267]!.low = 95;
      input[264]!.volume = 150;
      expect(
        researchCanslimMarketScore(id, stock, calendar, market)[264]!.diagnostic
          .points,
      ).toBe(4);
      input[264]!.volume = 151;
    } else {
      expect(full[264]!.diagnostic.points).toBe(0);
      expect(full[265]!.diagnostic.points).toBe(3);
      expect(full[280]!.diagnostic.points).toBe(5);
    }
    expect(
      researchCanslimMarketScore(
        id,
        stock.slice(0, day + 1),
        calendar.slice(0, day + 1),
        { ...market, bars: input.slice(0, day + 1) },
      ),
    ).toEqual(full.slice(0, day + 1));
    const spec = researchSpecSchema.parse({
      strategy: id,
      symbols: ["sh600000"],
      start: stock[255]!.date,
      end: stock[289]!.date,
      validationStart: stock[287]!.date,
      holdingDays: 2,
    });
    const events = await researchSignals(
      "sh600000",
      stock,
      spec,
      async () => {
        throw Error("native");
      },
      () => false,
      () => {},
      calendar,
      market,
    );
    expect(
      events.some((event) => event.observedDate === stock[day]!.date),
    ).toBe(true);
    expect(JSON.stringify(researchMethodSnapshot(spec))).toContain(
      "canslim-analyst/references/canslim-scoring.md",
    );
    const missing = structuredClone(market);
    missing.bars[day]!.high = 0;
    expect(
      researchCanslimMarketScore(id, stock, calendar, missing)[day],
    ).toMatchObject({ entry: false, diagnostic: { points: null } });
  },
);

it.each(["canslim-market-tier-ma250", "canslim-market-tier-ma200"] as const)(
  "%s keeps the three-point and falling-average seven-point branches",
  (id) => {
    const input = bars();
    input.forEach((b, i) => {
      b.high = 250;
      b.close = i < 180 ? 200 : 100;
    });
    input[299]!.close = 130;
    const stock = bars(),
      calendar = stock.map((b) => b.date),
      market = {
        symbol: "sh000300",
        source: "fixture",
        hash: "fixture",
        bars: input,
      };
    expect(
      researchCanslimMarketScore(id, stock, calendar, market)[299]!.diagnostic
        .points,
    ).toBe(3);
    input[299]!.close = 90;
    expect(
      researchCanslimMarketScore(id, stock, calendar, market)[299]!.diagnostic
        .points,
    ).toBe(0);
    for (let i = 296; i < 300; i++) input[i]!.close = 180;
    expect(
      researchCanslimMarketScore(id, stock, calendar, market)[299]!.diagnostic,
    ).toMatchObject({
      points: 7,
      details: { rising: false, aboveFourDays: true },
    });
  },
);
