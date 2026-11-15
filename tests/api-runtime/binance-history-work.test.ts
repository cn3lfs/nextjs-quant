import { expect, it, vi, beforeEach } from "vitest";
const state = vi.hoisted(() => ({ cancelled: false }));
vi.mock("../../src/server/infra/settings", () => ({
  settings: () => ({ binancePublicDataRoot: "D:/isolated/binance" }),
}));
vi.mock("../../src/server/db/jobs", () => ({
  readJob: () => ({ status: state.cancelled ? "cancelled" : "running" }),
}));
vi.mock("../../src/server/jobs/jobs", () => ({
  background: vi.fn(() => ({
    id: "job-stub",
    type: "market-data-backfill",
    status: "queued",
    progress: 0,
    createdAt: 1,
    updatedAt: 1,
    input: {},
  })),
  runWorker: vi.fn(async () => ({ complete: true })),
}));
vi.mock("../../src/server/data-sources/binance/public-data-store", () => ({
  publicDataRoot: (root: string) => root,
  publicDataStatus: vi.fn(async (root: string) => ({
    root,
    series: [],
    needsBackfill: true,
  })),
  backfillPublicData: vi.fn(
    async (options: {
      progress?: (done: number, total: number, phase: string) => void;
    }) => {
      options.progress?.(1, 2, "native archive");
    },
  ),
}));
import { startBinanceBackfill } from "../../src/server/jobs/binance-public-data-service";
import { executeBinanceBackfill } from "../../src/server/jobs/binance-public-data-work";
import { background, runWorker } from "../../src/server/jobs/jobs";
import {
  backfillPublicData,
  publicDataStatus,
} from "../../src/server/data-sources/binance/public-data-store";
beforeEach(() => {
  vi.clearAllMocks();
  state.cancelled = false;
});
it("schedules only an explicit deduplicated archive task with the configured root", async () => {
  const job = startBinanceBackfill();
  expect(background).toHaveBeenCalledWith(
    "market-data-backfill",
    {
      source: "binance-public-data",
      root: "D:/isolated/binance",
      includeOneMinute: false,
    },
    expect.any(Function),
    { source: "binance-public-data", root: "D:/isolated/binance" },
  );
  expect(runWorker).not.toHaveBeenCalled();
  await vi
    .mocked(background)
    .mock.calls[0]![2](job, new AbortController().signal);
  expect(runWorker).toHaveBeenCalledWith(
    {
      type: "binance-public-data",
      root: "D:/isolated/binance",
      includeOneMinute: false,
    },
    "job-stub",
  );
});
it("keeps five native intervals by default, explicitly adds1m and reports progress", async () => {
  const progress = vi.fn();
  await executeBinanceBackfill(
    {
      type: "binance-public-data",
      root: "D:/isolated/binance",
      includeOneMinute: false,
    },
    progress,
  );
  expect(backfillPublicData).toHaveBeenCalledWith({
    root: "D:/isolated/binance",
    intervals: undefined,
    progress: expect.any(Function),
  });
  expect(progress).toHaveBeenCalledWith(50, "native archive");
  expect(publicDataStatus).toHaveBeenCalledWith("D:/isolated/binance");
  await executeBinanceBackfill(
    {
      type: "binance-public-data",
      root: "D:/isolated/binance",
      includeOneMinute: true,
    },
    progress,
  );
  expect(backfillPublicData).toHaveBeenLastCalledWith({
    root: "D:/isolated/binance",
    intervals: ["1d", "4h", "1h", "15m", "5m", "1m"],
    progress: expect.any(Function),
  });
});
it("does not publish successful coverage after cancellation", async () => {
  state.cancelled = true;
  await expect(
    executeBinanceBackfill(
      {
        type: "binance-public-data",
        root: "D:/isolated/binance",
        includeOneMinute: false,
        jobId: "job-stub",
      },
      vi.fn(),
    ),
  ).rejects.toThrow("cancelled");
  expect(publicDataStatus).not.toHaveBeenCalled();
});
