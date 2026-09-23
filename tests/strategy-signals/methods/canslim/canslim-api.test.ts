import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({ gather: vi.fn(), analyze: vi.fn() }));
vi.mock("../../../../src/server/strategies/canslim/canslim-dossier", () => ({
  gatherCanslimDossier: mocks.gather,
}));
vi.mock("../../../../src/server/strategies/canslim/canslim-report", () => ({
  analyzeCanslimDossier: mocks.analyze,
}));
import { createCaller } from "../../../../src/server/api/root";
import { put, get, sqlite } from "../../../../src/server/db/index";
import type { Job, Snapshot } from "../../../../src/lib/domain";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-canslim-api-"));
const caller = createCaller({ headers: new Headers() });
const source: Snapshot = {
  id: "api-stock",
  hash: "snapshot-hash",
  symbol: "sh600519",
  period: "day",
  source: "fixture",
  adjustment: "none",
  createdAt: 1,
  bars: [],
};
beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
  mocks.gather.mockReset();
  mocks.analyze.mockReset();
  put("snapshot", source.id, source);
  put("settings", "settings", { llmProvider: "codex" });
});
it("returns lightweight task state without input or full result", async () => {
  put("job", "summary-fixture", {
    id: "summary-fixture",
    type: "screen",
    status: "completed",
    progress: 100,
    updatedAt: 123,
    input: { private: "input" },
    result: { large: "result" },
  });
  const summary = await caller.jobSummary({ id: "summary-fixture" });
  expect(summary).toMatchObject({
    id: "summary-fixture",
    status: "completed",
    progress: 100,
    updatedAt: 123,
  });
  expect(summary).not.toHaveProperty("input");
  expect(summary).not.toHaveProperty("result");
  expect(await caller.jobSummary({ id: "absent" })).toBeNull();
});
it("includes only bounded first-page results on explicitly requested completed screens", async () => {
  const result = {
    candidates: Array.from({ length: 120 }, (_, i) => ({
      symbol: `sh${600000 + i}`,
      name: `Fixture ${i}`,
      metrics: {},
      snapshotId: `s${i}`,
    })),
    excluded: [],
    errors: [],
    total: 120,
    snapshots: ["must not leak"],
  };
  for (const status of [
    "queued",
    "running",
    "failed",
    "cancelled",
    "completed",
  ]) {
    put("job", "screen-first", {
      id: "screen-first",
      type: "screen",
      status,
      result,
    });
    const summary = await caller.jobSummary({
      id: "screen-first",
      screenFirstPage: true,
    });
    if (status !== "completed") expect(summary?.screenFirstPage).toBeNull();
    else {
      const page = summary!.screenFirstPage!;
      expect(page.jobId).toBe("screen-first");
      expect(page.candidates).toHaveLength(50);
      expect(page.candidateTotal).toBe(120);
      expect(page).not.toHaveProperty("snapshots");
      expect(page).toEqual(await caller.screenResults({ id: "screen-first" }));
    }
  }
  expect(
    (await caller.jobSummary({ id: "screen-first" }))?.screenFirstPage,
  ).toBeNull();
  put("job", "screen-first", {
    id: "screen-first",
    type: "backtest",
    status: "completed",
    result,
  });
  expect(
    (await caller.jobSummary({ id: "screen-first", screenFirstPage: true }))
      ?.screenFirstPage,
  ).toBeNull();
});
it("merges active submissions and retains the model chosen before data retrieval", async () => {
  let finish!: (value: unknown) => void;
  mocks.gather.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mocks.analyze.mockResolvedValue({ id: "canslim-report-" + "a".repeat(64) });
  const first = await caller.canslimAnalyze({ snapshotId: source.id });
  const duplicate = await caller.canslimAnalyze({ snapshotId: source.id });
  expect(duplicate.id).toBe(first.id);
  put("settings", "settings", { llmProvider: "claude" });
  finish({ id: "dossier" });
  await vi.waitFor(() => expect(get<Job>(first.id)?.status).toBe("completed"));
  expect(mocks.gather).toHaveBeenCalledTimes(1);
  expect(mocks.analyze.mock.calls[0]![2]).toBe("codex:default");
  expect(get<Job>(first.id)?.result).toEqual({
    reportId: "canslim-report-" + "a".repeat(64),
  });
});
it("does not start the model when cancelled during an adapter that returns late", async () => {
  let finish!: (value: unknown) => void;
  mocks.gather.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const job = await caller.canslimAnalyze({ snapshotId: source.id });
  await caller.cancel(job.id);
  finish({ id: "late" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(get<Job>(job.id)?.status).toBe("cancelled");
  expect(mocks.analyze).not.toHaveBeenCalled();
});
it("rejects missing, minute and historical snapshots without data or model calls", async () => {
  await expect(
    caller.canslimAnalyze({ snapshotId: "missing" }),
  ).rejects.toThrow("日线");
  for (const change of [{ period: "5m" }, { historicalAsOf: "2025-01-01" }]) {
    put("snapshot", source.id, { ...source, ...change });
    await expect(
      caller.canslimAnalyze({ snapshotId: source.id }),
    ).rejects.toThrow("日线");
  }
  expect(mocks.gather).not.toHaveBeenCalled();
});
