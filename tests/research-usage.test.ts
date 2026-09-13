import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import * as db from "../src/server/db";
import * as jobs from "../src/server/jobs";
import { settings, saveSettings } from "../src/server/settings";
import {
  researchUsageSchema,
  summarizeResearchUsage,
  type ResearchUsage,
} from "../src/lib/research-usage";
import {
  recordResearchUsage,
  researchUsage,
  usageConfigHash,
  recordedResearchTrials,
} from "../src/server/research-usage";
import {
  walkForwardJob,
  walkForwardInput,
} from "../src/server/walk-forward-job";
import { walkForward } from "../src/server/walk-forward";
import { defaultStrategy, type Snapshot, type Job } from "../src/lib/domain";
import { defaultBacktestCosts } from "../src/lib/backtest-costs";
import { ResearchStore } from "../src/server/research-store";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { ResearchUsagePanel } from "../src/components/research-usage-panel";
import { MultipleTestingPanel } from "../src/components/multiple-testing-panel";

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
it("full KV scan retains earliest entries past the default 200 limit", () => {
  const records = Array.from({ length: 321 }, (_, index) =>
    row({
      id: `usage-${index}`,
      at: index,
      candidateCount: 2,
      configHash: `${index}`,
    }),
  );
  for (const record of records) db.put("research-usage", record.id, record);
  expect(db.list("research-usage")).toHaveLength(200); // Negative control: the default demonstrably truncates.
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
it("usage cannot consume the sample research quota or be deleted with a task", () => {
  db.put("research-usage", "large-usage", { payload: "x".repeat(20000) });
  const store = new ResearchStore(db.sqlite(), 10000);
  const task = store.create(
    researchSpecSchema.parse({
      strategy: "dual-breakout",
      start: "2025-01-01",
      end: "2025-12-31",
      validationStart: "2025-10-01",
    }),
    null,
  );
  store.update(task.id, { status: "failed" });
  store.remove(task.id);
  expect(db.get("large-usage")).toEqual({ payload: "x".repeat(20000) });
});

it("real walk-forward job succeeds on put failure; m never changes DSR or prior metrics", async () => {
  const source: Snapshot = {
    id: "usage-source",
    symbol: "sh600000",
    period: "day",
    source: "fixture",
    adjustment: "none",
    createdAt: 0,
    hash: "fixture",
    bars: Array.from({ length: 240 }, (_, i) => {
      const close = 100 + 10 * Math.sin(i / 9) + i * 0.02;
      return {
        date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
        open: close - 0.2,
        close,
        high: close + 1,
        low: close - 1,
        volume: 100000,
        amount: close * 100000,
      };
    }),
  };
  db.put("snapshot", source.id, source);
  const request = walkForwardInput.parse({
    snapshotId: source.id,
    strategy: { ...defaultStrategy, fast: 4, slow: 12 },
    initial: 100000,
    scope: "window",
    options: { trainBars: 60, testBars: 20 },
  });
  const result = walkForward(
    source,
    request.strategy,
    request.initial,
    defaultBacktestCosts,
    request.options,
  );
  const job: Job = {
    id: "job-usage",
    type: "walk-forward",
    status: "running",
    progress: 0,
    createdAt: 0,
    updatedAt: 0,
    input: request,
  };
  const background = vi.spyOn(jobs, "background").mockReturnValue(job);
  vi.spyOn(jobs, "runWorker").mockImplementation(
    async () => ({ source, result: structuredClone(result) }) as never,
  );
  const originalPut = db.put;
  const put = vi.spyOn(db, "put").mockImplementation((kind, id, value) => {
    if (kind === "research-usage") throw new Error("disk full");
    return originalPut(kind, id, value);
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  walkForwardJob(request);
  const failed = (await background.mock.calls[0]![2](
    job,
    new AbortController().signal,
  )) as typeof result;
  expect(failed.summary).toEqual(result.summary);
  expect(failed.folds).toEqual(result.folds);
  expect(failed.multipleTesting!.selected).toEqual(
    result.multipleTesting!.selected,
  );
  expect(failed.multipleTesting!.recordedTrials!.value).toBeNull();
  expect(warn).toHaveBeenCalledWith("研究使用台账写入失败，本次运行可能未记录");
  put.mockRestore();
  for (let i = 0; i < 5; i++)
    recordResearchUsage(() => ({ ...input(), candidateCount: 20 }));
  walkForwardJob(request);
  const passed = (await background.mock.calls[1]![2](
    job,
    new AbortController().signal,
  )) as typeof result;
  expect(passed.multipleTesting!.recordedTrials!.value).toBe(
    100 + result.candidates.length,
  );
  expect(passed.multipleTesting!.trials).toBe(result.multipleTesting!.trials);
  expect(passed.multipleTesting!.selected).toEqual(
    result.multipleTesting!.selected,
  );
  expect(passed.folds).toEqual(result.folds);
  const html = renderToStaticMarkup(
    createElement(MultipleTestingPanel, { result: passed.multipleTesting }),
  );
  expect(html).toContain("本次运行内部候选数 N（DSR 使用）");
  expect(html).toContain("已记录的试验次数（下界");
  expect(html).toContain("不能直接代入 DSR");
});
it("holdout display carries lower-bound reason and observation-only limitation", () => {
  const page = readFileSync("src/app/research/page.tsx", "utf8");
  expect(page.indexOf("<ResearchUsageContainer />")).toBeGreaterThan(0);
  expect(page.indexOf("<ResearchUsageContainer />")).toBeLessThan(
    page.indexOf("<StrategyResearchControls />"),
  );
  const html = renderToStaticMarkup(
    createElement(ResearchUsagePanel, {
      summary: summarizeResearchUsage([row()], range, range.end),
    }),
  );
  expect(html).toContain("留出集已被 1 次运行覆盖");
  expect(html).toContain("次数不是统计阈值");
  expect(html).toContain("台账建立之前");
});
