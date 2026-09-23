import { expect, it } from "vitest";
import { access } from "node:fs/promises";
import map from "../../docs/trading-skills-method-map.json";
import locked from "../../docs/trading-skills-source-lock.json";
import {
  auditTradingMethodMap,
  tradingMethodMapSchema,
} from "../../scripts/lib/trading-method-map";
import type { SkillInventory } from "../../scripts/lib/trading-skill-inventory";

const inventory: SkillInventory = {
  version: "trading-skill-inventory-1",
  skills: [
    {
      id: "sample",
      sources: [{ path: "SKILL.md", hash: "fixture", bytes: 1, headings: [] }],
      excluded: [],
    },
  ],
  missing: [],
  otherSkills: [],
};
const method = {
  id: "RK-test",
  title: "fixture",
  batch: "K2a",
  sources: ["sample/SKILL.md"],
  review: "reviewed" as const,
  status: "implemented" as const,
  implementation: ["src/strategy.ts"],
  tests: ["tests/strategy.test.ts"],
  boundary: "fixture only",
  delivery: {
    implementation: { status: "complete" as const, note: "fixture" },
    data: { status: "unknown" as const, note: "fixture" },
    realBacktest: {
      status: "pending" as const,
      resultRecords: [],
      note: "fixture",
    },
    effect: { status: "pending" as const, note: "fixture" },
  },
};
const fixture = {
  version: "trading-method-map-1" as const,
  methods: [method],
  dispositions: [],
};
const files = new Set([...method.implementation, ...method.tests]);

it("reports batch progress from batch membership rather than CA/SE name prefixes", () => {
  const report = auditTradingMethodMap(
    {
      ...fixture,
      methods: [
        { ...method, id: "WY-K-quality", batch: "K4", status: "planned" },
        {
          ...method,
          id: "CA-B-N2",
          batch: "K4",
          status: "implemented-variant",
        },
        { ...method, id: "SE01", batch: "K3", status: "planned" },
        { ...method, id: "CA-outside", batch: "K2a", status: "planned" },
      ],
    },
    inventory,
    files,
  );
  expect(report.deliveryBatches.B1).toEqual({
    planned: 2,
    variants: 1,
    implemented: 0,
    pendingIds: ["WY-K-quality", "SE01"],
  });
  expect(report.batches.K4).toEqual({
    planned: 1,
    variants: 1,
    implemented: 0,
    pendingIds: ["WY-K-quality"],
  });
});

it("does not confuse method mappings with whole-source review", () => {
  const mapped = auditTradingMethodMap(fixture, inventory, files);
  expect(mapped.errors).toEqual([]);
  expect(mapped.pendingMethods).toEqual([]);
  expect(mapped.undisposedSources).toEqual(["sample/SKILL.md"]);
  const disposed = auditTradingMethodMap(
    {
      ...fixture,
      dispositions: [
        {
          source: "sample/SKILL.md",
          kind: "methods",
          methodIds: [method.id],
          reason: "whole file reviewed",
        },
      ],
    },
    inventory,
    files,
  );
  expect(disposed.undisposedSources).toEqual([]);
  expect(disposed.errors).toEqual([]);
  const hidden = auditTradingMethodMap(
    {
      ...fixture,
      dispositions: [
        {
          source: "sample/SKILL.md",
          kind: "non-trading",
          methodIds: [],
          reason: "incorrect blanket exclusion",
        },
      ],
    },
    inventory,
    files,
  );
  expect(hidden.errors.some((error) => error.includes("遗漏已复核方法"))).toBe(
    true,
  );
});

it("rejects duplicate IDs, missing code and fabricated source references or completion", () => {
  const invalid = {
    ...fixture,
    methods: [
      method,
      {
        ...method,
        sources: ["sample/missing.md"],
        review: "pending",
        tests: [],
      },
    ],
  };
  const report = auditTradingMethodMap(invalid, inventory, new Set());
  expect(report.errors.some((error) => error.includes("重复方法ID"))).toBe(
    true,
  );
  expect(report.errors.some((error) => error.includes("来源未锁定"))).toBe(
    true,
  );
  expect(report.errors.some((error) => error.includes("仓库引用不存在"))).toBe(
    true,
  );
  expect(report.errors.some((error) => error.includes("实现声明缺少"))).toBe(
    true,
  );
  expect(() =>
    tradingMethodMapSchema.parse({
      ...fixture,
      methods: [{ ...method, implementation: ["../outside.ts"] }],
    }),
  ).toThrow();
});

it("keeps engineering variants pending and rejects source dispositions unrelated to reviewed methods", () => {
  const report = auditTradingMethodMap(
    {
      ...fixture,
      methods: [{ ...method, status: "implemented-variant" }],
      dispositions: [
        {
          source: "sample/SKILL.md",
          kind: "methods",
          methodIds: ["missing"],
          reason: "bad reference",
        },
      ],
    },
    inventory,
    files,
  );
  expect(report.pendingMethods).toContain(method.id);
  expect(report.errors.some((error) => error.includes("处置引用未复核"))).toBe(
    true,
  );
});

it("the repository catalogue resolves locked sources and existing implementation/test references", async () => {
  const parsed = tradingMethodMapSchema.parse(map);
  const existing = new Set<string>();
  for (const file of new Set(
    parsed.methods.flatMap((row) => [...row.implementation, ...row.tests]),
  )) {
    await access(file);
    existing.add(file);
  }
  const report = auditTradingMethodMap(
    parsed,
    locked as SkillInventory,
    existing,
  );
  expect(report.errors).toEqual([]);
  // A populated plan is deliberately not a completion certificate.
  expect(report.pendingMethods.length).toBeGreaterThan(0);
  expect(report.undisposedSources.length).toBeGreaterThan(0);
});
