import { expect, it } from "vitest";
import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";
import { get, put } from "~/server/db";
import { defaultStrategy, type Job } from "~/lib/domain";
import { taskState } from "~/server/db/task-history";
import { jobSummaries } from "~/server/db/job-summaries";

const formula = { name: "当前公式", source: "选股:C>0;", parameters: {} };
function seed(id: string, input: unknown, status: Job["status"] = "completed") {
  return put("job", id, {
    id,
    type: "screen",
    status,
    progress: 100,
    createdAt: 1,
    updatedAt: 2,
    input,
    result: {
      formula,
      candidates: [],
      excluded: [],
      errors: [],
      total: 0,
      asOf: null,
      elapsedMs: 12,
      period: "day",
      researchMode: "latest-local",
      universeSource: "当前本地通达信全 A 股日线",
      researchWarnings: [],
    },
  } satisfies Job);
}

it("rejects old screen results across paging, first-page summary, export, progress and task links", async () => {
  const caller = appRouter.createCaller(
    await createTRPCContext({ headers: new Headers() }),
  );
  const old = seed("retired-screen", {
    strategy: defaultStrategy,
    period: "day",
    symbols: [],
    root: "fixture",
  });
  expect(await caller.screenResults({ id: old.id })).toBeNull();
  expect(
    (await caller.jobSummary({ id: old.id, screenFirstPage: true }))
      ?.screenFirstPage,
  ).toBeNull();
  await expect(caller.screenExport(old.id)).rejects.toThrow("公式选股");
  expect(await caller.screenTaskProgress({ id: old.id })).toBeNull();
  expect(taskState(old.id)?.screenResultId).toBeUndefined();
  expect(taskState(old.id)?.sourceLink).toBeUndefined();
  expect(jobSummaries().find((j) => j.id === old.id)).toMatchObject({
    isFormulaScreen: false,
  });
  expect(get(old.id)).toEqual(old);
});

it("retains the exact current formula identity and exposes results only after completion", async () => {
  const caller = appRouter.createCaller(
    await createTRPCContext({ headers: new Headers() }),
  );
  const input = { type: "formula-screen", formula, root: "fixture", now: 100 };
  const current = seed("current-formula", input);
  expect(await caller.screenResults({ id: current.id })).toMatchObject({
    jobId: current.id,
    formula,
    candidateTotal: 0,
  });
  expect(
    (await caller.jobSummary({ id: current.id, screenFirstPage: true }))
      ?.screenFirstPage,
  ).toMatchObject({ jobId: current.id, formula });
  expect(await caller.screenExport(current.id)).toMatchObject({
    format: "quant-formula-screen-export-1",
    jobId: current.id,
    parameters: input,
  });
  expect(taskState(current.id)?.screenResultId).toBe(current.id);
  expect(taskState(current.id)?.sourceLink?.href).toBe("/screen");
  expect(jobSummaries().find((j) => j.id === current.id)).toMatchObject({
    isFormulaScreen: true,
  });
  expect(await caller.screenTaskProgress({ id: current.id })).toMatchObject({
    id: current.id,
  });
  for (const status of ["queued", "running", "failed", "cancelled"] as const) {
    seed(current.id, input, status);
    expect(await caller.screenResults({ id: current.id })).toBeNull();
    expect(
      (await caller.jobSummary({ id: current.id, screenFirstPage: true }))
        ?.screenFirstPage,
    ).toBeNull();
    await expect(caller.screenExport(current.id)).rejects.toThrow("已完成");
    expect(taskState(current.id)?.screenResultId).toBeUndefined();
  }
});

it("does not route retired batch reviews to formula results", () => {
  seed("old-context", {});
  put("job", "old-review", {
    id: "old-review",
    type: "research",
    status: "completed",
    progress: 100,
    createdAt: 1,
    updatedAt: 2,
    input: { mode: "quick-review", contextId: "old-context" },
    result: {},
  } satisfies Job);
  expect(taskState("old-review")?.screenResultId).toBeUndefined();
  expect(taskState("old-review")?.sourceLink).toBeUndefined();
});
