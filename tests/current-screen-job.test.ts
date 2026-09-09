import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Job } from "../src/lib/domain";
import { settingsSchema, strategySchema } from "../src/lib/domain";
vi.mock("../src/server/jobs", async (original) => ({
  ...(await original<typeof import("../src/server/jobs")>()),
  runWorker: vi.fn(),
}));
vi.mock("../src/server/quick-research", () => ({
  quickResearch: vi.fn(async () => ({ paused: false })),
}));
vi.mock("../src/server/securities", () => ({
  securityDirectory: async () => ({ root: "fixture", entries: {} }),
}));
vi.mock("../src/server/data-health", async (original) => ({
  ...(await original<typeof import("../src/server/data-health")>()),
  localCalendarReference: async () => ({
    days: [new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)],
    source: "fixture",
    hash: null,
  }),
}));
import { screenJob } from "../src/server/runtime";
import { screenTaskProgress } from "../src/server/task-history";
import { runWorker } from "../src/server/jobs";
import { quickResearch } from "../src/server/quick-research";
import { sqlite, put, get, list } from "../src/server/db";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-current-job-"));
beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
  vi.mocked(quickResearch).mockClear();
  put("settings", "settings", settingsSchema.parse({ autoAnalysis: true }));
  vi.mocked(runWorker).mockResolvedValue({
    asOf: "2000-01-01",
    candidates: [{ symbol: "sh600519", snapshotId: "fixture-snapshot" }],
    snapshots: [{ id: "fixture-snapshot", symbol: "sh600519" }],
    errors: [],
    excluded: [],
    total: 1,
  });
});
it("a stale strict screen fails without saving snapshots or creating model jobs", async () => {
  const job = screenJob(strategySchema.parse({}), "day", ["sh600519"], {
    requireCurrent: true,
  });
  await vi.waitFor(() => expect(get<Job>(job.id)?.status).toBe("failed"));
  expect(get<Job>(job.id)?.error).toContain("严格当前模式");
  expect(get<Job>(job.id)?.phase).toBe("核对选股基准日与交易日历");
  expect(get<Job>(job.id)?.workProgress).toEqual({
    stage: "核对选股基准日与交易日历",
    unit: "步骤",
    processed: 1,
    total: 1,
    failed: 1,
    excluded: 0,
  });
  expect(get("fixture-snapshot")).toBeUndefined();
  expect(list<Job>("job").filter((j) => j.type === "research")).toHaveLength(0);
  expect(quickResearch).not.toHaveBeenCalled();
});
it("the same stale data remains usable in explicit local research mode", async () => {
  const job = screenJob(strategySchema.parse({}), "day", ["sh600519"]);
  await vi.waitFor(() => expect(get<Job>(job.id)?.status).toBe("completed"));
  await vi.waitFor(() => expect(quickResearch).toHaveBeenCalledOnce());
  expect(get("fixture-snapshot")).toBeDefined();
  expect(get<Job>(job.id)?.result).toMatchObject({
    researchMode: "latest-local",
  });
});
it("keeps rule completion and counts visible while its linked model task is still running", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(quickResearch).mockImplementationOnce(
    async (_sources, _strategy, _abort, progress) => {
      progress?.(
        0,
        1,
        "模型阶段",
        {
          stage: "模型阶段",
          unit: "批次",
          processed: 0,
          total: 1,
          failed: 0,
          excluded: 0,
        },
        ["completed-batch-report"],
      );
      await gate;
      progress?.(1, 1, "快评汇总", {
        stage: "快评汇总",
        unit: "候选",
        processed: 1,
        total: 1,
        failed: 0,
        excluded: 0,
      });
      return { paused: false, reportIds: [], failures: [], summary: "fixture" };
    },
  );
  const job = screenJob(strategySchema.parse({}), "day", ["sh600519"]);
  try {
    await vi.waitFor(() =>
      expect(screenTaskProgress(job.id)?.rule.status).toBe("completed"),
    );
    const state = screenTaskProgress(job.id)!;
    expect(state.rule.workProgress).toEqual({
      stage: "规则筛选汇总",
      unit: "证券",
      processed: 1,
      total: 1,
      failed: 0,
      excluded: 0,
    });
    expect(state.research?.status).toBe("running");
    expect(get<Job>(state.research!.id)?.result).toEqual({
      reportIds: ["completed-batch-report"],
    });
    expect(state.research?.workProgress?.processed).toBe(0);
    expect(state.rule).not.toHaveProperty("result");
    expect(state.research).not.toHaveProperty("input");
  } finally {
    release();
  }
  await vi.waitFor(() =>
    expect(screenTaskProgress(job.id)?.research?.status).toBe("completed"),
  );
});
it("stops later save batches when stored cancellation precedes the owner's abort signal", async () => {
  const snapshots = Array.from({ length: 120 }, (_, i) => ({
    id: `cancel-snapshot-${i}`,
    symbol: `sh${600000 + i}`,
  }));
  vi.mocked(runWorker).mockResolvedValueOnce({
    asOf: "2000-01-01",
    candidates: snapshots.map((s) => ({ symbol: s.symbol, snapshotId: s.id })),
    snapshots,
    errors: [],
    excluded: [],
    total: 120,
  });
  // A stored cancellation without calling cancelJob reproduces cross-process
  // visibility before the 250ms owner signal watcher has had a chance to run.
  sqlite().exec(`CREATE TRIGGER cancel_screen_after_save AFTER INSERT ON records
    WHEN NEW.kind='snapshot' BEGIN
      UPDATE records SET payload=json_set(payload,'$.status','cancelled')
      WHERE kind='job' AND json_extract(payload,'$.type')='screen';
    END;`);
  const job = screenJob(
    strategySchema.parse({}),
    "day",
    snapshots.map((s) => s.symbol),
  );
  try {
    await vi.waitFor(() => expect(get<Job>(job.id)?.status).toBe("cancelled"));
    // Let all immediate callbacks and the owner's cancellation watcher settle.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(list("snapshot", 200)).toHaveLength(50);
    expect(get("cancel-snapshot-50")).toBeUndefined();
    expect(get<Job>(job.id)?.result).toBeUndefined();
    expect(list<Job>("job").filter((j) => j.type === "research")).toHaveLength(
      0,
    );
    expect(quickResearch).not.toHaveBeenCalled();
  } finally {
    sqlite().exec("DROP TRIGGER cancel_screen_after_save");
  }
});
vi.mock("../src/server/gf-calendar", () => ({
  gfCalendarReference: async () => {
    throw new Error("fixture unavailable");
  },
}));
