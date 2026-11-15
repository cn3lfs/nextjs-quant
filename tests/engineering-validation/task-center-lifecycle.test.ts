import { expect, it } from "vitest";
import { put, get } from "../../src/server/db";
import { taskHistory, taskState } from "../../src/server/db/task-history";
import { taskOverview } from "../../src/server/db/task-overview";
import { cancelJob, updateJob } from "../../src/server/jobs/jobs";
import { jobSummaries } from "../../src/server/db/job-summaries";
import {
  taskAge,
  taskStamp,
} from "../../src/lib/research/workflow/task-history";
import type { Job } from "../../src/lib/domain";
const now = Date.parse("2026-09-28T00:00:01+08:00");
function seed(id: string, status: Job["status"], extra: Partial<Job> = {}) {
  return put("job", id, {
    id,
    type: "screen",
    status,
    progress: 40,
    createdAt: now,
    updatedAt: now,
    input: {},
    ...extra,
  } as Job);
}
it("counts all jobs, not the recent 80, and uses Beijing day boundaries", () => {
  seed("old-active", "running", { createdAt: 1, updatedAt: 1 });
  for (let i = 0; i < 90; i++) seed(`new-${i}`, "completed");
  seed("yesterday", "completed", { updatedAt: now - 2000 });
  seed("future", "completed", { updatedAt: now + 86400000 });
  seed("waiting", "queued");
  seed("failure", "failed");
  seed("cancelled", "cancelled");
  expect(jobSummaries().some((job) => job.id === "old-active")).toBe(false);
  expect(taskOverview(now)).toMatchObject({
    running: 1,
    queued: 1,
    failed: 1,
    cancelled: 1,
    completedToday: 90,
    total: 96,
    latestCompletedScan: null,
  });
  expect(taskAge(now - 2000, now)).toBe("昨天");
  expect(taskAge(now + 86400000, now)).toBe("未来日期");
  expect(taskStamp(now)).toContain("2026/9/28");
});
it("finds the latest completed scan outside the recent window, with stable identity and no payload", () => {
  seed("scan-old", "completed", { type: "scan", updatedAt: 100 });
  seed("scan-a", "completed", {
    type: "scan",
    updatedAt: 200,
    input: { secret: "never-return" },
    result: { rows: "x".repeat(100000) },
  });
  seed("scan-b", "completed", { type: "scan", updatedAt: 200 });
  seed("scan-running", "running", { type: "scan", updatedAt: 300 });
  seed("scan-failed", "failed", { type: "scan", updatedAt: 400 });
  for (let i = 0; i < 100; i++) seed(`later-${i}`, "completed");
  expect(jobSummaries().some((job) => job.type === "scan")).toBe(false);
  expect(taskOverview(now)).toMatchObject({
    latestCompletedScan: { id: "scan-b", updatedAt: 200 },
  });
  expect(JSON.stringify(taskOverview(now))).not.toContain("never-return");
  seed("scan-a", "completed", { type: "scan", updatedAt: 500 });
  expect(taskOverview(now)).toMatchObject({
    latestCompletedScan: { id: "scan-a", updatedAt: 500 },
  });
});
it("combines type/status/exact-id filters without leaking input or result", () => {
  seed("typed", "failed", {
    type: "research",
    input: { kind: "news-analysis", token: "private" },
    result: { large: "x".repeat(100000) },
  });
  expect(
    taskHistory({ type: "research", status: "failed", id: "typed" }),
  ).toMatchObject({ total: 1, items: [{ id: "typed" }], nextCursor: null });
  expect(taskHistory({ type: "screen", id: "typed" }).total).toBe(0);
  expect(taskHistory({ id: "type" }).total).toBe(0);
  const detail = taskState("typed")!;
  expect(detail.sourceLink?.href).toBe("/intel");
  for (const key of [
    "input",
    "result",
    "inputType",
    "inputKind",
    "inputMethod",
  ])
    expect(detail).not.toHaveProperty(key);
  expect(JSON.stringify(detail)).not.toContain("private");
  seed("unknown", "failed", {
    type: "research",
    input: { kind: "unsupported" },
  });
  expect(taskState("unknown")?.sourceLink).toBeUndefined();
});
it("returns cancellation outcomes and never overwrites a terminal state", () => {
  expect(cancelJob("missing").outcome).toBe("not-found");
  seed("queued-cancel", "queued");
  expect(cancelJob("queued-cancel")).toMatchObject({
    ok: true,
    outcome: "accepted",
    status: "cancelled",
  });
  expect(cancelJob("queued-cancel").outcome).toBe("already-cancelled");
  updateJob("queued-cancel", { status: "completed", result: "late" });
  expect(get<Job>("queued-cancel")?.result).toBeUndefined();
  seed("completed-first", "running");
  updateJob("completed-first", { status: "completed", result: "actual" });
  expect(cancelJob("completed-first")).toMatchObject({
    outcome: "already-terminal",
    status: "completed",
  });
  expect(get<Job>("completed-first")?.result).toBe("actual");
  seed("running-cancel", "running");
  expect(cancelJob("running-cancel").outcome).toBe("accepted");
  seed("failed-first", "failed");
  expect(cancelJob("failed-first").outcome).toBe("already-terminal");
});
it("tracks old task revisions and keeps list summaries bounded", () => {
  seed("revision-active", "running");
  const before = taskOverview(now);
  updateJob("revision-active", { phase: "new phase" });
  expect(taskOverview(now).revision).toBeGreaterThan(before.revision);
  const page = taskHistory({});
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(20000);
  expect(
    page.items.every((job) => !("result" in job) && !("input" in job)),
  ).toBe(true);
});
