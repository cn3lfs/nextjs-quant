import { researchFormulaRuntime } from "~/lib/research/technical/research-formula-runtime";
import { expect, it } from "vitest";
import { researchCanslimFlatPoint } from "trading-strategies/research/canslim/research-canslim-flat";
import type { Bar } from "../../../../src/lib/domain";

import { researchRuleSeries } from "trading-strategies/research/composition/research-rule-series";

const bars = (): Bar[] =>
  Array.from({ length: 70 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 97,
    high: i === 69 ? 103 : 100,
    low: 95,
    close: i === 69 ? 102 : 97,
    volume: i < 49 ? 100 : i < 59 ? 45 : i < 69 ? 35 : 70,
    amount: 1000000,
  }));
it("waits exactly three calendar entries, rejecting low breaches, missing days and future influence", () => {
  const input = bars();
  for (let i = 70; i < 76; i++)
    input.push({
      ...input[69]!,
      date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
      open: 102,
      close: 102,
      high: 103,
      low: 100,
    });
  const calendar = input.map((b) => b.date);
  const run = (series = input) =>
    researchRuleSeries(
      "canslim-flat-hold3",
      series,
      calendar,
      undefined,
      undefined,
      researchFormulaRuntime,
    );
  const points = run();
  expect(points.filter((p) => p.entry).map((p) => p.date)).toEqual([
    input[72]!.date,
  ]);
  expect(run(input.slice(0, 72)).some((p) => p.entry)).toBe(false);
  for (const patch of [{ low: 99.99 }, { volume: 0 }]) {
    const changed = structuredClone(input);
    Object.assign(changed[71]!, patch);
    expect(run(changed).some((p) => p.entry)).toBe(false);
  }
  expect(run(input.filter((_, i) => i !== 71)).some((p) => p.entry)).toBe(
    false,
  );
  const future = structuredClone(input);
  future[74]!.low = 90;
  expect(run(future).slice(0, 74)).toEqual(points.slice(0, 74));
});
it("reuses a prior-only platform and freezes the next-entry ceiling", () => {
  const result = researchCanslimFlatPoint(bars());
  expect(result).toMatchObject({
    entry: true,
    reason: null,
    maxEntryPrice: 105,
  });
  // 23 days still average below 50% of prior volume; 24 days equal 50% and lose a point.
  expect(result.candidate).toMatchObject({ high: 100, length: 23, points: 10 });
  expect(result.candidate!.end).toBe(bars()[68]!.date);
});
it("rejects excessive price and low volume without turning valid absence into missing data", () => {
  for (const patch of [{ close: 106, high: 107 }, { volume: 1 }]) {
    const input = bars();
    Object.assign(input[69]!, patch);
    expect(researchCanslimFlatPoint(input)).toMatchObject({
      entry: false,
      reason: null,
      maxEntryPrice: null,
    });
  }
  const invalid = bars();
  invalid[68]!.volume = 0;
  expect(researchCanslimFlatPoint(invalid).reason).not.toBeNull();
  expect(researchCanslimFlatPoint(bars().slice(0, 20)).reason).not.toBeNull();
});
it("does not revise earlier decisions when later bars change", () => {
  const input = bars();
  const before = input.map((_, i) =>
    researchCanslimFlatPoint(input.slice(0, i + 1)),
  );
  const extended = [
    ...input,
    {
      ...input.at(-1)!,
      date: "2024-03-11",
      close: 60,
      open: 60,
      high: 61,
      low: 59,
    },
  ];
  expect(
    extended
      .slice(0, input.length)
      .map((_, i) => researchCanslimFlatPoint(extended.slice(0, i + 1))),
  ).toEqual(before);
  expect(researchCanslimFlatPoint(extended).entry).toBe(false);
});
