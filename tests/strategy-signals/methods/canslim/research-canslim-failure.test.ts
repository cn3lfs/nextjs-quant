import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import { researchSpecSchema } from "../../../../src/lib/research/strategy-research";
import { researchRuleSeries } from "../../../../src/server/strategies/shared/research-rule-series";
import { researchSignals } from "../../../../src/server/strategies/shared/research-signals";
import { researchPortfolio } from "../../../../src/server/backtest/research-portfolio";
import { runStrategyResearch } from "../../../../src/server/backtest/research-run";
import { researchMethodSnapshot } from "../../../../src/server/research/research-method";
import type { ResearchDataset } from "../../../../src/server/backtest/research-dataset";
import { researchMarketEvidenceSchema } from "../../../../src/lib/research/factors/research-market-evidence";

const rules = {
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
};
const native = async (): Promise<never> => {
  throw Error("unexpected native");
};
function setup(
  strategy:
    | "canslim-priority-fail3-low"
    | "canslim-priority-fail3-close" = "canslim-priority-fail3-low",
) {
  const bars: Bar[] = Array.from({ length: 80 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: i >= 70 ? 102 : 97,
    high: i >= 69 ? 103 : 100,
    low: i >= 70 ? 101 : 95,
    close: i >= 69 ? 102 : 97,
    volume: i < 49 ? 100 : i < 59 ? 45 : i < 69 ? 35 : 70,
    amount: 1000000,
  }));
  const spec = researchSpecSchema.parse({
    strategy,
    symbols: ["sh600000"],
    start: bars[61]!.date,
    end: bars[79]!.date,
    validationStart: bars[78]!.date,
    holdingDays: 6,
    entryMaxWait: 5,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const calendar = bars.map((b) => b.date);
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
  };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "fixture",
    exportedAt: 0,
    adjustment: "none",
    corporateActionFree: [
      {
        symbol: "sh600000",
        start: bars[0]!.date,
        end: spec.end,
        evidenceId: "fixture",
      },
    ],
    rows: bars.map((b) => ({
      symbol: "sh600000",
      date: b.date,
      ...rules,
      evidenceId: "fixture",
    })),
  });
  return { bars, spec, calendar, dataset, evidence };
}

it("uses breakout-relative days 1..3, strict pivot breach, and separate low/close triggers", () => {
  for (const strategy of [
    "canslim-priority-fail3-low",
    "canslim-priority-fail3-close",
  ] as const) {
    for (const day of [1, 2, 3, 4]) {
      const { bars, calendar } = setup(strategy);
      const index = 69 + day;
      bars[index]!.low = 99;
      if (strategy.endsWith("close")) bars[index]!.close = 99.5;
      const points = researchRuleSeries(strategy, bars, calendar);
      expect(points[index]!.exit).toBe(day <= 3);
      if (day <= 3)
        expect(points[index]).toMatchObject({
          pivotFailures: [
            {
              breakoutDate: bars[69]!.date,
              confirmationDate: bars[index]!.date,
              day,
              pivot: 100,
            },
          ],
        });
      expect(
        researchRuleSeries(strategy, bars.slice(0, index + 1), calendar),
      ).toEqual(points.slice(0, index + 1));
      bars[index]!.low = 100;
      bars[index]!.close = 100;
      expect(researchRuleSeries(strategy, bars, calendar)[index]!.exit).toBe(
        false,
      );
    }
  }
  const { bars } = setup();
  bars[70]!.low = 99;
  expect(
    researchRuleSeries("canslim-priority-fail3-close", bars)[70]!.exit,
  ).toBe(false);
});

it("does not extend the three-day window over missing bars or invent invalid-bar exits", () => {
  const { bars, calendar } = setup();
  bars[73]!.low = 99;
  const missing = bars.filter((_, i) => i !== 70);
  expect(
    researchRuleSeries("canslim-priority-fail3-low", missing, calendar).find(
      (p) => p.date === bars[73]!.date,
    )!.exit,
  ).toBe(false);
  bars[71]!.low = 99;
  bars[71]!.volume = 0;
  expect(
    researchRuleSeries("canslim-priority-fail3-low", bars, calendar)[71]!.exit,
  ).toBe(false);
});

it.each([
  "canslim-priority-fail3-low",
  "canslim-priority-fail3-close",
] as const)(
  "%s retains the entry and exits no earlier than the next sellable open",
  async (strategy) => {
    const { bars, spec, dataset, evidence } = setup(strategy);
    bars[70]!.low = 99;
    if (strategy.endsWith("close")) bars[70]!.close = 99.5;
    const result = await runStrategyResearch(spec, dataset, evidence, native);
    expect(result.events).toHaveLength(1);
    const trade = result.partitions[0]!.simulation!.trades[0]!;
    expect(trade).toMatchObject({
      entryDate: bars[70]!.date,
      exitDate: bars[71]!.date,
    });
    expect(trade.exitReason).toContain("第1日");
    expect(trade.signalExit).toMatchObject({
      date: bars[70]!.date,
      pivotFailures: [{ breakoutDate: bars[69]!.date }],
    });
    evidence.rows.find((r) => r.date === bars[71]!.date)!.tradable = false;
    evidence.rows.find((r) => r.date === bars[72]!.date)!.tradable = false;
    const delayed = await runStrategyResearch(spec, dataset, evidence, native);
    expect(delayed.partitions[0]!.simulation!.trades[0]).toMatchObject({
      entryDate: bars[70]!.date,
      exitDate: bars[73]!.date,
      signalExit: trade.signalExit,
    });
  },
);

it("cancels only an unfilled original breakout after failure and keeps observational events", async () => {
  const { bars, spec, dataset, evidence } = setup();
  bars[70]!.low = 99;
  evidence.rows.find((r) => r.date === bars[70]!.date)!.tradable = false;
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  expect(result.events).toHaveLength(1);
  expect(result.partitions[0]!.simulation!.trades).toEqual([]);
  expect(
    result.partitions[0]!.simulation!.excluded.some((e) =>
      e.reason.includes("三日内枢纽失守"),
    ),
  ).toBe(true);
});

it("does not close a position belonging to a different breakout date", async () => {
  const { bars, spec, calendar } = setup();
  bars[68]!.open = 100;
  bars[70]!.low = 99;
  const events = await researchSignals("sh600000", bars, spec, native);
  expect(events).toHaveLength(1);
  // Replay an earlier independent event to exercise position/event ownership.
  const earlier = {
    ...events[0]!,
    observedDate: bars[67]!.date,
    endpointDate: bars[67]!.date,
    key: "earlier-event",
  };
  const result = researchPortfolio(
    spec,
    [earlier],
    calendar,
    new Map([["sh600000", bars]]),
    () => rules,
  );
  expect(result.trades[0]).toMatchObject({
    entryDate: bars[68]!.date,
    exitDate: bars[74]!.date,
  });
  expect(result.trades[0]!.signalExit).toBeUndefined();
});

it("a delayed day-three entry still uses the original breakout's three-day deadline", async () => {
  for (const failureDay of [3, 4]) {
    const { bars, spec, calendar } = setup();
    bars[69 + failureDay]!.low = 99;
    const events = await researchSignals("sh600000", bars, spec, native);
    const result = researchPortfolio(
      spec,
      events,
      calendar,
      new Map([["sh600000", bars]]),
      (_, date) => ({
        ...rules,
        tradable: date !== bars[70]!.date && date !== bars[71]!.date,
      }),
    );
    expect(result.trades[0]).toMatchObject({
      entryDate: bars[72]!.date,
      exitDate: bars[failureDay === 3 ? 73 : 78]!.date,
    });
    if (failureDay === 3)
      expect(result.trades[0]!.signalExit).toMatchObject({
        date: bars[72]!.date,
        pivotFailures: [{ day: 3, breakoutDate: bars[69]!.date }],
      });
    else expect(result.trades[0]!.signalExit).toBeUndefined();
  }
});

it("an older failed breakout cannot cancel a later independent pending entry", async () => {
  const { bars, spec, calendar } = setup();
  bars[70]!.low = 99;
  const events = await researchSignals("sh600000", bars, spec, native);
  const later = {
    ...events[0]!,
    observedDate: bars[71]!.date,
    endpointDate: bars[71]!.date,
    key: "later-event",
  };
  const result = researchPortfolio(
    spec,
    [later],
    calendar,
    new Map([["sh600000", bars]]),
    () => rules,
  );
  expect(result.trades[0]).toMatchObject({
    entryDate: bars[72]!.date,
    exitDate: bars[78]!.date,
  });
  expect(result.excluded).toEqual([]);
});
