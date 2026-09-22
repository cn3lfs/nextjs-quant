import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchRuleSeries } from "../src/server/strategies/shared/research-rule-series";
import { researchSignals } from "../src/server/strategies/shared/research-signals";
import { runStrategyResearch } from "../src/server/backtest/research-run";
import { researchMethodSnapshot } from "../src/server/research/research-method";
import type { ResearchDataset } from "../src/server/backtest/research-dataset";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";

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
    | "canslim-priority-bear4-previous"
    | "canslim-priority-bear4-ma20" = "canslim-priority-bear4-previous",
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

function drop(bars: Bar[], index: number, close: number, volume: number) {
  Object.assign(bars[index]!, {
    open: 102,
    high: 103,
    low: Math.min(97, close - 1),
    close,
    volume,
  });
}
const ids = [
  "canslim-priority-bear4-previous",
  "canslim-priority-bear4-ma20",
] as const;

it("uses a strict four-percent close loss and independent volume comparators", () => {
  for (const strategy of ids) {
    const { bars, calendar } = setup(strategy);
    const average =
      bars.slice(50, 70).reduce((sum, b) => sum + b.volume, 0) / 20;
    const threshold = strategy.endsWith("ma20")
      ? average * 1.5
      : bars[69]!.volume;
    drop(bars, 70, 102 * 0.96, threshold + 1);
    expect(researchRuleSeries(strategy, bars, calendar)[70]!.exit).toBe(false);
    bars[70]!.close -= 0.001;
    bars[70]!.volume = threshold;
    expect(researchRuleSeries(strategy, bars, calendar)[70]!.exit).toBe(
      strategy.endsWith("ma20"),
    );
    bars[70]!.volume = threshold + 0.001;
    const points = researchRuleSeries(strategy, bars, calendar);
    expect(points[70]).toMatchObject({
      exit: true,
      bearExit: {
        previousClose: 102,
        referenceVolume: strategy.endsWith("ma20") ? average : 70,
        triggered: true,
      },
    });
    expect(researchRuleSeries(strategy, bars.slice(0, 71), calendar)).toEqual(
      points.slice(0, 71),
    );
    bars[70]!.volume = threshold - 0.001;
    expect(researchRuleSeries(strategy, bars, calendar)[70]!.exit).toBe(false);
  }
});

it("does not require a bearish candle body or a pivot breach", () => {
  const { bars, calendar } = setup();
  drop(bars, 70, 97, 100);
  bars[70]!.open = 96;
  bars[70]!.low = 95;
  expect(researchRuleSeries(ids[0], bars, calendar)[70]!.exit).toBe(true);
  // The trigger compares consecutive closes, not the intraday candle color.
  bars[70]!.close = 102;
  bars[70]!.low = 90;
  expect(researchRuleSeries(ids[0], bars, calendar)[70]!.exit).toBe(false);
  Object.assign(bars[70]!, {
    open: 110,
    high: 111,
    low: 109,
    close: 110,
    volume: 70,
  });
  Object.assign(bars[71]!, {
    open: 104,
    high: 106,
    low: 103,
    close: 105,
    volume: 100,
  });
  expect(researchRuleSeries(ids[0], bars, calendar)[71]).toMatchObject({
    entry: false,
    exit: true,
  });
});

it("rejects gaps, invalid prices/volumes and incomplete prior-twenty windows", () => {
  for (const strategy of ids) {
    const { bars, calendar } = setup(strategy);
    drop(bars, 70, 97, 100);
    for (const field of ["close", "volume"] as const) {
      const original = bars[70]![field];
      bars[70]![field] = NaN;
      expect(researchRuleSeries(strategy, bars, calendar)[70]!.exit).toBe(
        false,
      );
      bars[70]![field] = original;
    }
    const missing = bars.filter((_, i) => i !== 69);
    expect(
      researchRuleSeries(strategy, missing, calendar).find(
        (p) => p.date === bars[70]!.date,
      )!.exit,
    ).toBe(false);
    bars[69]!.volume = 0;
    expect(researchRuleSeries(strategy, bars, calendar)[70]!.exit).toBe(false);
  }
  const { bars, calendar } = setup(ids[1]);
  drop(bars, 70, 97, 100);
  bars[52]!.volume = 0;
  expect(researchRuleSeries(ids[1], bars, calendar)[70]!.exit).toBe(false);
  expect(researchRuleSeries(ids[0], bars, calendar)[70]!.exit).toBe(true);
  const missing = bars.filter((_, i) => i !== 52);
  expect(
    researchRuleSeries(ids[1], missing, calendar).find(
      (p) => p.date === bars[70]!.date,
    )!.exit,
  ).toBe(false);
});

it.each(ids)(
  "%s retains the entry and exits next sellable open with its evidence",
  async (strategy) => {
    const { bars, spec, dataset, evidence } = setup(strategy);
    drop(bars, 70, 97, 100);
    const result = await runStrategyResearch(spec, dataset, evidence, native);
    expect(result.events).toHaveLength(1);
    const trade = result.partitions[0]!.simulation!.trades[0]!;
    expect(trade).toMatchObject({
      entryDate: bars[70]!.date,
      exitDate: bars[71]!.date,
      exitPrice: 102,
    });
    expect(trade.exitReason).toContain("跌超4%");
    expect(trade.signalExit).toMatchObject({
      date: bars[70]!.date,
      bearExit: {
        triggered: true,
        basis: strategy.endsWith("ma20") ? "ma20" : "previous",
      },
    });
    evidence.rows.find((r) => r.date === bars[71]!.date)!.tradable = false;
    evidence.rows.find((r) => r.date === bars[72]!.date)!.tradable = false;
    const blocked = await runStrategyResearch(spec, dataset, evidence, native);
    expect(blocked.partitions[0]!.simulation!.trades[0]).toMatchObject({
      exitDate: bars[73]!.date,
      signalExit: trade.signalExit,
    });
    evidence.corporateActionFree[0]!.start = bars[1]!.date;
    const uncovered = await runStrategyResearch(
      spec,
      dataset,
      evidence,
      native,
    );
    expect(uncovered.events).toHaveLength(1);
    expect(uncovered.partitions[0]!.simulation!.trades).toEqual([]);
  },
);

it("cancels an unfilled older entry after the close-confirmed reverse signal", async () => {
  const { bars, spec, dataset, evidence } = setup();
  drop(bars, 70, 97, 100);
  evidence.rows.find((r) => r.date === bars[70]!.date)!.tradable = false;
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  expect(result.events).toHaveLength(1);
  expect(result.partitions[0]!.simulation!.trades).toEqual([]);
  expect(
    result.partitions[0]!.simulation!.excluded.some((e) =>
      e.reason.includes("反向"),
    ),
  ).toBe(true);
});

it("keeps the base entry unchanged and records distinct source/version identities", async () => {
  const { bars, spec, calendar } = setup();
  const base = await researchSignals(
    "sh600000",
    bars,
    { ...spec, strategy: "canslim-priority" },
    native,
    undefined,
    undefined,
    calendar,
  );
  for (const strategy of ids) {
    const events = await researchSignals(
      "sh600000",
      bars,
      { ...spec, strategy },
      native,
      undefined,
      undefined,
      calendar,
    );
    expect(
      events.map((e) => [e.observedDate, e.entryPriceRange, e.historyStart]),
    ).toEqual(
      base.map((e) => [e.observedDate, e.entryPriceRange, e.historyStart]),
    );
    const method = researchMethodSnapshot({ ...spec, strategy });
    expect(
      method.sources.some(
        (s) => s.path === "canslim-analyst/references/entry-exit-rules.md",
      ),
    ).toBe(true);
    expect(events[0]!.strategyVersion).toContain(strategy);
  }
});
