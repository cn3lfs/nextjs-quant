import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { put, get, sqlite } from "../src/server/db";
import { screenReviews } from "../src/server/screening/screen-reviews";
import { screenTaskProgress } from "../src/server/jobs/task-history";
process.env.QUANT_DATA_DIR = mkdtempSync(
  join(tmpdir(), "quant-screen-reviews-"),
);
it("keeps the newest research attempt selected when an older attempt reports late progress", () => {
  const base = {
    progress: 0,
    status: "running",
    type: "research",
    input: { contextId: "retry-screen", mode: "quick-review" },
  };
  put("job", "retry-screen", {
    id: "retry-screen",
    type: "screen",
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    progress: 100,
    result: { candidates: [] },
  });
  put("job", "old-attempt", {
    ...base,
    id: "old-attempt",
    createdAt: 2,
    updatedAt: 100,
  });
  put("job", "new-attempt", {
    ...base,
    id: "new-attempt",
    createdAt: 3,
    updatedAt: 3,
  });
  sqlite()
    .prepare("UPDATE records SET updated_at=? WHERE id=?")
    .run(3, "new-attempt");
  sqlite()
    .prepare("UPDATE records SET updated_at=? WHERE id=?")
    .run(100, "old-attempt");
  expect(screenTaskProgress("retry-screen")?.research?.id).toBe("new-attempt");
  expect(
    screenReviews({ id: "retry-screen", snapshotIds: [] }).research?.id,
  ).toBe("new-attempt");
});
it("exposes only batch reports linked to this task and visible candidate snapshots, preserving stored evidence", () => {
  const base = {
    createdAt: 1,
    updatedAt: 1,
    progress: 100,
    status: "completed",
  };
  put("job", "screen", {
    ...base,
    id: "screen",
    type: "screen",
    result: { candidates: [{ snapshotId: "s1" }, { snapshotId: "s2" }] },
  });
  put("job", "review", {
    ...base,
    id: "review",
    type: "research",
    status: "running",
    input: { contextId: "screen", mode: "quick-review" },
    result: { reportIds: ["r1", "other-snapshot", "wrong-kind"] },
  });
  const report = {
    contextId: "s1",
    promptVersion: "quick-review-2",
    summary: "长摘要".repeat(1000),
    risks: ["风险".repeat(1000), "第二项", "第三项"],
    missing: ["缺口"],
    evidence: ["large-private-evidence"],
  };
  put("report", "r1", report);
  put("report", "other-snapshot", { ...report, contextId: "outside" });
  put("report", "wrong-kind", {
    ...report,
    contextId: "s2",
    promptVersion: "research-7",
  });
  put("report", "newer-unrelated", { ...report, createdAt: 999 });
  const data = screenReviews({
    id: "screen",
    snapshotIds: ["s1", "s2", "outside"],
  });
  expect(data.research).toEqual({ id: "review", status: "running" });
  expect(data.items).toHaveLength(1);
  expect(data.items[0]).toMatchObject({
    reportId: "r1",
    snapshotId: "s1",
    riskCount: 3,
    missingCount: 1,
  });
  expect(data.items[0]?.risks).toHaveLength(2);
  expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(2000);
  expect(JSON.stringify(data)).not.toContain("large-private-evidence");
  expect(get("r1")).toEqual(report);
  expect(screenReviews({ id: "screen", snapshotIds: ["s2"] }).items).toEqual(
    [],
  );
  expect(screenReviews({ id: "unrelated", snapshotIds: ["s1"] }).items).toEqual(
    [],
  );
  const next = {
    ...base,
    id: "review",
    type: "research",
    status: "failed",
    input: { contextId: "screen", mode: "quick-review" },
    result: { reportIds: ["r1"], paused: true },
  };
  put("job", "review", next);
  expect(
    screenReviews({ id: "screen", snapshotIds: ["s1"] }).items,
  ).toHaveLength(1);
  expect(
    screenReviews({ id: "screen", snapshotIds: ["s1"] }).research?.status,
  ).toBe("failed");
});
