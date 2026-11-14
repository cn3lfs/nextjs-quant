import { expect, it, vi } from "vitest";
import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";
import { put } from "~/server/db";
import type { Job, Candidate } from "~/lib/domain";
import {
  pageScreenResults,
  type StoredScreenResult,
} from "~/server/screening/screen-results";

it("projects task progress and each result page without parsing archived bulk evidence in JS", async () => {
  const formula = { name: "projection", source: "选股:C>0;", parameters: {} };
  const rows = Array.from(
    { length: 123 },
    (_, i) =>
      ({
        symbol: `sh${600000 + i}`,
        name: `证券${i}`,
        snapshotId: `s-${i}`,
        metrics: {
          close: i,
          change: i,
          fast: i,
          slow: i,
          volumeRatio: i,
          matched: true,
          date: "2026-11-13",
          score: i,
        },
      }) satisfies Candidate,
  );
  const result: StoredScreenResult = {
    formula,
    candidates: rows,
    excluded: rows.map((row) => ({ symbol: row.symbol, reason: "排除" })),
    errors: rows.map((row) => ({ symbol: row.symbol, error: "失败" })),
    total: 369,
    asOf: null,
    elapsedMs: 1,
    period: "day",
    researchMode: "latest-local",
    universeSource: "fixture",
    researchWarnings: [],
  };
  const job: Job = {
    id: "projection-job",
    type: "screen",
    status: "completed",
    progress: 100,
    createdAt: 1,
    updatedAt: 2,
    input: { type: "formula-screen", formula, root: "fixture", now: 1 },
    result: { ...result, snapshots: ["ARCHIVE-ONLY-".repeat(100000)] },
  };
  put("job", job.id, { ...job, extraEvidence: "ARCHIVE-ONLY-".repeat(100000) });
  const caller = appRouter.createCaller(
    await createTRPCContext({ headers: new Headers() }),
  );
  const parse = vi.spyOn(JSON, "parse");
  try {
    const summary = await caller.jobSummary({ id: job.id });
    expect(summary).toMatchObject({
      id: job.id,
      status: "completed",
      isFormulaScreen: true,
      screenFirstPage: null,
    });
    expect(summary).not.toHaveProperty("extraEvidence");
    expect(summary).not.toHaveProperty("result");
    const first = await caller.jobSummary({
      id: job.id,
      screenFirstPage: true,
    });
    expect(first?.screenFirstPage).toEqual({
      jobId: job.id,
      ...pageScreenResults(result, {
        page: 0,
        query: "",
        excludedPage: 0,
        errorPage: 0,
      }),
    });
    const page = await caller.screenResults({
      id: job.id,
      page: 2,
      excludedPage: 1,
      errorPage: 2,
      sort: "score",
      direction: "desc",
    });
    expect(page).toEqual({
      jobId: job.id,
      ...pageScreenResults(result, {
        page: 2,
        query: "",
        excludedPage: 1,
        errorPage: 2,
        sort: "score",
        direction: "desc",
      }),
    });
    expect(
      parse.mock.calls.some(
        ([value]) =>
          typeof value === "string" && value.includes("ARCHIVE-ONLY-"),
      ),
    ).toBe(false);
  } finally {
    parse.mockRestore();
  }
  const exported = await caller.screenExport(job.id);
  expect(exported.candidates).toHaveLength(123);
  expect(exported.excluded).toHaveLength(123);
  expect(exported.errors).toHaveLength(123);
  expect(exported).not.toHaveProperty("snapshots");
});
