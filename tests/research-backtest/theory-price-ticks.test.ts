import { expect, it } from "vitest";
import { parseTheoryPriceTicks } from "~/server/research/theory-price-ticks";
const raw = {
  symbols: ["BTCUSDT", "ETHUSDT"].map((symbol) => ({
    symbol,
    filters: [{ filterType: "PRICE_FILTER", tickSize: "0.01000000" }],
  })),
};
it("keeps public source identity and observation time with both increments", () => {
  const ticks = parseTheoryPriceTicks(raw, "2026-11-17T00:00:00Z");
  expect(ticks.cxBTCUSDT?.tick).toBe(0.01);
  expect(ticks.cxETHUSDT?.responseHash).toBe(ticks.cxBTCUSDT?.responseHash);
  expect(ticks.cxBTCUSDT?.source).toContain("exchangeInfo");
});
it("does not replace missing or invalid PRICE_FILTER with a guessed tick", () => {
  expect(() =>
    parseTheoryPriceTicks(
      { symbols: [{ symbol: "BTCUSDT", filters: [] }] },
      "2026-11-17",
    ),
  ).toThrow();
  expect(() =>
    parseTheoryPriceTicks(
      {
        symbols: raw.symbols.map((r) => ({
          ...r,
          filters: [{ filterType: "PRICE_FILTER", tickSize: "0" }],
        })),
      },
      "2026-11-17",
    ),
  ).toThrow();
});
