import { researchFormulaRuntime } from "~/lib/research/technical/research-formula-runtime";
import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import { researchRuleSeries } from "trading-strategies/research/composition/research-rule-series";
function setup() {
  const bars: Bar[] = Array.from({ length: 80 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: i >= 70 ? 102 : 97,
    high: i >= 69 ? 103 : 100,
    low: i >= 70 ? 101 : 95,
    close: i >= 69 ? 102 : 97,
    volume: i < 49 ? 100 : i < 59 ? 45 : i < 69 ? 35 : 70,
    amount: 1000000,
  }));
  const calendar = bars.map((b) => b.date);
  return { bars, calendar };
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
    const { bars, calendar } = setup();
    const average =
      bars.slice(50, 70).reduce((sum, b) => sum + b.volume, 0) / 20;
    const threshold = strategy.endsWith("ma20")
      ? average * 1.5
      : bars[69]!.volume;
    drop(bars, 70, 102 * 0.96, threshold + 1);
    expect(
      researchRuleSeries(
        strategy,
        bars,
        calendar,
        undefined,
        undefined,
        researchFormulaRuntime,
      )[70]!.exit,
    ).toBe(false);
    bars[70]!.close -= 0.001;
    bars[70]!.volume = threshold;
    expect(
      researchRuleSeries(
        strategy,
        bars,
        calendar,
        undefined,
        undefined,
        researchFormulaRuntime,
      )[70]!.exit,
    ).toBe(strategy.endsWith("ma20"));
    bars[70]!.volume = threshold + 0.001;
    const points = researchRuleSeries(
      strategy,
      bars,
      calendar,
      undefined,
      undefined,
      researchFormulaRuntime,
    );
    expect(points[70]).toMatchObject({
      exit: true,
      bearExit: {
        previousClose: 102,
        referenceVolume: strategy.endsWith("ma20") ? average : 70,
        triggered: true,
      },
    });
    expect(
      researchRuleSeries(
        strategy,
        bars.slice(0, 71),
        calendar,
        undefined,
        undefined,
        researchFormulaRuntime,
      ),
    ).toEqual(points.slice(0, 71));
    bars[70]!.volume = threshold - 0.001;
    expect(
      researchRuleSeries(
        strategy,
        bars,
        calendar,
        undefined,
        undefined,
        researchFormulaRuntime,
      )[70]!.exit,
    ).toBe(false);
  }
});

it("does not require a bearish candle body or a pivot breach", () => {
  const { bars, calendar } = setup();
  drop(bars, 70, 97, 100);
  bars[70]!.open = 96;
  bars[70]!.low = 95;
  expect(
    researchRuleSeries(
      ids[0],
      bars,
      calendar,
      undefined,
      undefined,
      researchFormulaRuntime,
    )[70]!.exit,
  ).toBe(true);
  // The trigger compares consecutive closes, not the intraday candle color.
  bars[70]!.close = 102;
  bars[70]!.low = 90;
  expect(
    researchRuleSeries(
      ids[0],
      bars,
      calendar,
      undefined,
      undefined,
      researchFormulaRuntime,
    )[70]!.exit,
  ).toBe(false);
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
  expect(
    researchRuleSeries(
      ids[0],
      bars,
      calendar,
      undefined,
      undefined,
      researchFormulaRuntime,
    )[71],
  ).toMatchObject({
    entry: false,
    exit: true,
  });
});

it("rejects gaps, invalid prices/volumes and incomplete prior-twenty windows", () => {
  for (const strategy of ids) {
    const { bars, calendar } = setup();
    drop(bars, 70, 97, 100);
    for (const field of ["close", "volume"] as const) {
      const original = bars[70]![field];
      bars[70]![field] = NaN;
      expect(
        researchRuleSeries(
          strategy,
          bars,
          calendar,
          undefined,
          undefined,
          researchFormulaRuntime,
        )[70]!.exit,
      ).toBe(false);
      bars[70]![field] = original;
    }
    const missing = bars.filter((_, i) => i !== 69);
    expect(
      researchRuleSeries(
        strategy,
        missing,
        calendar,
        undefined,
        undefined,
        researchFormulaRuntime,
      ).find((p) => p.date === bars[70]!.date)!.exit,
    ).toBe(false);
    bars[69]!.volume = 0;
    expect(
      researchRuleSeries(
        strategy,
        bars,
        calendar,
        undefined,
        undefined,
        researchFormulaRuntime,
      )[70]!.exit,
    ).toBe(false);
  }
  const { bars, calendar } = setup();
  drop(bars, 70, 97, 100);
  bars[52]!.volume = 0;
  expect(
    researchRuleSeries(
      ids[1],
      bars,
      calendar,
      undefined,
      undefined,
      researchFormulaRuntime,
    )[70]!.exit,
  ).toBe(false);
  expect(
    researchRuleSeries(
      ids[0],
      bars,
      calendar,
      undefined,
      undefined,
      researchFormulaRuntime,
    )[70]!.exit,
  ).toBe(true);
  const missing = bars.filter((_, i) => i !== 52);
  expect(
    researchRuleSeries(
      ids[1],
      missing,
      calendar,
      undefined,
      undefined,
      researchFormulaRuntime,
    ).find((p) => p.date === bars[70]!.date)!.exit,
  ).toBe(false);
});
