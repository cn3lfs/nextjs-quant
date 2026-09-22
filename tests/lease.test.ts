import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireScheduler } from "~/server/infra/lease";
import { get, put } from "~/server/db";
import { newJob, recoverJobs } from "~/server/jobs/jobs";
import type { Job } from "~/lib/domain";

process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-lease-"));
it("排除其他存活实例，进程退出后接管调度", () => {
  put("lease", "scheduler-owner", {
    owner: "other-instance",
    pid: process.pid,
  });
  expect(acquireScheduler()).toBe(false);
  put("lease", "scheduler-owner", {
    owner: "exited-instance",
    pid: 2147483647,
  });
  expect(acquireScheduler()).toBe(true);
  expect(acquireScheduler()).toBe(true);
});
it("启动恢复保留存活实例任务，仅终止已退出实例任务", () => {
  const live = newJob("scan", {});
  const dead = newJob("scan", {});
  put("job", dead.id, { ...dead, ownerPid: 2147483647 });
  recoverJobs();
  expect(get<Job>(live.id)?.status).toBe("queued");
  expect(get<Job>(dead.id)?.status).toBe("failed");
});
