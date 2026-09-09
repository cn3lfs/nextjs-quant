import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import superjson from "superjson";
import { put, get, sqlite } from "../src/server/db";
import { taskHistory, taskState } from "../src/server/task-history";
import type { Job } from "../src/lib/domain";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-task-history-"));
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
