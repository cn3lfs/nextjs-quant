import { expect, it } from "vitest";
import {
  computeTheoryPositionPlan,
  createValueMultifactorFamilyScreener,
  prepareTheoryScreeners,
  theoryScreenerFamilyIds,
  valueMultifactorSpecs,
  type TheoryScreenContext,
  type TheoryScreenFinancialSnapshot,
} from "../src/screener/index.js";

const signal = 80;
function history(price: (index: number) => number) {
  return Array.from({ length: signal + 1 }, (_, i) => {
    const close = price(i);
    return {
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: close,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: i > 0 && close < price(i - 1) ? 60 : 150,
      amount: 10000,
    };
  });
}
const trend = history(
  (i) => 100 + i * 0.35 + (i % 2) * 0.6 + (i === signal ? 2 : 0),
);
const base = history((i) => (i === signal ? 102 : i === signal - 1 ? 99 : 100));
const cases: {
  slug: string;
  bars: typeof trend;
  passing: TheoryScreenFinancialSnapshot;
  failing: TheoryScreenFinancialSnapshot;
  reward: number;
}[] = [
  {
    slug: "greenblatt-magic-formula",
    bars: trend,
    passing: { roic: 12, earningsYield: 0.04 },
    failing: { roic: 12, pe: -1 },
    reward: 2.5,
  },
  {
    slug: "piotroski-fscore",
    bars: trend,
    passing: { fScore: 7 },
    failing: { fScore: 6, roe: 10, grossMargin: 20 },
    reward: 2.5,
  },
  {
    slug: "lynch-garp-peg",
    bars: trend,
    passing: { pe: 18, profitGrowthYoY: 15 },
    failing: { pe: 10, profitGrowthYoY: 66 },
    reward: 2.5,
  },
  {
    slug: "graham-value-shield",
    bars: base,
    passing: { ncavPerShare: 82 },
    failing: { pe: 16, pb: 1.81 },
    reward: 2.2,
  },
  {
    slug: "quality-momentum-lowvol",
    bars: trend,
    passing: { roe: 10, grossMargin: 18 },
    failing: { roe: 10, grossMargin: 17.9 },
    reward: 2.5,
  },
];

function find(slug: string, context: TheoryScreenContext) {
  return createValueMultifactorFamilyScreener(context)
    .at(signal)
    .find((m) => m.methodId === "f13-" + slug);
}

it("registers all five F13 methods and exposes specs on empty history", () => {
  expect(theoryScreenerFamilyIds).toContain("value-multifactor");
  const registered = prepareTheoryScreeners(
    { bars: [] },
    { families: ["value-multifactor"] },
  );
  expect(registered.specs).toEqual(valueMultifactorSpecs);
  expect(registered.specs.map((s) => s.id).sort()).toEqual(
    cases.map((c) => "f13-" + c.slug).sort(),
  );
  expect(registered.at(0)).toEqual([]);
  expect(createValueMultifactorFamilyScreener({ bars: [] }).at(0)).toEqual([]);
});

it.each(cases)(
  "$slug checks financials at the signal date and sizes a valid long exit",
  ({ slug, bars, passing, failing, reward }) => {
    const m = find(slug, { bars, financials: passing });
    expect(m?.family).toBe("value-multifactor");
    expect(m?.direction).toBe("long");
    expect(m!.stopPrice).toBeLessThan(m!.close);
    expect(m!.targetPrice).toBeCloseTo(
      m!.close + reward * (m!.close - m!.stopPrice!),
    );
    expect(m!.rewardMultiple).toBeCloseTo(reward);
    expect(find(slug, { bars, financials: failing })).toBeUndefined();
    const extended = [
      ...bars,
      { ...bars[signal]!, date: "2023-01-01", close: 900, high: 901 },
    ];
    expect(
      find(slug, {
        bars: extended,
        financials: failing,
        financialsAt: (i) => (i === signal ? passing : failing),
      }),
    ).toEqual(m);
    expect(
      find(slug, {
        bars: extended,
        financials: passing,
        financialsAt: (i) => (i === signal ? failing : passing),
      }),
    ).toBeUndefined();
  },
);

it.each(cases)(
  "$slug accepts the causal price proxy and requires the price trigger",
  ({ slug, bars, passing, failing }) => {
    const proxy = find(slug, { bars });
    expect(proxy?.direction).toBe("long");
    expect(
      find(slug, { bars, financials: failing, financialsAt: () => null }),
    ).toEqual(proxy);
    const flatEnd = bars.map((bar, i) =>
      i === signal ? { ...bars[i - 1]!, date: bar.date } : bar,
    );
    expect(find(slug, { bars: flatEnd })).toBeUndefined();
    expect(find(slug, { bars: flatEnd, financials: passing })).toBeUndefined();
  },
);

it("accepts the alternative financial routes independently", () => {
  expect(
    find("greenblatt-magic-formula", {
      bars: trend,
      financials: { roe: 12, pe: 25 },
    }),
  ).toBeDefined();
  expect(
    find("piotroski-fscore", {
      bars: trend,
      financials: {
        currentRatio: 1.2,
        debtToAsset: 60,
        operatingCashFlowPerShare: 1,
      },
    }),
  ).toBeDefined();
  expect(
    find("lynch-garp-peg", {
      bars: trend,
      financials: { profitGrowthYoY: 65, roe: 14 },
    }),
  ).toBeDefined();
  expect(
    find("graham-value-shield", {
      bars: base,
      financials: { pe: 16, pb: 1.8 },
    }),
  ).toBeDefined();
});

it("suppresses each price proxy when its quality condition fails despite a confirmed trigger", () => {
  const drawdown = trend.map((bar, i) =>
    i === 40 ? { ...bar, open: 70, close: 70, low: 69.9, high: 70.1 } : bar,
  );
  expect(find("greenblatt-magic-formula", { bars: drawdown })).toBeUndefined();
  const distribution = trend.map((bar, i) => ({
    ...bar,
    volume: i > 0 && bar.close < trend[i - 1]!.close ? 150 : 60,
  }));
  expect(find("piotroski-fscore", { bars: distribution })).toBeUndefined();
  const wideRange = trend.map((bar, i) =>
    i === signal - 7 ? { ...bar, low: 70 } : bar,
  );
  expect(find("lynch-garp-peg", { bars: wideRange })).toBeUndefined();
  const wideBase = base.map((bar, i) =>
    i === signal - 35 ? { ...bar, high: 125 } : bar,
  );
  expect(find("graham-value-shield", { bars: wideBase })).toBeUndefined();
});
it("uses sample deviation of the prior 60 returns, excluding the trigger", () => {
  function oscillating(amplitude: number) {
    const closes = [100];
    for (let i = 1; i < signal; i++) {
      closes.push(closes[i - 1]! * (1.004 + (i % 2 ? amplitude : -amplitude)));
    }
    closes.push(closes[signal - 1]! * 1.1);
    return history((i) => closes[i]!);
  }
  // Balanced deviations give s = amplitude * sqrt(60 / 59).
  expect(
    find("quality-momentum-lowvol", { bars: oscillating(0.0246) }),
  ).toBeDefined();
  expect(
    find("quality-momentum-lowvol", { bars: oscillating(0.0249) }),
  ).toBeUndefined();
});

const prices = { rawClose: 30, rawStopPrice: 28, rawTargetPrice: 35 };
it("caps size by account weight and rounds down to complete default lots", () => {
  const plan = computeTheoryPositionPlan(prices);
  expect(plan).toEqual({
    riskPct: 2 / 30,
    rewardMultiple: 2.5,
    recommendedShares: 3300,
    recommendedWeightPct: 0.099,
    distinctFamilies: 0,
    maxScore: 3,
    confluenceGrade: "B",
  });
});

it("caps size by risk budget, including accounts too small for a single lot", () => {
  const input = {
    ...prices,
    accountEquity: 100000,
    riskPerTradePct: 0.005,
    maxPositionPct: 0.5,
    lotSize: 40,
  };
  expect(computeTheoryPositionPlan(input)).toMatchObject({
    recommendedShares: 240,
    recommendedWeightPct: 0.072,
  });
  expect(
    computeTheoryPositionPlan({ ...input, accountEquity: 100 }),
  ).toMatchObject({ recommendedShares: 0, recommendedWeightPct: 0 });
});

it("reports short risk without allocating long shares and rejects invalid risk geometry", () => {
  expect(
    computeTheoryPositionPlan({
      rawClose: 20,
      rawStopPrice: 22,
      rawTargetPrice: 14,
    }),
  ).toMatchObject({
    riskPct: 0.1,
    rewardMultiple: 3,
    recommendedShares: 0,
    recommendedWeightPct: 0,
  });
  for (const rawStopPrice of [null, 0, NaN, prices.rawClose]) {
    expect(
      computeTheoryPositionPlan({ ...prices, rawStopPrice }),
    ).toMatchObject({
      riskPct: null,
      rewardMultiple: null,
      recommendedShares: 0,
      recommendedWeightPct: 0,
    });
  }
});

it("grades confluence by distinct theory family and promotes a high-scoring single family", () => {
  const first = { family: "screen", theoryFamily: "value", score: 4 };
  const single = [first, { family: "value", score: 5 }];
  expect(
    computeTheoryPositionPlan({ ...prices, matches: single }),
  ).toMatchObject({ distinctFamilies: 1, maxScore: 5, confluenceGrade: "A" });
  const two = [first, { family: "momentum", score: 3 }];
  expect(computeTheoryPositionPlan({ ...prices, matches: two })).toMatchObject({
    distinctFamilies: 2,
    maxScore: 4,
    confluenceGrade: "A",
  });
  expect(
    computeTheoryPositionPlan({
      ...prices,
      matches: [...two, { family: "growth" }],
    }),
  ).toMatchObject({ distinctFamilies: 3, confluenceGrade: "S" });
});

it("uses only snapshots available on the historical signal date", () => {
  const bars = [...trend, { ...trend[signal]!, date: "2024-01-01" }];
  const slug = "greenblatt-magic-formula";
  const proxy = find(slug, { bars });
  expect(proxy).toBeDefined();
  const failing = { roic: 0 };
  for (const availableAt of [undefined, null, "2024-01-01"]) {
    expect(
      find(slug, { bars, financials: { ...failing, availableAt } }),
    ).toEqual(proxy);
  }
  expect(
    find(slug, {
      bars,
      financialsAt: () => ({ ...failing, availableAt: "2024-01-01" }),
    }),
  ).toEqual(proxy);
  expect(
    find(slug, {
      bars,
      financials: { ...failing, availableAt: bars[signal]!.date },
    }),
  ).toBeUndefined();
});

it.each([NaN, Infinity, -Infinity])(
  "rejects non-finite financial evidence (%s)",
  (invalid) => {
    for (const { slug, bars, passing } of cases) {
      for (const field of Object.keys(passing)) {
        expect(
          find(slug, { bars, financials: { ...passing, [field]: invalid } }),
        ).toBeUndefined();
      }
    }
    for (const field of [
      "debtToAsset",
      "currentRatio",
      "operatingCashFlowPerShare",
      "profitGrowthYoY",
    ]) {
      expect(
        find("piotroski-fscore", {
          bars: trend,
          financials: { roe: 10, grossMargin: 20, [field]: invalid },
        }),
      ).toBeUndefined();
    }
  },
);

it("counts only aligned or directionless evidence toward confluence", () => {
  const matches = [
    { family: "momentum", direction: "short", score: 5 },
    { family: "quality", direction: "long", score: 3 },
    { family: "quality", score: 2 },
  ] as const;
  expect(
    computeTheoryPositionPlan({ ...prices, direction: "long", matches }),
  ).toMatchObject({ distinctFamilies: 1, maxScore: 3, confluenceGrade: "B" });
  expect(computeTheoryPositionPlan({ ...prices, matches })).toMatchObject({
    distinctFamilies: 2,
    maxScore: 5,
    confluenceGrade: "A",
  });
});
