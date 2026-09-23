import Database from "better-sqlite3";
import {
  isGrowthDailyExit,
  growthDailyExitTemplate,
} from "../../src/lib/research/factors/research-growth-exits";
import { afterAll, describe, expect, it } from "vitest";
import {
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
import {
  ResearchStrategyFields,
  selectResearchStrategy,
} from "../../src/components/research/research-strategy-fields";
import { SelectItem, SelectTrigger } from "../../src/components/ui/select";
import {
  researchStrategies,
  researchStrategyIds,
} from "../../src/lib/research/specs/research-strategies";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
import { ResearchStore } from "../../src/server/backtest/research-store";
import { migrate } from "../../src/server/db/migrations";

const db = new Database(":memory:");
migrate(db);
const store = new ResearchStore(db);
afterAll(() => db.close());
const base = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: "2024-01-01",
  end: "2024-12-31",
  validationStart: "2024-10-01",
});
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...elements(child.props.children as ReactNode)]
      : [],
  );
}
it("the actual form has exactly the registered IDs and labels in registry order", () => {
  const tree = elements(
    ResearchStrategyFields({ spec: base, onChange: () => {} }),
  );
  const items = tree.filter(
    (e) =>
      e.type === SelectItem &&
      researchStrategyIds.includes(
        e.props.value as (typeof researchStrategyIds)[number],
      ),
  );
  expect(items.map((e) => [e.props.value, e.props.children])).toEqual(
    researchStrategyIds.map((id) => [id, researchStrategies[id].label]),
  );
  const trigger = tree.find(
    (e) => e.type === SelectTrigger && e.props["aria-label"] === "研究策略",
  )!;
  expect(trigger.props.className).toBe("w-full min-w-0 max-w-full");
});
describe.each(researchStrategyIds)("form preset %s", (id) => {
  it("persists its real ID through the production store", () => {
    const selected = researchSpecSchema.parse(selectResearchStrategy(base, id));
    const task = store.create(selected, null);
    expect(store.task(task.id)!.spec.strategy).toBe(id);
    store.update(task.id, { status: "cancelled" });
    store.remove(task.id);
  });
  it("clears incompatible MA/risk parameters on every switch", () => {
    const fromMa = selectResearchStrategy(
      selectResearchStrategy(base, "ma-cross"),
      id,
    );
    expect(fromMa.maParams === undefined).toBe(id !== "ma-cross");
    const fromStructure = selectResearchStrategy(
      selectResearchStrategy(base, "dual-breakout-structure"),
      id,
    );
    expect(fromStructure.risk === undefined).toBe(
      id !== "dual-breakout-structure" && !isGrowthDailyExit(id),
    );
    if (isGrowthDailyExit(id))
      expect(fromStructure.management).toEqual(
        growthDailyExitTemplate(fromStructure).management,
      );
    else expect(fromStructure.management).toBeUndefined();
    expect(researchSpecSchema.parse(fromMa).strategy).toBe(id);
  });
  it("clears breakout-only sizing/add-on and structural stop parameters", () => {
    const source = researchSpecSchema.parse({
      ...base,
      risk: {},
      management: {
        stop: { kind: "structure", buffer: 0 },
        pyramid: {
          kind: "pullback-50-50",
          maxTotalWeight: 1,
          waitBars: 5,
          tolerance: 0.01,
          requireProfit: true,
        },
      },
    });
    const next = selectResearchStrategy(source, id);
    if (id !== "dual-breakout")
      expect(next.management?.pyramid).toBeUndefined();
    if (isGrowthDailyExit(id))
      expect(next.management).toEqual(growthDailyExitTemplate(next).management);
    else if (id !== "dual-breakout" && id !== "dual-breakout-structure")
      expect(next.management!.stop).toEqual({
        kind: "percent",
        fraction: 0.05,
      });
    expect(researchSpecSchema.parse(next).strategy).toBe(id);
  });
});
