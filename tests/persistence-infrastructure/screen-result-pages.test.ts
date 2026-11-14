import { expect, it } from "vitest";
import { put, get } from "~/server/db";
import { readScreenResultPage } from "~/server/db/screen-result-pages";
import {
  pageScreenResults,
  type StoredScreenResult,
} from "~/server/screening/screen-results";
import { screenSortSchema } from "~/lib/screening/screen-sort";
import type { Candidate, Job } from "~/lib/domain";

function seed(id: string, count: number) {
  const formula = { name: "分页", source: "选股:C>0;", parameters: {} };
  const result: StoredScreenResult = {
    formula,
    candidates: Array.from(
      { length: count },
      (_, i) =>
        ({
          symbol: `sh${600000 + Math.floor(i / 2)}`,
          name: i === 0 ? "ÉCOLE" : i % 2 ? "归档银行" : "归档科技",
          snapshotId: `s-${i}`,
          metrics: {
            close: i,
            change: i % 7,
            fast: 1,
            slow: 1,
            volumeRatio: count - i,
            matched: true,
            date: "2026-11-13",
            score: i % 5 === 0 ? NaN : i % 7,
          },
        }) satisfies Candidate,
    ),
    excluded: Array.from({ length: count }, (_, i) => ({
      symbol: `sz${i}`,
      reason: `排除${i}`,
    })),
    errors: Array.from({ length: count }, (_, i) => ({
      symbol: `bj${i}`,
      error: `错误${i}`,
    })),
    total: count * 3,
    asOf: null,
    elapsedMs: 12,
    period: "day",
    researchMode: "latest-local",
    universeSource: "fixture",
    researchWarnings: [],
  };
  put("job", id, {
    id,
    type: "screen",
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    progress: 100,
    input: { type: "formula-screen", formula, root: "fixture", now: 1 },
    result,
  } satisfies Job);
  // Compare the persisted JSON semantics (NaN becomes null), not the seed object.
  return get<Job>(id)!.result as StoredScreenResult;
}

it.each([0, 1, 50, 51, 200, 201])(
  "pages all categories and exact totals for %i rows",
  (count) => {
    const id = `boundary-${count}`,
      stored = seed(id, count);
    const found: string[] = [];
    for (let page = 0; page <= Math.ceil(count / 50); page++) {
      const input = { page, excludedPage: page, errorPage: page, query: "" };
      const actual = readScreenResultPage(id, input)!;
      expect(actual).toEqual({
        jobId: id,
        ...pageScreenResults(stored, input),
      });
      found.push(...actual.candidates.map((row) => row.snapshotId));
    }
    expect(found).toEqual(stored.candidates.map((row) => row.snapshotId));
    expect(get<Job>(id)!.result).toEqual(stored);
  },
);

it("matches whole-pool search and sorting before paging, including ties, missing scores and Unicode names", () => {
  const id = "sorted",
    stored = seed(id, 201);
  const names = {
    ...Object.fromEntries(
      Array.from({ length: 5225 }, (_, i) => [`sz${i}`, `目录名称${i}`]),
    ),
    sh600003: "主档新名",
    sh600004: "sh600004",
  };
  for (const sort of screenSortSchema.options)
    for (const direction of ["asc", "desc"] as const)
      for (const query of ["", "银行", "主档新名", "  école  "])
        for (const page of [0, 1, 4, 5]) {
          const input = {
            page,
            query,
            sort,
            direction,
            excludedPage: 1,
            errorPage: 2,
          };
          expect(readScreenResultPage(id, input, names)).toEqual({
            jobId: id,
            ...pageScreenResults(stored, input, names),
          });
        }
  expect(
    readScreenResultPage(id, {
      page: 0,
      query: "école",
      excludedPage: 0,
      errorPage: 0,
    })?.candidates.map((row) => row.snapshotId),
  ).toEqual(["s-0"]);
});

it("requires a completed formula job and rejects unsafe offsets without reading unrelated records", () => {
  const input = { page: 0, query: "", excludedPage: 0, errorPage: 0 };
  expect(readScreenResultPage("missing", input)).toBeNull();
  seed("wrong-kind", 1);
  const job = get<Job>("wrong-kind")!;
  put("report", job.id, job);
  expect(readScreenResultPage(job.id, input)).toBeNull();
  put("job", job.id, { ...job, input: { type: "old-screen" } });
  expect(readScreenResultPage(job.id, input)).toBeNull();
  for (const status of ["queued", "running", "failed", "cancelled"]) {
    put("job", job.id, { ...job, status });
    expect(readScreenResultPage(job.id, input)).toBeNull();
  }
  for (const page of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER])
    expect(() => readScreenResultPage(job.id, { ...input, page })).toThrow(
      "页码",
    );
});
