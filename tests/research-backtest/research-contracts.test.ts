import { chanC4Ids } from "trading-strategies/research/chan/research-chan-movements";
import { chanNativeIds } from "trading-strategies/research/chan/research-chan-native";
import { describe, expect, it } from "vitest";
import { researchStrategyIds } from "../../src/lib/research/specs/research-strategies";
import { isResearchRule } from "trading-strategies/research/composition/research-rule-series";
import {
  findResearchCompositePreset,
  researchCompositePresetIds,
} from "../../src/lib/research/specs/research-composite-presets";
import {
  sellQuantity as researchSellQuantity,
  type ExecutionRules as ResearchExecutionRules,
} from "quant-backtest/execution";
import {
  researchPositionBook,
  researchBookBuy,
  researchBookSell,
  researchBookSellable,
} from "../../src/lib/research/analysis/research-position-book";

const structuralIds = [...chanNativeIds, ...chanC4Ids, "ma-cross", "czsc"];
const rules: ResearchExecutionRules = {
  evidence: "synthetic-contract",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
  tradable: true,
  limitUp: null,
  limitDown: null,
};
const days = ["2023-01-01", "2023-01-02", "2023-01-03"];

it("keeps calculation IDs unique and distinguishes pure rules from structural methods", () => {
  expect(new Set(researchStrategyIds).size).toBe(researchStrategyIds.length);
  for (const id of researchStrategyIds)
    expect(
      isResearchRule(id) ||
        ["dual-breakout", "dual-breakout-structure", ...structuralIds].includes(
          id,
        ),
      id,
    ).toBe(true);
});
it("keeps old lots sellable while rejecting same-day added shares", () => {
  let book = researchBookBuy(researchPositionBook(), {
    date: days[0]!,
    quantity: 500,
    price: 10,
    commission: 5,
  });
  book = researchBookBuy(book, {
    date: days[1]!,
    quantity: 300,
    price: 11,
    commission: 5,
  });
  expect(researchBookSellable(book, days[1]!)).toBe(500);
  expect(() =>
    researchBookSell(book, {
      date: days[1]!,
      quantity: 501,
      price: 12,
      commission: 5,
      tax: 0,
    }),
  ).toThrow("可卖");
  const sold = researchBookSell(book, {
    date: days[1]!,
    quantity: 500,
    price: 12,
    commission: 5,
    tax: 0,
  }).book;
  expect(researchBookSellable(sold, days[1]!)).toBe(0);
  expect(researchBookSellable(sold, days[2]!)).toBe(300);
});
it("enforces sell minima, steps, maximum and complete odd-lot remainder", () => {
  expect(researchSellQuantity(299, 1000, rules)).toBe(200);
  expect(researchSellQuantity(99, 1000, rules)).toBe(0);
  expect(researchSellQuantity(1000, 1000, { ...rules, maximumSell: 300 })).toBe(
    300,
  );
  expect(researchSellQuantity(37, 37, rules)).toBe(37);
  expect(researchSellQuantity(37, 37, { ...rules, sellOddLotAll: false })).toBe(
    0,
  );
  expect(
    researchSellQuantity(100, 100, { ...rules, sellStep: undefined }),
  ).toBeNull();
});

describe.each(researchCompositePresetIds)(
  "registered composite preset: %s",
  (presetId) => {
    const preset = findResearchCompositePreset(presetId)!;

    it("declares itself in the composite preset registry", () => {
      expect(preset.id).toBe(presetId);
      expect(preset.component).toContain(preset.methodId);
    });
  },
);
