import type { Bar } from "../../../../src/lib/domain";
import { researchFormulaRuntime } from "~/lib/research/technical/research-formula-runtime";
import { expect, it } from "vitest";
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

it("uses breakout-relative days 1..3, strict pivot breach, and separate low/close triggers", () => {
  for (const strategy of [
    "canslim-priority-fail3-low",
    "canslim-priority-fail3-close",
  ] as const) {
    for (const day of [1, 2, 3, 4]) {
      const { bars, calendar } = setup();
      const index = 69 + day;
      bars[index]!.low = 99;
      if (strategy.endsWith("close")) bars[index]!.close = 99.5;
      const points = researchRuleSeries(
        strategy,
        bars,
        calendar,
        undefined,
        undefined,
        researchFormulaRuntime,
      );
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
        researchRuleSeries(
          strategy,
          bars.slice(0, index + 1),
          calendar,
          undefined,
          undefined,
          researchFormulaRuntime,
        ),
      ).toEqual(points.slice(0, index + 1));
      bars[index]!.low = 100;
      bars[index]!.close = 100;
      expect(
        researchRuleSeries(
          strategy,
          bars,
          calendar,
          undefined,
          undefined,
          researchFormulaRuntime,
        )[index]!.exit,
      ).toBe(false);
    }
  }
  const { bars } = setup();
  bars[70]!.low = 99;
  expect(
    researchRuleSeries(
      "canslim-priority-fail3-close",
      bars,
      undefined,
      undefined,
      undefined,
      researchFormulaRuntime,
    )[70]!.exit,
  ).toBe(false);
});

it("does not extend the three-day window over missing bars or invent invalid-bar exits", () => {
  const { bars, calendar } = setup();
  bars[73]!.low = 99;
  const missing = bars.filter((_, i) => i !== 70);
  expect(
    researchRuleSeries(
      "canslim-priority-fail3-low",
      missing,
      calendar,
      undefined,
      undefined,
      researchFormulaRuntime,
    ).find((p) => p.date === bars[73]!.date)!.exit,
  ).toBe(false);
  bars[71]!.low = 99;
  bars[71]!.volume = 0;
  expect(
    researchRuleSeries(
      "canslim-priority-fail3-low",
      bars,
      calendar,
      undefined,
      undefined,
      researchFormulaRuntime,
    )[71]!.exit,
  ).toBe(false);
});
