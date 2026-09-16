import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  patternConfirmation,
  patternCriteria,
  researchPatternCombinationSeries,
} from "../src/lib/research-pattern-combinations";
import { researchTechnicalSeries } from "../src/lib/research-technical";

const facts = {
  bullish: true,
  bearish: false,
  volume: 1500,
  averageVolume: 1000,
  close: 102,
  ma5: 100,
  dif: 2,
  dea: 1,
  rsi6: 51,
};
it("requires volume and all directional confirmations, with exact inclusive volume boundary", () => {
  expect(patternConfirmation(facts)).toEqual({ entry: true, exit: false });
  for (const change of [
    { volume: 1499 },
    { close: 100 },
    { dif: 1 },
    { rsi6: 50 },
    { ma5: null },
    { bullish: false },
  ])
    expect(patternConfirmation({ ...facts, ...change }).entry).toBe(false);
  expect(
    patternConfirmation({ ...facts, bearish: true, volume: 1, dif: null }),
  ).toEqual({ entry: false, exit: true });
});
it("keeps each source-named geometry and duration explicitly in the criterion table", () => {
  expect(patternCriteria.filter((p) => p.method === "SW04")).toHaveLength(10);
  expect(patternCriteria.filter((p) => p.method === "SW05")).toHaveLength(12);
  expect(new Set(patternCriteria.map((p) => p.id)).size).toBe(22);
  expect(
    patternCriteria.every(
      (p) => p.criterion.includes("工程") && p.criterion.length > 50,
    ),
  ).toBe(true);
});
const bars = (): Bar[] =>
  Array.from({ length: 80 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    close: 100,
    high: 101,
    low: 99,
    volume: 1000,
    amount: 100000,
  }));
it("combines actual reversal geometry and does not take the bearish preset's baseline MA entry", () => {
  const input = bars();
  for (let i = 70; i < 75; i++)
    Object.assign(input[i]!, {
      open: 90 + i - 70,
      close: 91 + i - 70,
      high: 92 + i - 70,
      low: 89 + i - 70,
    });
  Object.assign(input[75]!, { open: 100, close: 101, high: 104, low: 99.9 });
  const point = researchPatternCombinationSeries(
    "sw-reversal-confirmed",
    input,
  )[75]!;
  expect(point.exit).toBe(true);
  expect(point.pattern.bearish).toContain("candle-shooting-star-exit");
  expect(point.pattern.bearish.every((id) => id.endsWith("-exit"))).toBe(true);
  expect(point.entry).toBe(false);
  expect(researchTechnicalSeries("sw-reversal-confirmed", input)[75]).toEqual(
    point,
  );
});
it("confirms a real three-methods continuation and freezes its structural stop", () => {
  const input = bars();
  const put = (i: number, o: number, c: number, h: number, l: number) =>
    Object.assign(input[i]!, { open: o, close: c, high: h, low: l });
  put(68, 96, 97, 98, 95);
  put(69, 97, 98, 99, 96);
  put(70, 98, 99, 100, 97);
  put(71, 100, 108, 109, 99);
  for (let i = 72; i <= 74; i++)
    put(i, 107 - (i - 72), 106.5 - (i - 72), 108 - (i - 72), 106 - (i - 72));
  put(75, 106, 112, 113, 105);
  input[75]!.volume = 1500;
  const point = researchPatternCombinationSeries(
    "sw-continuation-confirmed",
    input,
  )[75]!;
  expect(point.pattern.bullish).toContain("three-rising-5");
  expect(point.entry).toBe(true);
  expect(point.ruleStop).toMatchObject({ price: 105, days: 3 });
  input[75]!.volume = 1499;
  expect(
    researchPatternCombinationSeries("sw-continuation-confirmed", input)[75]!
      .entry,
  ).toBe(false);
});
