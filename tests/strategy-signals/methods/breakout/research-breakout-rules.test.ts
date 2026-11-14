import { legacyBreakoutRuleIds } from "trading-strategies/research/technical/research-breakout-rules";
import { researchRuleSeries } from "trading-strategies/research/composition/research-rule-series";
import { researchFormulaRuntime } from "~/lib/research/technical/research-formula-runtime";
import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import { analyzeBreakout } from "trading-strategies/research/breakout/breakout";
import { breakoutRuleDecision } from "trading-strategies/research/technical/research-breakout-rules";
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
it.each(legacyBreakoutRuleIds)(
  "%s calculates breakout entry, exit and stable prefixes",
  (id) => {
    const bars = fixture(),
      series = researchRuleSeries(
        id,
        bars,
        undefined,
        undefined,
        undefined,
        researchFormulaRuntime,
      );
    expect(series[140]!.entry).toBe(true);
    expect(series[182]!.exit).toBe(true);
    expect(
      researchRuleSeries(
        id,
        bars.slice(0, 141),
        undefined,
        undefined,
        undefined,
        researchFormulaRuntime,
      ),
    ).toEqual(series.slice(0, 141));
  },
);
