import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { factorStrategyPresets, factorStrategySchema } from "trading-strategies";
import { FactorStrategyEditor } from "~/components/backtest/factor-strategy-editor";
import {
  draftFromInput,
  draftMatchesInput,
  parseMaDraft,
} from "~/lib/backtest/ma-workspace";
import { strategyExperimentInputSchema } from "~/lib/backtest/strategy-experiment";

it("persists and restores the complete strategy and detects an edited factor parameter", () => {
  const input = strategyExperimentInputSchema.parse({
    symbol: "sh600519",
    start: "2026-10-12",
    end: "2026-10-12",
    strategy: factorStrategyPresets[0],
  });
  const draft = draftFromInput(input);
  expect(parseMaDraft(draft).input).toEqual(input);
  expect(draftMatchesInput(draft, input)).toBe(true);
  const edited = structuredClone(draft);
  edited.strategy!.entry.conditions[0]!.left.parameters = { period: 10 };
  expect(draftMatchesInput(edited, input)).toBe(false);
  edited.strategy!.entry.conditions[0]!.left.parameters = { period: -1 };
  expect(parseMaDraft(edited).input).toBeNull();
});
it("shows editable conditions and public formula provenance without requiring a data source", () => {
  const strategy = factorStrategySchema.parse(factorStrategyPresets[0]);
  strategy.entry.conditions[0]!.left = {
    id: "qlib-MA",
    parameters: { period: 20 },
  };
  const html = renderToStaticMarkup(
    createElement(FactorStrategyEditor, {
      value: strategy,
      onChange: () => {},
      disabled: false,
    }),
  );
  expect(html).toContain("94 个因子");
  expect(html).toContain("入场");
  expect(html).toContain("退出");
  expect(html).toContain("Microsoft Qlib Alpha158");
  expect(html).toContain("原始日频");
  expect(html).toContain("da920b7f954f48ab1bb64117c976710de198373e");
  expect(html).toContain("entry1左侧period");
  expect(html).toContain("添加条件");
});
