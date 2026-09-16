import { expect, it, vi } from "vitest";
import type { Bar } from "../src/lib/domain";
import { analyzeBreakout } from "../src/server/breakout";
import {
  legacyBreakoutRuleIds,
  breakoutRuleDecision,
  type BreakoutRuleId,
} from "../src/lib/research-breakout-rules";
import { researchRuleSeries } from "../src/server/research-rule-series";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchSignals } from "../src/server/research-signals";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";
import { runStrategyResearch } from "../src/server/research-run";
import {
  researchHash,
  type ResearchDataset,
} from "../src/server/research-dataset";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";
const native = vi.fn(async (): Promise<never> => {
  throw new Error("native must not run");
});
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
  tradable: true,
  limitUp: null,
  limitDown: null,
};
function fixture(): Bar[] {
  const bars = Array.from({ length: 190 }, (_, i) => {
    let high =
        160 - 0.1 * i - 5 * (1 - Math.cos((2 * Math.PI * (i - 85)) / 25)),
      low = high - 3,
      close = high - 1,
      open = high - 2;
    if (i > 140) {
      close =
        150 + 0.2 * (i - 141) + 3 * Math.cos((2 * Math.PI * (i - 145)) / 12);
      high = close + 2;
      low = close - 2;
      open = close - 0.2;
    }
    return {
      date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume: 10000,
      amount: close * 10000,
    };
  });
  Object.assign(bars[140]!, {
    open: 140,
    close: 151,
    high: 152,
    low: 139,
    volume: 30000,
  });
  Object.assign(bars[182]!, {
    open: 165,
    close: 140,
    high: 166,
    low: 139,
    volume: 30000,
  });
  return bars;
}
function settings(strategy: BreakoutRuleId, bars: Bar[]) {
  return researchSpecSchema.parse({
    strategy,
    start: bars[140]!.date,
    end: bars.at(-1)!.date,
    validationStart: bars[188]!.date,
    symbols: ["sh600000"],
    initialCapital: 200000,
    holdingDays: 60,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
}
it.each(legacyBreakoutRuleIds)(
  "%s reuses confirmed historical geometry and trades at the next open",
  async (id) => {
    const bars = fixture(),
      spec = settings(id, bars),
      series = researchRuleSeries(id, bars);
    expect(series[140]!.entry).toBe(true);
    expect(series[182]!.exit).toBe(true);
    expect(researchRuleSeries(id, bars.slice(0, 141))).toEqual(
      series.slice(0, 141),
    );
    const events = await researchSignals("sh600000", bars, spec, native);
    const result = researchPortfolio(
      spec,
      events,
      bars.map((b) => b.date),
      new Map([["sh600000", bars]]),
      () => rules,
    );
    const trade = result.trades.find(
      (t) => t.event.observedDate === bars[140]!.date,
    );
    expect(trade).toBeDefined();
    expect(trade!.entryDate).toBe(bars[141]!.date);
    expect(trade!.exitDate).toBe(bars[183]!.date);
    expect(trade!.signalExit).toEqual(series[182]);
    expect(researchMethodSnapshot(spec).ruleVersion).toBe(`${id}-1`);
    expect(native).not.toHaveBeenCalled();
  },
);
it("distinguishes reverse-line and three-check exits without requiring auxiliary votes", () => {
  const bars = fixture(),
    points = analyzeBreakout(bars, 0).points;
  const sell = structuredClone(points[182]!);
  sell.short.checks.level = "否";
  sell.short.checks.volume = "否";
  expect(
    breakoutRuleDecision("breakout-reverse-line-exit", sell, bars[182]!).exit,
  ).toBe(true);
  expect(
    breakoutRuleDecision("breakout-down-exit", sell, bars[182]!).exit,
  ).toBe(false);
  sell.short.checks.trend = "未知";
  expect(
    breakoutRuleDecision("breakout-reverse-line-exit", sell, bars[182]!).exit,
  ).toBe(false);
  const buy = structuredClone(points[140]!);
  buy.long.status = "未知";
  expect(
    breakoutRuleDecision("breakout-down-exit", buy, bars[140]!).entry,
  ).toBe(true);
  buy.long.checks.volume = "未知";
  expect(
    breakoutRuleDecision("breakout-down-exit", buy, bars[140]!).entry,
  ).toBe(false);
});
it("keeps touch, span and body filters independent and rejects invalid prices", () => {
  const bars = fixture(),
    point = analyzeBreakout(bars, 0).points[140]!;
  expect(point.long.line!.touches).toBeGreaterThanOrEqual(3);
  expect(
    point.long.line!.anchors[1].index - point.long.line!.anchors[0].index,
  ).toBe(25);
  const few = structuredClone(point);
  few.long.line!.touches = 2;
  expect(breakoutRuleDecision("breakout-touch-3", few, bars[140]!).entry).toBe(
    false,
  );
  expect(breakoutRuleDecision("breakout-span-20", few, bars[140]!).entry).toBe(
    true,
  );
  few.long.line!.anchors[0].index = few.long.line!.anchors[1].index - 19;
  expect(breakoutRuleDecision("breakout-span-20", few, bars[140]!).entry).toBe(
    false,
  );
  expect(
    breakoutRuleDecision("breakout-large-body", point, {
      ...bars[140]!,
      open: 150,
    }).entry,
  ).toBe(false);
  for (const change of [{ volume: 0 }, { open: NaN }, { low: 200 }])
    expect(
      breakoutRuleDecision("breakout-down-exit", point, {
        ...bars[140]!,
        ...change,
      }),
    ).toMatchObject({ entry: false, exit: false, reason: expect.any(String) });
});
it("preserves blocked reverse intent and requires independent sell rules", async () => {
  const bars = fixture(),
    spec = settings("breakout-down-exit", bars),
    events = await researchSignals("sh600000", bars, spec, native);
  const run = (lookup: Parameters<typeof researchPortfolio>[4]) =>
    researchPortfolio(
      spec,
      events,
      bars.map((b) => b.date),
      new Map([["sh600000", bars]]),
      lookup,
    );
  const delayed = run((_s, date) => ({
    ...rules,
    tradable: date !== bars[183]!.date,
  }));
  expect(delayed.trades[0]!.exitDate).toBe(bars[184]!.date);
  expect(delayed.trades[0]!.signalExit!.date).toBe(bars[182]!.date);
  const buyOnly = {
    ...rules,
    minimumSell: undefined,
    sellStep: undefined,
    maximumSell: undefined,
    sellOddLotAll: undefined,
  };
  expect(run(() => buyOnly).trades).toEqual([]);
});
it("requires sixty preceding bars of action evidence in the full runner", async () => {
  const bars = fixture(),
    spec = settings("breakout-down-exit", bars);
  const dataset: ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "synthetic",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: spec.symbols!,
      source: null,
      warning: "合成",
    },
    benchmark: { symbol: "sh000001", bars },
    calendar: bars.map((b) => b.date),
    stocks: [
      {
        symbol: "sh600000",
        name: "合成",
        bars,
        hash: researchHash(bars),
        actions: [],
      },
    ],
    excluded: [],
    actionCoverage: "partial",
    actionSource: { path: "fixture", modified: 0 },
    capturedAt: 0,
    hash: "breakout-fixture",
    method: researchMethodSnapshot(spec),
  };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "fixture",
    exportedAt: 0,
    adjustment: "none",
    corporateActionFree: [
      {
        symbol: "sh600000",
        start: bars[80]!.date,
        end: spec.end,
        evidenceId: "fixture",
      },
    ],
    rows: bars.map((b) => ({
      ...rules,
      evidence: undefined,
      symbol: "sh600000",
      date: b.date,
      evidenceId: "fixture",
    })),
  });
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  expect(result.partitions[0]!.simulation!.trades[0]!.exitDate).toBe(
    bars[183]!.date,
  );
  expect(result.warnings[0]).toContain("前60根");
  const short = await runStrategyResearch(
    spec,
    dataset,
    {
      ...evidence,
      corporateActionFree: evidence.corporateActionFree.map((row) => ({
        ...row,
        start: spec.start,
      })),
    },
    native,
  );
  expect(short.events).toEqual(result.events);
  expect(short.partitions[0]!.simulation!.trades).toEqual([]);
  const split = await runStrategyResearch(
    spec,
    {
      ...dataset,
      stocks: dataset.stocks.map((stock) => ({
        ...stock,
        actions: [
          {
            date: bars[80]!.date,
            category: 1,
            name: "合成除权",
            bonusRatio: 1,
          },
        ],
      })),
    },
    evidence,
    native,
  );
  expect(split.events).toEqual([]);
  expect(split.exclusions[0]!.reason).toContain("K线形态窗口含除权");
});
