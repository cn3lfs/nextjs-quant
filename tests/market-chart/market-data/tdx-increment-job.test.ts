import { expect, it, vi } from "vitest";
import { runIncrementJob } from "../../../src/server/data-sources/tdx/tdx-increment-job";
import { refreshDailyIncrement } from "../../../src/server/data-sources/tdx/tdx-increment-refresh";
import { claimWorkflow } from "../../../src/server/jobs/workflow-lease";

it("persists publication wait and throttles retries without declaring success", async () => {
  const refresh = vi.fn<typeof refreshDailyIncrement>().mockResolvedValue({
    status: "not-published",
    date: "2026-09-11",
    url: "source",
  });
  const first = await runIncrementJob("2026-09-11", ["sh600519"], {
    refresh,
    now: 1000,
  });
  expect(first.status).toBe("waiting-publication");
  expect(first.snapshotIds).toEqual([]);
  expect(
    await runIncrementJob("2026-09-11", ["sh600519"], { refresh, now: 1001 }),
  ).toEqual(first);
  expect(refresh).toHaveBeenCalledTimes(1);
  refresh.mockRejectedValue(new Error("download failed"));
  const failed = await runIncrementJob("2026-09-11", ["sh600519"], {
    refresh,
    now: first.nextAttemptAt,
  });
  expect(failed.status).toBe("failed");
  expect(failed.attempts).toBe(2);
  let latest = failed;
  for (let attempt = 3; attempt <= 8; attempt++)
    latest = await runIncrementJob("2026-09-11", ["sh600519"], {
      refresh,
      now: latest.nextAttemptAt,
    });
  const capped = await runIncrementJob("2026-09-11", ["sh600519"], {
    refresh,
    now: latest.nextAttemptAt,
  });
  expect(capped.attempts).toBe(8);
  expect(refresh).toHaveBeenCalledTimes(8);
  await runIncrementJob("2026-09-11", ["sh600519"], {
    refresh,
    now: latest.nextAttemptAt,
    force: true,
  });
  expect(refresh).toHaveBeenCalledTimes(9);
});
it("refuses concurrent publication under an active lease", async () => {
  const lease = claimWorkflow("tdx-increment-2026-09-10")!;
  try {
    await expect(runIncrementJob("2026-09-10", ["sh600519"])).rejects.toThrow(
      "正在运行",
    );
  } finally {
    lease.release();
  }
});
