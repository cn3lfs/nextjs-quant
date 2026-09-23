import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock("../../../../src/server/strategies/chan/chan-report", async (original) => ({
  ...(await original<
    typeof import("../../../../src/server/strategies/chan/chan-report")
  >()),
  analyzeChan: mocks.analyze,
}));
import { createCaller } from "../../../../src/server/api/root";
import { put, get, sqlite } from "../../../../src/server/db/index";
import type { Job, Snapshot } from "../../../../src/lib/domain";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-chan-api-"));
const caller = createCaller({ headers: new Headers() });
const source: Snapshot = {
  id: "chan-api-stock",
  hash: "untrusted-source-hash",
  symbol: "sh600519",
  period: "day",
  source: "fixture",
  adjustment: "none",
  createdAt: 1,
  bars: ["2025-01-06", "2025-01-07", "2025-01-08"].map((date) => ({
    date,
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 100,
    amount: 1100,
  })),
};
beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
  mocks.analyze.mockReset();
  put("snapshot", source.id, source);
  put("settings", "settings", { llmProvider: "codex" });
});
it("deduplicates actual windows and freezes the submitted model", async () => {
  const resolvers: ((value: unknown) => void)[] = [];
  mocks.analyze.mockImplementation(
    () => new Promise((resolve) => resolvers.push(resolve)),
  );
  const input = { snapshotId: source.id, question: "核验走势" };
  const first = await caller.chanAnalyze(input);
  expect((await caller.chanAnalyze(input)).id).toBe(first.id);
  // Same supplied hash with changed bars must create a separate task.
  put("snapshot", source.id, {
    ...source,
    bars: source.bars.map((bar) => ({ ...bar, close: 10 })),
  });
  const changed = await caller.chanAnalyze(input);
  expect(changed.id).not.toBe(first.id);
  put("settings", "settings", { llmProvider: "claude" });
  expect(mocks.analyze).toHaveBeenCalledTimes(2);
  expect(
    mocks.analyze.mock.calls.every((call) => call[3] === "codex:default"),
  ).toBe(true);
  resolvers.forEach((resolve) =>
    resolve({ id: "chan-report-" + "a".repeat(64) }),
  );
  await vi.waitFor(() => {
    expect(get<Job>(first.id)?.status).toBe("completed");
    expect(get<Job>(changed.id)?.status).toBe("completed");
  });
  expect(get<Job>(first.id)?.result).toEqual({
    reportId: "chan-report-" + "a".repeat(64),
  });
});
it("keeps cancellation terminal when the model returns late", async () => {
  let finish!: (value: unknown) => void;
  mocks.analyze.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const job = await caller.chanAnalyze({
    snapshotId: source.id,
    question: "核验走势",
  });
  await caller.cancel(job.id);
  expect((mocks.analyze.mock.calls[0]![2] as AbortSignal).aborted).toBe(true);
  finish({ id: "late-report" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(get<Job>(job.id)?.status).toBe("cancelled");
  expect(get<Job>(job.id)?.result).toBeUndefined();
});
it("rejects missing and invalid windows before model execution", async () => {
  await expect(
    caller.chanAnalyze({ snapshotId: "missing", question: "核验" }),
  ).rejects.toThrow("加载");
  put("snapshot", source.id, { ...source, bars: source.bars.slice(0, 2) });
  await expect(
    caller.chanAnalyze({ snapshotId: source.id, question: "核验" }),
  ).rejects.toThrow("三根");
  await expect(
    caller.chanAnalyze({ snapshotId: source.id, question: " " }),
  ).rejects.toThrow();
  expect(mocks.analyze).not.toHaveBeenCalled();
});
