import { canslimMarketCombinationIds } from "trading-strategies/research/canslim/research-canslim-market-strategies";
import { researchFormulaRuntime } from "~/lib/research/technical/research-formula-runtime";
import { expect, it } from "vitest";
import type { Bar } from "../../src/lib/domain";
import { researchRuleSeries } from "trading-strategies/research/composition/research-rule-series";
import { researchCanslimMarketCombination } from "trading-strategies/research/canslim/research-canslim-market-combination";
import { researchCanslimPriorityPoint } from "trading-strategies/research/canslim/research-canslim-priority";

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
    undefined,
    researchFormulaRuntime,
  );
  expect(low[279]).toMatchObject({
    entry: false,
    candidate: { family: "flat" },
    market: { total: 5, warning: expect.stringContaining("继续分析") },
  });
  expect(
    researchRuleSeries(
      "canslim-priority-market-m6",
      bars,
      calendar,
      undefined,
      undefined,
      researchFormulaRuntime,
    )[279],
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
        undefined,
        researchFormulaRuntime,
      )[279],
    ).toMatchObject({ entry: false, market: { total: null } });
  }
  expect(
    researchRuleSeries(
      "canslim-priority-market-m6",
      bars.filter((_, i) => i !== 270),
      calendar,
      valid.market,
      undefined,
      researchFormulaRuntime,
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

it.each(canslimMarketCombinationIds)(
  "%s preserves geometry and market evidence across prefixes",
  (id) => {
    const { bars, calendar, market } = fixture();
    const full = researchRuleSeries(
      id,
      bars,
      calendar,
      market,
      undefined,
      researchFormulaRuntime,
    );
    expect(full[279]).toMatchObject({
      entry: true,
      candidate: { family: "flat", high: 100 },
      market: { allowed: true, total: 23 },
    });
    expect(
      researchRuleSeries(
        id,
        bars.slice(0, 280),
        calendar.slice(0, 280),
        {
          ...market,
          bars: market.bars.slice(0, 280),
        },
        undefined,
        researchFormulaRuntime,
      ),
    ).toEqual(full.slice(0, 280));
    market.bars[285]!.close = 1;
    expect(
      researchRuleSeries(
        id,
        bars,
        calendar,
        market,
        undefined,
        researchFormulaRuntime,
      ).slice(0, 285),
    ).toEqual(full.slice(0, 285));
  },
);
