// Synthetic task rows; the path assertion prevents touching the shared database.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { put, sqlite } from "../src/server/db";
assert.equal(
  resolve(process.env.QUANT_DATA_DIR ?? ""),
  resolve(".test-data/r2c/browser"),
);
for (let i = 0; i < 22; i++) {
  const id = `r2c-task-${String(i).padStart(3, "0")}`;
  put("job", id, {
    id,
    type: "research",
    status: i % 2 ? "failed" : "completed",
    progress: 100,
    createdAt: 1700000000000 + i * 1000,
    updatedAt: 1700000000000 + i * 1000,
    phase: `隔离验收任务 ${i}`,
    ...(i % 2 ? { error: "合成失败详情" } : {}),
    input: {},
  });
}
sqlite().close();
