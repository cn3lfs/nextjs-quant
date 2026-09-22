import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrate } from "../src/server/db/migrations";
import {
  ResearchStore,
  type ResearchResult,
} from "../src/server/backtest/research-store";
import { researchSpecSchema } from "../src/lib/strategy-research";

it("preserves completed results, handles cancellation and only removes terminal research records", () => {
  const db = new Database(":memory:");
  migrate(db);
  try {
    const store = new ResearchStore(db);
    const spec = researchSpecSchema.parse({
      strategy: "dual-breakout",
      start: "2024-01-01",
      end: "2024-12-31",
      validationStart: "2024-10-01",
    });
    const task = store.create(spec, null);
    expect(() => store.remove(task.id)).toThrow("等待");
    store.update(task.id, { status: "running", phase: "计算" });
    const result: ResearchResult = {
      version: "strategy-research-result-1",
      spec,
      datasetHash: "fixture",
      marketEvidenceHash: null,
      events: [],
      outcomes: [],
      partitions: [],
      exclusions: [],
      warnings: [],
      hash: "result1",
    };
    store.finish(task.id, result);
    store.finish(task.id, { ...result, hash: "result2" });
    expect(store.result(task.id)?.hash).toBe("result1");
    store.update(task.id, { status: "failed" });
    expect(store.task(task.id)?.status).toBe("complete");
    const cancelled = store.create(spec, null);
    store.cancel(cancelled.id);
    store.update(cancelled.id, { status: "running" });
    expect(store.task(cancelled.id)?.status).toBe("cancelled");
    expect(() => store.finish(cancelled.id, result)).toThrow("取消");
    const failed = store.create(spec, null);
    store.update(failed.id, { status: "failed", error: "超时" });
    expect(() => store.finish(failed.id, result)).toThrow("迟到结果");
    expect(store.result(failed.id)).toBeNull();
    store.remove(failed.id);
    store.remove(task.id);
    store.remove(cancelled.id);
    expect(store.tasks()).toEqual([]);
    expect(store.result(task.id)).toBeNull();
    expect(() => new ResearchStore(db, 1).create(spec, null)).toThrow(
      "存储上限",
    );
  } finally {
    db.close();
  }
});

it("recovers only a proven dead owner and retries with the original specification", () => {
  const db = new Database(":memory:");
  migrate(db);
  try {
    const store = new ResearchStore(db);
    const spec = researchSpecSchema.parse({
      strategy: "dual-breakout",
      start: "2024-01-01",
      end: "2024-12-31",
      validationStart: "2024-10-01",
    });
    const dead = store.create(spec, null);
    const alive = store.create(spec, null);
    store.update(dead.id, { status: "running", ownerPid: 100 });
    store.update(alive.id, { status: "running", ownerPid: 200 });
    store.recover((pid) => pid === 200);
    expect(store.task(dead.id)?.status).toBe("failed");
    expect(store.task(alive.id)?.status).toBe("running");
    const retry = store.retry(dead.id);
    expect(retry.id).not.toBe(dead.id);
    expect(retry.spec).toEqual(spec);
    expect(() => store.retry(alive.id)).toThrow("等待");
  } finally {
    db.close();
  }
});
