import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import { researchRuleSeries } from "../src/server/strategies/shared/research-rule-series";
import { researchCanslimMarketCombination } from "../src/server/strategies/canslim/research-canslim-market-combination";
import { researchCanslimPriorityPoint } from "../src/server/strategies/canslim/research-canslim-priority";
import { canslimMarketCombinationIds } from "../src/lib/research-canslim-market-strategies";
import { researchSignals } from "../src/server/strategies/shared/research-signals";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { runStrategyResearch } from "../src/server/backtest/research-run";
import { researchMethodSnapshot } from "../src/server/research/research-method";

function fixture() {
  const bars: Bar[] = Array.from({ length: 290 }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: i >= 280 ? 102 : 97,
    high: i >= 279 ? 103 : 100,
    low: i >= 280 ? 101 : 95,
    close: i >= 279 ? 102 : 97,
    volume: i < 259 ? 100 : i < 269 ? 45 : i < 279 ? 35 : 70,
    amount: 1000000,
  }));
  const index = bars.map((b, i) => ({
    ...b,
    open: 100,
    high: 115,
    low: i === 275 ? 90 : 95,
    close: i === 275 ? 99 : i < 276 ? 100 : i < 279 ? 105 : 110,
    volume: i === 279 ? 151 : 100,
  }));
  return {
    bars,
    calendar: bars.map((b) => b.date),
    market: {
      symbol: "sh000300",
      source: "fixture",
      hash: "fixture",
      bars: index,
    },
  };
}
it.each(canslimMarketCombinationIds)(
  "%s confirms real geometry with market evidence and preserves prefixes",
  async (id) => {
    const { bars, calendar, market } = fixture();
    const full = researchRuleSeries(id, bars, calendar, market);
    expect(full[279]).toMatchObject({
      entry: true,
      candidate: { family: "flat", high: 100 },
      market: { allowed: true, total: 23 },
    });
    expect(
      researchRuleSeries(id, bars.slice(0, 280), calendar.slice(0, 280), {
        ...market,
        bars: market.bars.slice(0, 280),
      }),
    ).toEqual(full.slice(0, 280));
    market.bars[285]!.close = 1;
    expect(
      researchRuleSeries(id, bars, calendar, market).slice(0, 285),
    ).toEqual(full.slice(0, 285));
    const spec = researchSpecSchema.parse({
      strategy: id,
      symbols: ["sh600000"],
      start: bars[270]!.date,
      end: bars[289]!.date,
      validationStart: bars[287]!.date,
      holdingDays: 2,
    });
    const events = await researchSignals(
      "sh600000",
      bars,
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
    expect(events[0]).toMatchObject({
      observedDate: bars[279]!.date,
      entryPriceRange: { min: 100, max: 105 },
      historyStart: bars[0]!.date,
    });
  },
);
it("retains low-score analysis and rejects missing market, missing calendar and invalid volume", () => {
  const { bars, calendar, market } = fixture();
  market.bars.forEach((b, i) => {
    b.close = i < 260 ? 100 : 80;
    b.open = b.close;
    b.low = 70;
    b.volume = 100;
  });
  const low = researchRuleSeries(
    "canslim-priority-market-warning",
    bars,
    calendar,
    market,
  );
  expect(low[279]).toMatchObject({
    entry: false,
    candidate: { family: "flat" },
    market: { total: 5, warning: expect.stringContaining("继续分析") },
  });
  expect(
    researchRuleSeries("canslim-priority-market-m6", bars, calendar)[279],
  ).toMatchObject({ entry: false, market: { total: null } });
  const valid = fixture();
  for (const change of ["missing", "zero", "ohlc"] as const) {
    const changed = structuredClone(valid.market);
    if (change === "missing") changed.bars.splice(270, 1);
    if (change === "zero") changed.bars[279]!.volume = 0;
    if (change === "ohlc") changed.bars[279]!.low = 999;
    expect(
      researchRuleSeries(
        "canslim-priority-market-m6",
        bars,
        calendar,
        changed,
      )[279],
    ).toMatchObject({ entry: false, market: { total: null } });
  }
  expect(
    researchRuleSeries(
      "canslim-priority-market-m6",
      bars.filter((_, i) => i !== 270),
      calendar,
      valid.market,
    ).find((p) => p.date === bars[279]!.date),
  ).toMatchObject({ entry: false, reason: "形态研究日历缺日" });
});
it("does not turn later market recovery into a delayed entry and preserves non-entry diagnostics", () => {
  const { bars, calendar, market } = fixture();
  const points = bars.map((_, i) =>
    researchCanslimPriorityPoint(bars.slice(0, i + 1)),
  );
  const result = researchCanslimMarketCombination(
    "canslim-priority-market-m6",
    points.map((p) => ({ ...p, entry: false })),
    bars,
    calendar,
    market,
  );
  expect(result.some((p) => p.entry)).toBe(false);
  expect(result[279]!.candidate).toEqual(points[279]!.candidate);
});

it("persists low-M warning in the research result when no buy event is emitted", async () => {
  const { bars, calendar, market } = fixture();
  market.bars.forEach((b, i) => {
    b.close = i < 260 ? 100 : 80;
    b.open = b.close;
    b.low = 70;
    b.volume = 100;
  });
  const spec = researchSpecSchema.parse({
    strategy: "canslim-priority-market-warning",
    symbols: ["sh600000"],
    start: bars[270]!.date,
    end: bars[289]!.date,
    validationStart: bars[287]!.date,
  });
  const result = await runStrategyResearch(
    spec,
    {
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
      benchmark: { symbol: "sh000001", bars },
      calendar,
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
      method: researchMethodSnapshot(spec),
      canslimMarket: market,
    },
    null,
    async () => {
      throw Error("native");
    },
  );
  expect(result.events).toHaveLength(0);
  expect(result.warnings).toContain(
    `${bars[279]!.date} 沪深300 M=5低于6：市场环境极差，形态分析继续，禁止做多。`,
  );
});
