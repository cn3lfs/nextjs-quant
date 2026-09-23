import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  listStrategyRepresentatives,
  type StrategyRepresentative,
} from "../../packages/trading-strategies/src/index";

type Method = {
  id: string;
  implementation: string[];
  bindings?: { presets?: string[] };
};
const methods = (
  JSON.parse(readFileSync("docs/trading-skills-method-map.json", "utf8")) as {
    methods: Method[];
  }
).methods;
function problems(
  item: Pick<StrategyRepresentative, "methodId" | "presetId">,
  source: readonly Method[],
) {
  const method = source.find((method) => method.id === item.methodId);
  if (!method) return ["missing-method"];
  return [
    ...(item.presetId && !method.bindings?.presets?.includes(item.presetId)
      ? ["wrong-preset"]
      : []),
    ...(!method.implementation.length ||
    method.implementation.some((path) => !existsSync(path))
      ? ["missing-implementation"]
      : []),
  ];
}
describe("representative method bindings", () => {
  it("resolves all nine methods, preset ownership and implementation paths", () => {
    for (const item of listStrategyRepresentatives())
      expect(problems(item, methods), item.id).toEqual([]);
  });
  it("rejects missing methods and another method's preset", () => {
    expect(problems({ methodId: "missing" }, methods)).toEqual([
      "missing-method",
    ]);
    expect(
      problems({ methodId: "FA08", presetId: "sw-double-prior20" }, methods),
    ).toEqual(["wrong-preset"]);
  });
  it("keeps method-only representatives without fabricated presets", () => {
    const items = listStrategyRepresentatives().filter(
      (item) => !item.presetId,
    );
    expect(items.map((item) => item.methodId)).toEqual([
      "FA08",
      "MS04",
      "IC04",
    ]);
    for (const item of items) expect(problems(item, methods)).toEqual([]);
  });
  it("rejects missing implementation paths", () => {
    expect(
      problems({ methodId: "FA08" }, [
        { id: "FA08", implementation: ["src/server/does-not-exist.ts"] },
      ]),
    ).toEqual(["missing-implementation"]);
  });
});
