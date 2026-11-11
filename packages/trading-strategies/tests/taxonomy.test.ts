import { expect, it } from "vitest";
import {
  strategyCategories,
  strategyCategoryForFamily,
  strategyMethodClassification,
  unifiedStrategyCatalog,
} from "../src/index.js";

it("assigns every executable and research definition to exactly one maintained category", () => {
  const ids = strategyCategories.map((category) => category.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const definition of unifiedStrategyCatalog) {
    expect(ids).toContain(definition.category);
    expect(definition.category).toBe(
      strategyCategoryForFamily(definition.family),
    );
  }
  expect(() => strategyCategoryForFamily("uncategorized-new-family")).toThrow(
    "尚未分类",
  );
});
it("separates recorded rules, risk policies, analysis and data tools without changing their readiness", () => {
  expect(strategyMethodClassification(["stop-loss/SKILL.md"])).toEqual({
    category: "allocation",
    kind: "risk-policy",
  });
  expect(
    strategyMethodClassification(["chan-theory/references/01.md"]),
  ).toEqual({ category: "structure", kind: "rule" });
  expect(
    strategyMethodClassification(["fundamental-analyst/SKILL.md"]),
  ).toEqual({ category: "value-quality", kind: "analysis" });
  expect(
    strategyMethodClassification(["hithink-astock-selector/SKILL.md"]),
  ).toEqual({ category: "models-execution", kind: "data-tool" });
  expect(() => strategyMethodClassification([])).toThrow("尚未分类");
});
