import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as db from "../../src/server/db/index";
import { settings, saveSettings } from "../../src/server/infra/settings";
import {
  researchUsageSchema,
  summarizeResearchUsage,
  type ResearchUsage,
} from "../../src/lib/research/workflow/research-usage";
import {
  recordResearchUsage,
  researchUsage,
  recordedResearchTrials,
} from "../../src/server/research/research-usage";
import { usageConfigHash } from "../../src/server/research/research-config-hash";
import { ResearchUsagePanel } from "../../src/components/research/research-usage-panel";

const range = { start: "2025-02-01", end: "2025-03-01" };
const input = () => ({
  kind: "backtest" as const,
  symbols: ["sh600000"],
  universeSize: 1,
  range,
  candidateCount: 1,
  config: { fast: 5, slow: 20 },
});
const row = (patch: Partial<ResearchUsage> = {}): ResearchUsage => ({
  ...input(),
  id: "one",
  at: 1,
  configHash: "a",
  touchedHoldout: false,
  holdoutStart: null,
  ...patch,
});
beforeEach(() => {
  db.sqlite().prepare("DELETE FROM records WHERE kind='research-usage'").run();
  saveSettings({ ...settings(), holdoutStart: null });
});
afterEach(() => vi.restoreAllMocks());

it("inclusive overlap, containment and disjoint ranges", () => {
  const result = summarizeResearchUsage(
    [
      row({ range: { start: "2025-01-01", end: "2025-02-01" }, at: 4 }),
      row({
        range: { start: "2025-01-01", end: "2025-04-01" },
        at: 2,
        kind: "walk-forward",
        candidateCount: 9,
      }),
      row({ range: { start: "2025-03-02", end: "2025-04-01" } }),
    ],
    range,
  );
  expect(result).toMatchObject({
    runs: 2,
    candidateSum: 10,
    distinctConfigs: 1,
    trialLowerBound: 10,
    firstRunAt: 2,
    lastRunAt: 4,
    byKind: { backtest: 1, "walk-forward": 1 },
  });
  expect(result.reason).toContain("应用外");
  expect(summarizeResearchUsage([], range)).toMatchObject({
    runs: 0,
    trialLowerBound: 0,
    firstRunAt: null,
    lastRunAt: null,
  });
});
it("lower bound uses max of candidate sum and distinct configurations", () => {
  expect(
    summarizeResearchUsage([row({ candidateCount: 9 }), row()], range)
      .trialLowerBound,
  ).toBe(10);
  expect(
    summarizeResearchUsage(
      [row({ candidateCount: 0 }), row({ candidateCount: 0, configHash: "b" })],
      range,
    ).trialLowerBound,
  ).toBe(2);
});
it("batched snapshot retains earliest entries past a bounded recent list", () => {
  const records = Array.from({ length: 321 }, (_, index) =>
    row({
      id: `usage-${index}`,
      at: index,
      candidateCount: 2,
      configHash: `${index}`,
    }),
  );
  for (const record of records) db.put("research-usage", record.id, record);
  expect(db.list("research-usage", 200)).toHaveLength(200); // A recent page cannot stand in for a complete summary.
  expect(researchUsage(range)).toEqual(summarizeResearchUsage(records, range));
  expect(researchUsage(range)).toMatchObject({
    runs: 321,
    trialLowerBound: 642,
    firstRunAt: 0,
    lastRunAt: 320,
  });
});
it("holdout is inclusive, disabled by default, and changing the boundary preserves evidence", () => {
  const first = recordResearchUsage(input)!;
  expect(first).toMatchObject({ touchedHoldout: false, holdoutStart: null });
  saveSettings({ ...settings(), holdoutStart: range.end });
  const second = recordResearchUsage(input)!;
  expect(second).toMatchObject({
    touchedHoldout: true,
    holdoutStart: range.end,
  });
  expect(researchUsage(range).holdout).toMatchObject({
    touches: 2,
    distinctConfigs: 1,
    firstTouchAt: first.at,
  });
  saveSettings({ ...settings(), holdoutStart: "2025-03-02" });
  expect(researchUsage(range).holdout.touches).toBe(0);
  expect(db.get(second.id)).toEqual(second);
  saveSettings({ ...settings(), holdoutStart: null });
  expect(researchUsage(range).holdout).toMatchObject({
    start: null,
    touches: 0,
    firstTouchAt: null,
  });
});
it("same millisecond and config still append, canonical object key ordering is stable", () => {
  vi.spyOn(Date, "now").mockReturnValue(10);
  const first = recordResearchUsage(input)!;
  const second = recordResearchUsage(input)!;
  expect(first.id).not.toBe(second.id);
  expect(first.configHash).toBe(second.configHash);
  expect(researchUsage(range).runs).toBe(2);
  expect(usageConfigHash({ a: 1, b: { d: 2, c: 3 } })).toBe(
    usageConfigHash({ b: { c: 3, d: 2 }, a: 1 }),
  );
  expect(usageConfigHash([1, 2])).not.toBe(usageConfigHash([2, 1]));
});
it("invalid dates and damaged records are unavailable, never a fabricated zero", () => {
  expect(
    researchUsageSchema.safeParse(
      row({ range: { start: "2025-02-30", end: "2025-03-01" } }),
    ).success,
  ).toBe(false);
  const good = recordResearchUsage(input)!;
  db.put("research-usage", "broken", {});
  expect(() => researchUsage(range)).toThrow();
  expect(recordedResearchTrials(range, good)).toMatchObject({ value: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(
    recordResearchUsage(() => {
      throw new Error("input failed");
    }),
  ).toBeNull();
});
it("holdout display carries lower-bound reason and observation-only limitation", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchUsagePanel, {
      summary: summarizeResearchUsage([row()], range, range.end),
    }),
  );
  expect(html).toContain("留出集已被 1 次运行覆盖");
  expect(html).toContain("次数不是统计阈值");
  expect(html).toContain("台账建立之前");
});
