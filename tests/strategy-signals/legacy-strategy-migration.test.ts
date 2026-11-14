import { expect, it } from "vitest";
import { researchMaCrossOutputs } from "../../packages/trading-strategies/src/research/technical/research-ma-cross";
import { evaluateFormula } from "trading-strategies/formula/tdx-formula";
import type { Bar } from "trading-strategy-core/bars";

it("preserves fixed MA5/10 formula CROSS semantics through equality, missing bars and future append", () => {
  const bars: Bar[] = Array.from({ length: 100 }, (_, i) => {
    const close = i < 20 ? 10 : 10 + Math.sin(i / 5);
    return {
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: close,
      close,
      high: close + 1,
      low: close - 1,
      volume: 100,
      amount: 1000,
    };
  });
  bars[43]!.close = NaN;
  const formula = "ENTRY:CROSS(MA(C,5),MA(C,10));EXIT:CROSS(MA(C,10),MA(C,5));";
  const expected = evaluateFormula(formula, bars).outputs.map((o) => o.values);
  expect(researchMaCrossOutputs(bars).map((o) => o.values)).toEqual(expected);
  expect(
    researchMaCrossOutputs(bars.slice(0, 70)).map((o) => o.values),
  ).toEqual(expected.map((o) => o.slice(0, 70)));
  expect(expected[0]!.slice(0, 10)).toEqual(Array(10).fill(null));
  expect(expected[0]!.slice(10, 20)).toEqual(Array(10).fill(0));
});
