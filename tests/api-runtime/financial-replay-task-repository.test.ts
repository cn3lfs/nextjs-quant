import { describe, expect, it } from "vitest";
import { put } from "~/server/db";
import { financialReplayTaskRows } from "~/server/db/jobs";
import { financialReplayTasks } from "~/server/financial/financial-replay-store";
import { financialReplayInput } from "~/lib/financial/financial-replay";

const requestIdentity = "a".repeat(64);
const job = (
  id: string,
  createdAt: number,
  input: unknown,
  type = "financial-replay",
) => ({
  id,
  type: "research",
  status: "completed",
  progress: 100,
  phase: "阶段".repeat(150),
  error: "错误".repeat(150),
  createdAt,
  updatedAt: createdAt,
  input: { type, root: "E:/tdx", input, requestIdentity },
  result: { reportId: `financial-replay-${id.padEnd(64, "0")}` },
});

describe("financial replay task repository projection", () => {
  it("keeps SQL projection in the job repository and maps only valid inputs", () => {
    const valid = financialReplayInput.parse({
      symbols: ["sh600519"],
      firstYear: 2026,
      lastYear: 2026,
      endDate: "2026-11-02",
      initial: 1000000,
    });
    put("job", "job-fin-old", job("job-fin-old", 1, valid));
    put(
      "job",
      "job-fin-malformed",
      job("job-fin-malformed", 3, { symbols: [] }),
    );
    put("job", "job-fin-missing", job("job-fin-missing", 2, undefined));
    put("job", "job-other", job("job-other", 4, valid, "local-financial"));

    const rows = financialReplayTaskRows(2);
    expect(rows.map((row) => row.id)).toEqual([
      "job-fin-malformed",
      "job-fin-missing",
    ]);
    expect(rows.every((row) => row.input === null)).toBe(false);
    expect(rows[0]?.input).toContain("symbols");

    const tasks = financialReplayTasks();
    expect(tasks.map((task) => task.id)).toEqual([
      "job-fin-malformed",
      "job-fin-missing",
      "job-fin-old",
    ]);
    const malformed = tasks.find((task) => task.id === "job-fin-malformed")!;
    const missing = tasks.find((task) => task.id === "job-fin-missing")!;
    const old = tasks.find((task) => task.id === "job-fin-old")!;
    expect(malformed.input).toBeNull();
    expect(missing.input).toBeNull();
    expect(old.input).toMatchObject({
      symbols: ["sh600519"],
      firstYear: 2026,
      lastYear: 2026,
      endDate: "2026-11-02",
      initial: 1000000,
      costScenario: "base",
      preset: "magic-formula",
    });
    expect(old.phase).toHaveLength(200);
    expect(old.error).toHaveLength(200);
    expect(old.reportId).toBe(
      `financial-replay-${"job-fin-old".padEnd(64, "0")}`,
    );
  });
});
