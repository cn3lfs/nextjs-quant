import { expect, it } from "vitest";
import superjson from "superjson";
import { put, get, sqlite } from "../../src/server/db/index";
import { taskHistory, taskState } from "../../src/server/jobs/task-history";
import type { Job } from "../../src/lib/domain";
const error = "失败🔬\u0001\n".repeat(1000);
it("pages every task with bounded previews while preserving complete status and original results", () => {
  for (let i = 0; i < 85; i++) {
    const id = `job-${String(i).padStart(36, "0")}`;
    put("job", id, {
      id,
      type: "research",
      status: i % 2 ? "failed" : "completed",
      progress: 100,
      createdAt: 1700000000000,
      updatedAt: 1700000000000 + i,
      phase: error,
      error,
      input: { private: "input" },
      result: { data: "large".repeat(10000) },
      extra: { payload: "large".repeat(10000) },
    });
  }
  put("report", "unrelated", { error: "not a task" });
  const original = get("job-" + String(84).padStart(36, "0"));
  let page = taskHistory({}),
    ids: string[] = [];
  expect(page.total).toBe(85);
  expect(page.items).toHaveLength(20);
  expect(page.items[0]!.id).toBe("job-" + String(84).padStart(36, "0"));
  for (;;) {
    expect(
      Buffer.byteLength(
        JSON.stringify({ result: { data: superjson.serialize(page) } }),
      ),
    ).toBeLessThan(20000);
    for (const item of page.items) {
      expect(item).not.toHaveProperty("input");
      expect(item).not.toHaveProperty("result");
      expect(item).not.toHaveProperty("extra");
      expect(item.errorTruncated).toBe(true);
      expect(item.error).not.toContain("\ufffd");
      ids.push(item.id);
    }
    if (!page.nextCursor) break;
    page = taskHistory({ cursor: page.nextCursor });
  }
  expect(new Set(ids).size).toBe(85);
  const detail = taskState(ids[0]!);
  expect(detail?.error).toBe(error);
  expect(detail?.phase).toBe(error);
  expect(detail).not.toHaveProperty("result");
  expect(detail).not.toHaveProperty("input");
  expect(detail).not.toHaveProperty("extra");
  expect(get(ids[0]!)).toEqual(original);
  expect(taskState("unrelated")).toBeNull();
  expect(taskState("missing")).toBeNull();
});
it("keeps continuation stable when task progress changes or a newer task is inserted", () => {
  const first = taskHistory({}),
    cursor = first.nextCursor!;
  const before = taskHistory({ cursor }).items.map((j) => j.id);
  const id = before[0]!,
    old = get<Job>(id)!;
  put("job", id, { ...old, updatedAt: Date.now(), phase: "完成" });
  const newer = {
    ...old,
    id: "newer",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  put("job", newer.id, newer);
  expect(taskHistory({ cursor }).items.map((j) => j.id)).toEqual(before);
  expect(taskHistory({}).items[0]!.id).toBe("newer");
  const failed = taskHistory({ status: "failed" });
  expect(failed.items.every((j) => j.status === "failed")).toBe(true);
  expect(failed.total).toBe(
    (
      sqlite()
        .prepare(
          "SELECT count(*) AS n FROM records WHERE kind='job' AND json_extract(payload,'$.status')='failed'",
        )
        .get() as { n: number }
    ).n,
  );
  expect(() => taskHistory({ status: "bad" } as never)).toThrow();
});

it("links only completed research to the exact persisted report, with no result payload disclosure", () => {
  const base: Job = {
    id: "linked-job",
    type: "research",
    status: "completed",
    progress: 100,
    createdAt: 1,
    updatedAt: 2,
    input: {},
  };
  for (const kind of [
    "report",
    "chan-report",
    "canslim-report",
    "wyckoff-report",
  ]) {
    const id = kind === "report" ? "report /?#" : `${kind}-${"a".repeat(64)}`;
    put(kind, id, { id, title: "exact report" });
    put("job", base.id, {
      ...base,
      result: kind === "report" ? { id } : { reportId: id },
    });
    expect(taskState(base.id)?.resultLink).toEqual({
      href: `/reports/${kind}/${encodeURIComponent(id)}`,
      label: "查看研究报告",
    });
    expect(taskState(base.id)).not.toHaveProperty("result");
    for (const status of [
      "running",
      "queued",
      "failed",
      "cancelled",
    ] as const) {
      put("job", base.id, { ...base, status, result: { reportId: id } });
      expect(taskState(base.id)?.resultLink).toBeUndefined();
    }
  }
  put("job", base.id, { ...base, result: { reportId: "deleted-report" } });
  expect(taskState(base.id)?.resultLink).toBeUndefined();
  put("final-validation", "sealed", { id: "sealed", result: { secret: true } });
  put("job", base.id, { ...base, result: { id: "sealed" } });
  expect(taskState(base.id)?.resultLink).toBeUndefined();
  put("job", base.id, { ...base, result: { strategy: {} } });
  expect(taskState(base.id)?.resultLink).toBeUndefined();
});

it("opens persisted screening results only after completion", () => {
  const job: Job = {
    id: "screen-with-result",
    type: "screen",
    status: "completed",
    progress: 100,
    createdAt: 1,
    updatedAt: 2,
    input: {},
    result: { selected: [] },
  };
  put("job", job.id, job);
  expect(taskState(job.id)?.screenResultId).toBe(job.id);
  put("job", job.id, { ...job, status: "failed" });
  expect(taskState(job.id)?.screenResultId).toBeUndefined();
  put("job", job.id, { ...job, result: null });
  expect(taskState(job.id)?.screenResultId).toBeUndefined();
});

it("routes batch quick reviews to their exact existing screening result", () => {
  put("job", "batch-screen", {
    id: "batch-screen",
    type: "screen",
    status: "completed",
    result: { selected: [] },
  });
  put("job", "batch-review", {
    id: "batch-review",
    type: "research",
    status: "completed",
    input: { mode: "quick-review", contextId: "batch-screen" },
    result: { reportIds: ["report-a"] },
  });
  expect(taskState("batch-review")?.screenResultId).toBe("batch-screen");
  put("job", "batch-screen", {
    id: "batch-screen",
    type: "screen",
    status: "failed",
  });
  expect(taskState("batch-review")?.screenResultId).toBeUndefined();
});
