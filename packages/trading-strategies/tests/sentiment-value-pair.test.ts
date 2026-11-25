import { describe, expect, it } from "vitest";
import {
  etfRotationUniverse,
  evaluatePairSwitchZScore,
  evaluateSentimentRegime,
  generatePairSwitchSchedule,
  rankDividendLowVolPit,
  rankFScoreLocal8Pit,
  rankGarpPit,
  rankMagicFormulaPit,
  selectDragonForwardCandidates,
  spotPairPresets,
  type LimitPoolCandidateRow,
  type LimitPoolStatsSnapshot,
  type SentimentPhase,
  type ValuePitCandidate,
} from "../src/index.js";
import { candle } from "./ohlc-fixtures.js";

const asOf = "2025-01-02";
const next = "2025-01-03";
function pool(
  stats: Partial<LimitPoolStatsSnapshot> = {},
): LimitPoolStatsSnapshot {
  return {
    date: asOf,
    limitUp: 35,
    broken: 5,
    limitDown: 10,
    maxHeight: 3,
    breakRate: null,
    promotionRate: null,
    yesterdayAvgChange: null,
    ...stats,
  };
}
describe("completed A-share sentiment snapshots", () => {
  it.each<
    [SentimentPhase, Partial<LimitPoolStatsSnapshot>, number | null, boolean]
  >([
    ["ice", { limitUp: 25, limitDown: 15, breakRate: 45 }, 0.3, false],
    ["ebb", { breakRate: 40 }, 0.2, false],
    ["ebb", { limitDown: 20, yesterdayAvgChange: -1.5 }, 0.2, false],
    ["climax", { limitUp: 90, maxHeight: 5, promotionRate: 25 }, 0.6, false],
    [
      "ferment",
      { limitUp: 50, maxHeight: 4, promotionRate: 25, breakRate: 0 },
      1,
      true,
    ],
    [
      "unknown",
      { limitUp: 50, maxHeight: 4, promotionRate: 25, breakRate: null },
      null,
      false,
    ],
    [
      "recovery",
      { limitUp: 50, maxHeight: 4, promotionRate: null, breakRate: 20 },
      0.75,
      true,
    ],
    ["recovery", { limitUp: 30, limitDown: 14, breakRate: 20 }, 0.75, true],
    ["unknown", { limitUp: 30, limitDown: 14, breakRate: null }, null, false],
    ["unknown", { limitUp: 29, maxHeight: 4 }, null, false],
    ["unknown", { limitDown: 20, yesterdayAvgChange: null }, null, false],
    ["unknown", { maxHeight: NaN }, null, false],
    ["unknown", { broken: NaN }, null, false],
  ])("%s from %j", (phase, stats, exposureScale, allowNewEntries) => {
    expect(evaluateSentimentRegime([pool(stats)])).toEqual({
      phase,
      exposureScale,
      allowNewEntries,
    });
  });
  it("uses yesterday's height only with measured promotion and ignores future snapshots", () => {
    const prior = pool({ date: "2025-01-01", maxHeight: 5 });
    const current = pool({ promotionRate: 19 });
    expect(
      evaluateSentimentRegime(
        [prior, current, pool({ date: next, maxHeight: 9 })],
        { asOf },
      ).phase,
    ).toBe("ebb");
    expect(
      evaluateSentimentRegime([prior, pool({ breakRate: 20 })], { asOf }).phase,
    ).toBe("recovery");
  });
  it("fails closed on empty, duplicate and reversed visible dates", () => {
    for (const history of [
      [],
      [pool(), pool()],
      [pool({ date: next }), pool()],
    ])
      expect(evaluateSentimentRegime(history)).toEqual({
        phase: "unknown",
        exposureScale: null,
        allowNewEntries: false,
      });
    expect(
      evaluateSentimentRegime([pool({ date: next })], { asOf }).phase,
    ).toBe("unknown");
  });
});

function dragon(
  symbol: string,
  patch: Partial<LimitPoolCandidateRow> = {},
): LimitPoolCandidateRow {
  return {
    symbol,
    name: symbol,
    price: 10,
    changePct: null,
    amount: 2e8,
    turnover: 5,
    industry: "",
    streak: 2,
    breaks: 1,
    sealFund: 50,
    ...patch,
  };
}
describe("forward-only dragon watchlist", () => {
  it.each(["ice", "ebb", "climax", "unknown"] as const)(
    "blocks new candidates during %s",
    (phase) => {
      const result = selectDragonForwardCandidates({
        date: asOf,
        phase,
        ztPool: [dragon("A")],
        yztPool: [],
      });
      expect(result).toMatchObject({ candidates: [], forwardOnly: true });
      expect(result.reason).toContain(phase);
    },
  );
  it.each(["recovery", "ferment"] as const)(
    "filters today's pool and orders streak, seal and symbol in %s",
    (phase) => {
      const ztPool = [
        dragon("B"),
        dragon("N", { sealFund: null }),
        dragon("Z", { sealFund: 0 }),
        dragon("A"),
        dragon("C", { streak: 3, turnover: 35 }),
        dragon("D", { breaks: null }),
        dragon("E", { streak: 1 }),
        dragon("F", { amount: 2e8 - 1 }),
        dragon("G", { turnover: 36 }),
        dragon("H", { breaks: 2 }),
        dragon("I", { turnover: 4 }),
      ];
      const input = {
        date: asOf,
        phase,
        ztPool,
        yztPool: [dragon("yesterday", { streak: 9 })],
      };
      expect(
        selectDragonForwardCandidates(input).candidates.map((r) => r.symbol),
      ).toEqual(["C", "A", "B", "Z", "N"]);
      expect(
        selectDragonForwardCandidates({
          ...input,
          maxCandidates: 2,
        }).candidates.map((r) => r.symbol),
      ).toEqual(["C", "A"]);
    },
  );
});

function stock(
  symbol: string,
  fields: Partial<ValuePitCandidate> = {},
): ValuePitCandidate {
  return {
    symbol,
    asOf,
    availableAt: asOf,
    isFinancial: false,
    price: 10,
    marketCap: null,
    enterpriseValue: 100,
    ebit: 10,
    investedCapital: 50,
    peTtm: 20,
    netProfitGrowthYoY: 0.2,
    operatingCashFlow: 7,
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
    ...fields,
  };
}
describe("PIT equal-weight value portfolios", () => {
  it.each([
    rankMagicFormulaPit,
    rankFScoreLocal8Pit,
    rankDividendLowVolPit,
    rankGarpPit,
  ])(
    "%s excludes a later disclosure, later price and invisible revision before scoring",
    (rank) => {
      const rows = [
        stock("B"),
        stock("A"),
        stock("future-report", { availableAt: next }),
        stock("future-price", { asOf: next }),
        stock("A", {
          availableAt: next,
          ebit: 0,
          roa: null,
          price: 0,
          peTtm: 0,
        }),
      ];
      const result = rank(rows, asOf);
      expect(result.weights).toEqual({ A: 0.5, B: 0.5 });
      expect(Object.keys(result.scores)).toEqual(["A", "B"]);
      expect(result.excluded).toEqual(["future-price", "future-report"]);
      expect(rank(rows.reverse(), asOf)).toEqual(result);
    },
  );
  it("ranks EBIT/EV and EBIT/capital only for confirmed non-financials with positive denominators", () => {
    // A = (.20,.10), B = (.10,.20), C = (.05,.05): sums 3,3,6.
    const rows = [
      stock("C", { enterpriseValue: 200, investedCapital: 200 }),
      stock("B"),
      stock("A", { enterpriseValue: 50, investedCapital: 100 }),
      stock("bank", { isFinancial: true }),
      stock("unclassified", { isFinancial: undefined }),
      stock("zero", { investedCapital: 0 }),
    ];
    const result = rankMagicFormulaPit(rows, asOf, 1);
    expect(result).toMatchObject({
      strategyId: "value-magic-formula-pit",
      scores: { A: 3, B: 3, C: 6 },
      weights: { A: 1 },
      excluded: ["bank", "unclassified", "zero"],
    });
  });
  it("counts all eight items, resolves score ties by CFO then symbol, and excludes missing inputs even at minScore 0", () => {
    const rows = [
      stock("Z", { cfoToAssets: 0.2 }),
      stock("A"),
      stock("B"),
      stock("six", { priorRoa: 0.1, priorLeverage: 0.3 }),
      stock("five", {
        priorRoa: 0.1,
        priorLeverage: 0.3,
        priorGrossMargin: 0.4,
      }),
      stock("missing", { priorAssetTurnover: null }),
    ];
    const result = rankFScoreLocal8Pit(rows, asOf, { topK: 2 });
    expect(result.scores).toEqual({ A: 8, B: 8, Z: 8, six: 6 });
    expect(result.weights).toEqual({ Z: 0.5, A: 0.5 });
    expect(result.excluded).toEqual(["five", "missing"]);
    expect(rankFScoreLocal8Pit(rows, asOf, { minScore: 0 }).excluded).toEqual([
      "missing",
    ]);
    expect(result.disclosure).toMatch(/8.*9.*发行/);
  });
  it("combines realized yield and low volatility with equal competition ranks for equal yields", () => {
    // Yields 5%, 5%, 2%; vols .2, .3, .1 => (1+2), (1+3), (3+1).
    const result = rankDividendLowVolPit(
      [
        stock("B", { volatility60d: 0.3 }),
        stock("A"),
        stock("C", { ttmCashDividendPerShare: 0.2, volatility60d: 0.1 }),
        stock("cash", { operatingCashFlow: 0 }),
        stock("price", { price: 0 }),
        stock("vol", { volatility60d: Infinity }),
      ],
      asOf,
      2,
    );
    expect(result).toMatchObject({
      scores: { A: 3, B: 4, C: 4 },
      weights: { A: 0.5, B: 0.5 },
      excluded: ["cash", "price", "vol"],
    });
  });
  it("uses percentage points in PEG and accepts inclusive PE, growth ceiling and cash coverage boundaries", () => {
    const result = rankGarpPit(
      [
        stock("B"),
        stock("A"),
        stock("C", { peTtm: 40, netProfitGrowthYoY: 1.5 }),
        stock("slow", { netProfitGrowthYoY: 0.1 }),
        stock("fast", { netProfitGrowthYoY: 1.51 }),
        stock("dear", { peTtm: 41 }),
        stock("poor", { operatingCashFlow: 6.99 }),
        stock("loss", { netIncome: -1 }),
      ],
      asOf,
      2,
    );
    expect(result.scores).toEqual({ A: 1, B: 1, C: 40 / 150 });
    expect(result.weights).toEqual({ C: 0.5, A: 0.5 });
    expect(result.excluded).toEqual(["dear", "fast", "loss", "poor", "slow"]);
    expect(result.disclosure).toMatch(/历史.*前瞻/);
  });
  it("orders a full cross-section including repeated factors independently of source order", () => {
    const rows = Array.from({ length: 80 }, (_, i) =>
      stock(`sh${510000 + i}`, { ebit: 1 + (i % 13), peTtm: 40 - (i % 40) }),
    ).reverse();
    const ordered = [...rows].sort(
      (a, b) => b.ebit! - a.ebit! || a.symbol.localeCompare(b.symbol),
    );
    const result = rankMagicFormulaPit(rows, asOf, 17);
    expect(Object.keys(result.weights)).toEqual(
      ordered.slice(0, 17).map((r) => r.symbol),
    );
    for (const r of rows)
      expect(result.scores[r.symbol]).toBe(
        2 * (1 + rows.filter((s) => s.ebit! > r.ebit!).length),
      );
    expect(Object.keys(rankGarpPit(rows, asOf, 17).weights)).toEqual(
      [...rows]
        .sort((a, b) => a.peTtm! - b.peTtm! || a.symbol.localeCompare(b.symbol))
        .slice(0, 17)
        .map((r) => r.symbol),
    );
  });
});

const digest = "a".repeat(64);
function pair(deltas: number[]) {
  return {
    legA: {
      symbol: "A",
      bars: deltas.map((d, i) => candle(i, Math.exp(i + d))),
    },
    legB: { symbol: "B", bars: deltas.map((_, i) => candle(i, Math.exp(i))) },
    asOf: "2025-12-31",
    lookback: 4,
    entryZ: 0.8,
    exitZ: 0.2,
    sourceHash: digest,
  };
}
describe("spot-only causal rolling log-spread", () => {
  it("uses six ETF symbols from the rotation universe", () => {
    const symbols = new Set(etfRotationUniverse.map((row) => row.symbol));
    expect(spotPairPresets.map((p) => [p.id, p.legA, p.legB])).toEqual([
      ["hs300-zz500", "sh510300", "sh510500"],
      ["dividend-chinext", "sh510880", "sz159915"],
      ["gold-treasury", "sh518880", "sh511010"],
    ]);
    expect(
      spotPairPresets.every((p) => symbols.has(p.legA) && symbols.has(p.legB)),
    ).toBe(true);
  });
  it("matches the hand-fit intercept, slope, sample residual deviation, correlation and cheap leg", () => {
    const fit = evaluatePairSwitchZScore(pair([0, 0, 0, 1]));
    // x=[0,1,2,3], y=[0,1,2,4], residuals=[.2,-.1,-.4,.3].
    expect(fit.alpha).toBeCloseTo(-0.2, 12);
    expect(fit.beta).toBeCloseTo(1.3, 12);
    expect(fit.sigma).toBeCloseTo(Math.sqrt(0.1), 12);
    expect(fit.correlation).toBeCloseTo(6.5 / Math.sqrt(5 * 8.75), 12);
    expect(fit.zScore).toBeCloseTo(0.3 / Math.sqrt(0.1), 12);
    expect(fit).toMatchObject({
      status: "ok",
      activeLeg: "B",
      targets: { A: 0, B: 1 },
    });
    expect(evaluatePairSwitchZScore(pair([0, 0, 0, -1]))).toMatchObject({
      activeLeg: "A",
      targets: { A: 1, B: 0 },
    });
  });
  it.each([1, -1])(
    "holds the previous leg across a sign reversal in the band, then exits at zero (%i)",
    (sign) => {
      const input = pair([0, 0, 0, sign, sign, (5 / 3) * sign]);
      const rows = generatePairSwitchSchedule(input);
      const active = sign === 1 ? "B" : "A";
      expect(rows.map((r) => r.activeLeg)).toEqual([
        "neutral",
        "neutral",
        "neutral",
        active,
        active,
        "neutral",
      ]);
      expect(rows[4]!.zScore).toBeCloseTo(
        (-sign * 0.1) / Math.sqrt(0.2 / 3),
        12,
      );
      expect(rows[5]!.zScore).toBeCloseTo(0, 12);
      expect(rows[5]!.targets).toEqual({ A: 0.5, B: 0.5 });
      for (const row of rows)
        expect(
          evaluatePairSwitchZScore({ ...input, asOf: row.date }).targets,
        ).toEqual(row.targets);
    },
  );
  it("preserves historical decisions after future data is appended; every scheduled weight is long-only and funded", () => {
    const initial = pair([0, 0, 0, 1, 1]);
    const extended = pair([0, 0, 0, 1, 1, 5 / 3, -2, 2, -1, 3, 0, 0, 1, 1]);
    const prefix = generatePairSwitchSchedule(initial),
      all = generatePairSwitchSchedule(extended);
    expect(all.slice(0, prefix.length)).toEqual(prefix);
    expect(
      generatePairSwitchSchedule({ ...extended, asOf: prefix.at(-1)!.date }),
    ).toEqual(prefix);
    for (const row of all) {
      expect(row).toMatchObject({
        strategyId: "stat-pair-switch-zscore",
        availableAt: row.date,
        sourceHash: digest,
        disclosure:
          "纯多头现货相对价值轮动，不含融券空头腿，不等同市场中性统计套利",
      });
      const w = Object.values(row.targets);
      expect(w.every((v) => v >= 0 && v <= 1)).toBe(true);
      expect(w.reduce((sum, v) => sum + v, 0)).toBeLessThanOrEqual(1);
    }
  });
  it.each(["missing A", "missing B", "missing both on calendar", "zero close"])(
    "clears targets on %s until four consecutive valid sessions are available",
    (gap) => {
      const data = pair([0, 0, 0, 1, 1, 0, 0, 0, 1]);
      const dates = data.legA.bars.map((bar) => bar.date);
      const shared = gap === "missing both on calendar";
      const input = { ...data, calendar: shared ? dates : undefined };
      if (gap === "missing A" || shared) input.legA.bars.splice(4, 1);
      if (gap === "missing B" || shared) input.legB.bars.splice(4, 1);
      if (gap === "zero close") input.legA.bars[4]!.close = 0;

      const rows = generatePairSwitchSchedule(input);
      expect(rows.map((r) => r.date)).toEqual(dates);
      expect(rows[3]!.targets).toEqual({ A: 0, B: 1 });
      for (const row of rows.slice(4, 8)) {
        expect(row.status).toBe("unknown");
        expect(row.targets).toEqual({});
        const current = evaluatePairSwitchZScore({ ...input, asOf: row.date });
        expect(current.date).toBe(row.date);
        expect(current.status).toBe("unknown");
        expect(current.targets).toEqual({});
      }
      expect(rows[8]!.targets).toEqual({ A: 0, B: 1 });
    },
  );
  it("keeps warm-up, collinear, constant and decorrelated windows in cash", () => {
    for (const input of [
      pair([0, 0, 1]),
      pair([0, 0, 0, 0]),
      pair([0, -1, -2, -3]),
      pair([0, -2, -4, -6]),
      { ...pair([0, 0, 0, 1]), minCorrelation: 0.99 },
    ]) {
      const result = evaluatePairSwitchZScore(input);
      expect(result).toMatchObject({
        status: "unknown",
        beta: null,
        zScore: null,
        activeLeg: "neutral",
      });
      expect(result.targets).toEqual({});
    }
  });
});
