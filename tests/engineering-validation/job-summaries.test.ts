import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, list, put, sqlite } from "~/server/db";
import { jobSummaries } from "~/server/jobs/job-summaries";
import type { Job } from "~/lib/domain";
import superjson from "superjson";

process.env.QUANT_DATA_DIR = mkdtempSync(
  join(tmpdir(), "quant-job-summaries-"),
);
it("preserves task identity and status within the response budget, with full text retained in storage", () => {
  for (let i = 0; i < 85; i++) {
    put("job", `fixture-${i}`, {
      id: `fixture-${i}`,
      type: "screen",
      status: i % 2 ? "completed" : "running",
      progress: i,
      createdAt: 1700000000000 + i,
      updatedAt: 1700000000000 + i,
      phase: "正在补充资料与检查数据版本".repeat(100),
      error: "原始提示🔬\n\u0001".repeat(1000),
      input: { symbol: "sh600519" },
      result: { nested: { data: "large".repeat(1000) } },
      extra: { result: "large undocumented metadata".repeat(1000) },
    });
    sqlite()
      .prepare("UPDATE records SET updated_at = ? WHERE id = ?")
      .run(i, `fixture-${i}`);
  }
  put("report", "not-a-job", { id: "not-a-job", result: {} });
  const before = get("fixture-84");
  const expected = list<Job>("job", 80);
  const actual = jobSummaries();
  expect(
    Buffer.byteLength(
      JSON.stringify({ result: { data: superjson.serialize(actual) } }),
    ),
  ).toBeLessThan(20000);
  const oldPayload = expected.map(
    ({ input: _input, result: _result, ...rest }) => rest,
  );
  expect(Buffer.byteLength(JSON.stringify(oldPayload))).toBeGreaterThan(20000);
  for (let i = 0; i < actual.length; i++) {
    const { phase, error, ...core } = actual[i]!;
    const expectedCore = expected[i]!;
    expect(core).toEqual({
      id: expectedCore.id,
      type: expectedCore.type,
      status: expectedCore.status,
      progress: expectedCore.progress,
      createdAt: expectedCore.createdAt,
      updatedAt: expectedCore.updatedAt,
    });
    expect(phase).toContain("…");
    expect(error).toContain("…");
    expect(error).not.toContain("\ufffd");
  }
  expect(actual).toHaveLength(80);
  expect(actual[0]?.id).toBe("fixture-84");
  expect(actual.at(-1)?.id).toBe("fixture-5");
  expect(actual[0]).not.toHaveProperty("input");
  expect(actual[0]).not.toHaveProperty("result");
  expect(get("fixture-84")).toEqual(before);
});
