import {
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
import { expect, it } from "vitest";
import {
  StrategyRepresentativeCatalog,
  representativePreset,
} from "../src/components/strategy-representative-catalog";
import { listStrategyRepresentatives } from "trading-strategies";
import { Button } from "../src/components/ui/button";
import { selectResearchStrategy } from "../src/components/research-strategy-fields";
import { researchSpecSchema } from "../src/lib/strategy-research";
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...elements(child.props.children as ReactNode)]
      : [],
  );
}
it("shows nine representatives and only selects the six registered presets", () => {
  const selected: string[] = [];
  const tree = elements(
    StrategyRepresentativeCatalog({ onSelect: (id) => selected.push(id) }),
  );
  expect(
    tree
      .filter((e) => e.type === "article")
      .map((e) => e.props["data-strategy-representative"]),
  ).toEqual(listStrategyRepresentatives().map((i) => i.id));
  const buttons = tree.filter((e) => e.type === Button);
  expect(buttons).toHaveLength(6);
  expect(selected).toEqual([]);
  for (const button of buttons) {
    expect(button.props.type).toBe("button");
    (button.props.onClick as () => void)();
  }
  expect(selected).toEqual([
    "sw-double-prior20",
    "sw-confluence",
    "vp-up-expanded-confirm",
    "wy-sos-daily",
    "chan-third-native",
    "canslim-high-98",
  ]);
  const base = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: "2025-01-01",
    end: "2025-12-31",
    validationStart: "2025-10-01",
  });
  for (const id of selected)
    expect(
      researchSpecSchema.parse(selectResearchStrategy(base, id)).strategy,
    ).toBe(id);
});
it("never interprets a missing preset or method ID as an executable preset", () => {
  expect(representativePreset({})).toBeUndefined();
  expect(representativePreset({ presetId: "FA08" })).toBeUndefined();
  expect(representativePreset({ presetId: "unknown" })).toBeUndefined();
});
it("keeps missing data, untested methods and incomplete evidence visible", () => {
  const tree = elements(StrategyRepresentativeCatalog({ onSelect: () => {} }));
  const paragraphs = tree
    .filter((e) => e.type === "p")
    .map((e) => Children.toArray(e.props.children as ReactNode).join(""));
  expect(paragraphs.filter((s) => s.includes("未真实回测"))).toHaveLength(4);
  expect(paragraphs.filter((s) => s.includes("批次未完整"))).toHaveLength(2);
  expect(
    paragraphs.filter((s) => s.includes("仅保留原始观察记录")),
  ).toHaveLength(2);
  expect(paragraphs.some((s) => s.includes("缺少所需数据"))).toBe(true);
});
