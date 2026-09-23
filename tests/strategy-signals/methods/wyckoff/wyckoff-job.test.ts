import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({
  historical: vi.fn(),
  read: vi.fn(),
  calendar: vi.fn(),
  analyze: vi.fn(),
}));
vi.mock("../../../../src/server/data-sources/tdx/tdx", async (original) => ({
  ...(await original<typeof import("../../../../src/server/data-sources/tdx/tdx")>()),
  readTailSnapshot: mocks.read,
  readHistoricalSnapshot: mocks.historical,
}));
vi.mock("../../../../src/server/market/data-health", async (original) => ({
  ...(await original<typeof import("../../../../src/server/market/data-health")>()),
  localCalendarReference: mocks.calendar,
}));
vi.mock("../../../../src/server/strategies/wyckoff/wyckoff-report", () => ({
  analyzeWyckoff: mocks.analyze,
}));
import { wyckoffJob } from "~/server/strategies/wyckoff/wyckoff-job";
import { put, get, sqlite } from "~/server/db";
import { cancelJob } from "~/server/jobs/jobs";
import type { Job } from "~/lib/domain";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-wyckoff-job-"));
beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
  mocks.read.mockReset();
  mocks.historical.mockReset();
  mocks.calendar.mockReset();
  mocks.analyze.mockReset();
  put("snapshot", "day", {
    id: "day",
    symbol: "sh600519",
    period: "day",
    adjustment: "none",
    bars: [],
  });
  put("settings", "settings", { llmProvider: "codex" });
  mocks.calendar.mockResolvedValue({ days: [], source: "fixture", hash: null });
  mocks.analyze.mockResolvedValue({ id: "wyckoff-report-" + "a".repeat(64) });
});
it("reads the requested historical window instead of today's minute tail", async () => {
  put("snapshot", "day", {
    id: "day",
    symbol: "sh600519",
    period: "day",
    adjustment: "none",
    historicalAsOf: "2021-06-30",
    bars: [],
  });
  mocks.historical.mockResolvedValue({
    id: "historical-minute",
    historicalAsOf: "2021-06-30",
  });
  const task = wyckoffJob("day", "历史研究");
  await vi.waitFor(() => expect(get<Job>(task.id)?.status).toBe("completed"));
  expect(mocks.historical).toHaveBeenCalledWith(
    "E:\\new_tdx64",
    "sh600519",
    "5m",
    6000,
    "2021-06-30",
  );
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.analyze.mock.calls[0]![1]).toMatchObject({
    id: "historical-minute",
    historicalAsOf: "2021-06-30",
  });
});
it("merges active requests and captures the model before reading source files", async () => {
  let finish!: (value: unknown) => void;
  mocks.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = wyckoffJob("day", "研究");
  expect(wyckoffJob("day", "研究").id).toBe(first.id);
  put("settings", "settings", { llmProvider: "claude" });
  await vi.waitFor(() => expect(finish).toBeDefined());
  finish({ id: "minute" });
  await vi.waitFor(() => expect(get<Job>(first.id)?.status).toBe("completed"));
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(mocks.analyze.mock.calls[0]![5]).toBe("codex:default");
  expect(get<Job>(first.id)?.result).toMatchObject({
    hourlySourceStatus: "loaded",
  });
});
it("allows explicitly missing minutes but fails corrupted data without invoking the model", async () => {
  mocks.read.mockRejectedValue(
    Object.assign(new Error("missing"), { code: "ENOENT" }),
  );
  const missing = wyckoffJob("day", "缺文件");
  await vi.waitFor(() =>
    expect(get<Job>(missing.id)?.status).toBe("completed"),
  );
  expect(mocks.analyze.mock.calls[0]![1]).toBeNull();
  mocks.analyze.mockClear();
  mocks.read.mockRejectedValue(new Error("记录损坏"));
  const broken = wyckoffJob("day", "坏文件");
  await vi.waitFor(() => expect(get<Job>(broken.id)?.status).toBe("failed"));
  expect(mocks.analyze).not.toHaveBeenCalled();
});
it("stops after cancelled reads return and rejects unsupported snapshots", async () => {
  let finish!: (value: unknown) => void;
  mocks.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const task = wyckoffJob("day", "取消");
  await vi.waitFor(() => expect(finish).toBeDefined());
  cancelJob(task.id);
  finish({ id: "late" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(mocks.analyze).not.toHaveBeenCalled();
  expect(get("late")).toBeUndefined();
  expect(get<Job>(task.id)?.status).toBe("cancelled");
  expect(() => wyckoffJob("absent", "研究")).toThrow();
  put("snapshot", "day", {
    id: "day",
    period: "5m",
    symbol: "sh600519",
    adjustment: "none",
  });
  expect(() => wyckoffJob("day", "研究")).toThrow();
});
