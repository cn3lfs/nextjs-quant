import { expect, it } from "vitest";
import fixture from "../../fixtures/breakout-valid.json";
import { replayDailyStudy } from "quant-backtest";
import {
  createExtendedStudyRule,
  evaluateStrategy,
  getStrategyDefinition,
  checkStrategyAvailability,
  studyStrategies,
} from "trading-strategies";

const ids = [
  "research-breakout",
  "research-indicator-confluence",
  "research-volume-price",
] as const;
it("restores the exact three existing representatives as executable daily rules with source metadata", () => {
  for (const id of ids) {
    expect(studyStrategies).toContain(id);
    expect(getStrategyDefinition(id)).toMatchObject({
      implementation: "implemented",
      output: "signal",
      capabilities: ["ohlcv"],
    });
    expect(getStrategyDefinition(id)!.sources.length).toBeGreaterThan(0);
    expect(checkStrategyAvailability(id, ["ohlcv"]).available).toBe(true);
  }
  expect(getStrategyDefinition("research-value")!.capabilities).toContain(
    "point-in-time-financials",
  );
  expect(getStrategyDefinition("research-sentiment")!.capabilities).toContain(
    "sentiment-panel",
  );
  expect(
    getStrategyDefinition("research-industry-chain")!.capabilities,
  ).toContain("news-evidence");
  expect(getStrategyDefinition("research-chan")!.capabilities).toContain(
    "structure",
  );
});

it("reuses real positive cases and retains causal prefixes and readiness", () => {
  const bars = fixture.bars;
  expect(
    evaluateStrategy({ strategyId: ids[0] }, { asOf: bars.at(-1)!.date, bars }),
  ).toMatchObject({ kind: "signal", enter: true, exit: false });
  expect(
    evaluateStrategy({ strategyId: ids[1] }, { asOf: bars.at(-1)!.date, bars }),
  ).toMatchObject({ kind: "signal", enter: true, exit: false });
  expect(
    evaluateStrategy({ strategyId: ids[2] }, { asOf: bars.at(-2)!.date, bars }),
  ).toMatchObject({ kind: "signal", enter: true, exit: false });
  for (const id of ids) {
    const full = createExtendedStudyRule(id, bars)!;
    const cutoff = 310,
      prefix = createExtendedStudyRule(id, bars.slice(0, cutoff + 1))!;
    expect(full(cutoff, { entry: 0, entryIndex: 0 })).toEqual(
      prefix(cutoff, { entry: 0, entryIndex: 0 }),
    );
    expect(() =>
      evaluateStrategy(
        { strategyId: id },
        { asOf: bars[60]!.date, bars: bars.slice(0, 61) },
      ),
    ).toThrow("行情");
  }
});

it.each(ids)(
  "%s executes real entry and exit signals through the existing next-open cash ledger",
  (strategy) => {
    // Explicit synthetic future decline exercises exit execution after the real positive sample.
    const last = fixture.bars.at(-1)!;
    const bars = [
      ...fixture.bars,
      {
        ...last,
        date: "2025-03-10",
        open: last.close,
        close: 20,
        high: last.close + 1,
        low: 19,
        volume: last.volume * 2,
      },
      { ...last, date: "2025-03-11", open: 20, close: 20, high: 21, low: 19 },
    ];
    const result = replayDailyStudy(bars, [], {
      strategy,
      start: bars[140]!.date,
      end: bars.at(-1)!.date,
      initial: 1000000,
    });
    expect(result.fills.some((fill) => fill.side === "buy")).toBe(true);
    expect(result.fills.some((fill) => fill.side === "sell")).toBe(true);
    expect(result.fills.every((fill) => fill.date > fill.signalDate)).toBe(
      true,
    );
    expect(
      result.curve.every((point) => point.cash >= 0 && point.shares >= 0),
    ).toBe(true);
  },
);
