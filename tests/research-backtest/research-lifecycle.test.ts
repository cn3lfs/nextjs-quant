import { beforeEach, expect, it, vi } from "vitest";
import {
  background,
  cancelJob,
  newJob,
  recoverJobs,
  updateJob,
} from "../../src/server/jobs/jobs";
import { get, sqlite } from "../../src/server/db/index";
import { ResearchAttempts } from "../../src/server/research/research-governance";
import { recordResearchUsage } from "../../src/server/research/research-usage";
import type { Job } from "../../src/lib/domain";

beforeEach(() => sqlite().prepare("DELETE FROM records").run());
it("parent jobs create distinct attempts, catch startup failure and retain cancellation against late results", async () => {
  const attempts = new ResearchAttempts(sqlite());
  const failed = background(
    "backtest",
    { snapshotId: "missing-test-snapshot" },
    async () => {
      throw new Error("worker startup failed");
    },
  );
  expect(attempts.read(failed.attemptId!)?.state).toBe("queued");
  await vi.waitFor(() => expect(get<Job>(failed.id)?.status).toBe("failed"));
  expect(attempts.read(failed.attemptId!)?.error).toBe("worker startup failed");
  const cancelled = background("walk-forward", {}, async () => ({
    late: true,
  }));
  cancelJob(cancelled.id);
  await Promise.resolve();
  updateJob(cancelled.id, { status: "completed" });
  expect(attempts.read(cancelled.attemptId!)?.state).toBe("cancelled");
  const retry = background("walk-forward", {}, async () => ({ done: true }));
  await vi.waitFor(() => expect(get<Job>(retry.id)?.status).toBe("completed"));
  expect(attempts.read(retry.attemptId!)?.state).toBe("succeeded");
  expect(retry.attemptId).not.toBe(cancelled.attemptId);
  const formula = newJob("screen", {
    type: "formula-screen",
    formula: { source: "C>O" },
  });
  expect(attempts.read(formula.attemptId!)?.kind).toBe("formula-screen");
  cancelJob(formula.id);
  expect(attempts.all()).toHaveLength(4);
});
it("worker evidence enriches actual dates without adding a second successful usage", () => {
  const job = newJob("backtest", {});
  updateJob(job.id, { status: "running" });
  const usage = recordResearchUsage(
    () => ({
      kind: "backtest",
      symbols: ["sh600000"],
      universeSize: 1,
      range: { start: "2024-01-02", end: "2024-12-31" },
      candidateCount: 1,
      config: { strategy: "fixture" },
    }),
    job.attemptId,
  );
  updateJob(job.id, { status: "completed" });
  const attempt = new ResearchAttempts(sqlite()).read(job.attemptId!);
  expect(attempt?.usageId).toBe(usage?.id);
  expect(attempt?.actualRange).toEqual({
    start: "2024-01-02",
    end: "2024-12-31",
  });
  expect(
    sqlite()
      .prepare("SELECT COUNT(*) AS n FROM records WHERE kind='research-usage'")
      .get(),
  ).toEqual({ n: 1 });
});
it("audit failure does not fail ordinary jobs and exposes incomplete status", async () => {
  sqlite().exec(
    "CREATE TRIGGER fail_attempt BEFORE INSERT ON records WHEN NEW.kind='research-attempt' BEGIN SELECT RAISE(ABORT,'audit failure'); END",
  );
  try {
    const job = background("backtest", {}, async () => ({ answer: 42 }));
    expect(job.auditIncomplete).toBe(true);
    await vi.waitFor(() => expect(get<Job>(job.id)?.status).toBe("completed"));
    expect(get<Job>(job.id)?.result).toEqual({ answer: 42 });
  } finally {
    sqlite().exec("DROP TRIGGER fail_attempt");
  }
});
it("owner recovery preserves interrupted audit instead of relabeling it failed", () => {
  const job = newJob("backtest", {});
  const missingPid = 2147483647;
  updateJob(job.id, { ownerPid: missingPid });
  sqlite()
    .prepare(
      "UPDATE records SET payload=json_set(payload,'$.ownerPid',?) WHERE id=?",
    )
    .run(missingPid, job.attemptId);
  recoverJobs();
  expect(get<Job>(job.id)?.status).toBe("failed");
  expect(new ResearchAttempts(sqlite()).read(job.attemptId!)?.state).toBe(
    "interrupted",
  );
});
it("job mutations never accept research payload identifiers from another records kind", () => {
  const payload = {
    id: "protected:result",
    status: "running",
    secretResult: 42,
  };
  sqlite()
    .prepare("INSERT INTO records VALUES (?,?,?,?)")
    .run(payload.id, "research-result", JSON.stringify(payload), 1);
  expect(updateJob(payload.id, { status: "completed" })).toBeUndefined();
  cancelJob(payload.id);
  expect(
    sqlite()
      .prepare("SELECT kind,payload FROM records WHERE id=?")
      .get(payload.id),
  ).toEqual({ kind: "research-result", payload: JSON.stringify(payload) });
});
