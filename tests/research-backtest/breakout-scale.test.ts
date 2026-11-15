import { expect, it } from "vitest";
import {
  analyzeBreakout,
  prepareBreakout,
} from "trading-strategies/research/breakout/breakout";
import { analyzeBreakout as reference } from "../helpers/breakout-reference";
import valid from "../fixtures/breakout-valid.json";

it("reuses full-history indicators without changing any prefix point or admitting invalid future data", () => {
  const bars = valid.bars;
  const prepared = prepareBreakout(bars);
  for (let index = Math.max(0, bars.length - 70); index < bars.length; index++)
    expect(prepared.point(index)).toEqual(
      reference(bars.slice(0, index + 1)).latest,
    );
  expect(analyzeBreakout(bars, bars.length - 70)).toEqual(
    reference(bars, bars.length - 70),
  );
  const bad = { ...bars.at(-1)!, date: "2099-01-01", volume: -1 };
  const extended = prepareBreakout([...bars, bad]);
  expect(extended.point(bars.length - 1)).toEqual(
    prepared.point(bars.length - 1),
  );
  expect(extended.point(bars.length).missing).toContain(
    "日线价格/成交量/日期无效或未升序",
  );
  expect(() => prepared.point(-1)).toThrow("index");
  expect(() => prepared.point(bars.length)).toThrow("index");
});
