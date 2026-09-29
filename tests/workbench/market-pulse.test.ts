import { expect, it } from "vitest";
import {
  pulseIndices,
  quoteChange,
} from "../../src/components/overview/market-pulse";

it("quote change is relative to the previous close and unknown without one", () => {
  expect(quoteChange({ price: 3300, preClose: 3000, amount: 0 })).toBeCloseTo(
    10,
    10,
  );
  expect(quoteChange({ price: 10, preClose: 0, amount: 0 })).toBeNull();
  expect(quoteChange({ price: 0, preClose: 10, amount: 0 })).toBeNull();
  expect(quoteChange(undefined)).toBeNull();
});

it("headline indices are unique TDX index symbols", () => {
  const symbols = pulseIndices.map(([symbol]) => symbol);
  expect(new Set(symbols).size).toBe(symbols.length);
  expect(symbols.every((s) => /^(sh000|sz399)\d{3}$/.test(s))).toBe(true);
});
