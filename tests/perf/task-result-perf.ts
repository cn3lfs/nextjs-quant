/** Isolated query/JSON materialization benchmark; stdout is the only artifact. */
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { sqlite, put } from "../../src/server/db";
import { readJob } from "../../src/server/jobs/jobs";
import { taskState } from "../../src/server/jobs/task-history";
import { readScreenResultPage } from "../../src/server/db/screen-result-pages";
import {
  pageScreenResults,
  type StoredScreenResult,
} from "../../src/server/screening/screen-results";
import type { Candidate, Job } from "../../src/lib/domain";

assert.ok(process.env.QUANT_DATA_DIR);
assert.ok(
  resolve(process.env.QUANT_DATA_DIR).startsWith(resolve(".test-data") + sep),
);
const database = sqlite();
assert.deepEqual(
  database.prepare("SELECT count(*) n FROM records WHERE kind='job'").get(),
  { n: 0 },
  "Use a fresh isolated data directory",
);
const formula = { name: "benchmark", source: "选股:C>0;", parameters: {} };
const input = { page: 0, excludedPage: 0, errorPage: 0, query: "" };
const results = [];
for (const [count, bulkBytes] of [
  [200, 0],
  [5225, 0],
  [5225, 4_000_000],
]) {
  const id = `perf-${count}-${bulkBytes}`;
  const candidates = Array.from(
    { length: count! },
    (_, i) =>
      ({
        symbol: `sh${600000 + i}`,
        name: i % 2 ? "银行" : "科技",
        snapshotId: `s-${i}`,
        metrics: {
          close: i,
          change: i % 7,
          fast: 1,
          slow: 1,
          volumeRatio: i % 5,
          matched: true,
          date: "2026-11-13",
          score: i % 11,
        },
      }) satisfies Candidate,
  );
  const result: StoredScreenResult = {
    formula,
    candidates,
    excluded: [],
    errors: [],
    total: count!,
    asOf: null,
    elapsedMs: 1,
    period: "day",
    researchMode: "latest-local",
    universeSource: "fixture",
    researchWarnings: [],
  };
  const job: Job = {
    id,
    type: "screen",
    status: "completed",
    progress: 100,
    createdAt: 1,
    updatedAt: 2,
    input: { type: "formula-screen", formula, root: "fixture", now: 1 },
    result: { ...result, snapshots: bulkBytes ? ["x".repeat(bulkBytes!)] : [] },
  };
  put("job", id, job);
  const currentNames = Object.fromEntries(
    candidates.map((candidate, i) => [candidate.symbol, `当前名称${i}`]),
  );
  const reference = (options: typeof input & { sort?: "score" }) => ({
    jobId: id,
    ...pageScreenResults(
      readJob(id)!.result as StoredScreenResult,
      options,
      currentNames,
    ),
  });
  assert.deepEqual(readScreenResultPage(id, input), reference(input));
  const sorted = { ...input, query: "银行", sort: "score" as const };
  assert.deepEqual(
    readScreenResultPage(id, sorted, currentNames),
    reference(sorted),
  );
  const cases: Record<string, () => unknown> = {
    previousSummary: () => {
      const { input: _input, result: _result, ...summary } = readJob(id)!;
      return summary;
    },
    projectedSummary: () => taskState(id),
    previousFirstPage: () => reference(input),
    databaseFirstPage: () => readScreenResultPage(id, input),
    previousSearchSort: () => reference(sorted),
    databaseSearchSort: () => readScreenResultPage(id, sorted, currentNames),
  };
  for (const [name, run] of Object.entries(cases)) {
    for (let i = 0; i < 3; i++) run();
    const samples = [];
    for (let i = 0; i < 15; i++) {
      const start = performance.now();
      run();
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    let largestJsonParsedBytes = 0;
    const parse = JSON.parse;
    JSON.parse = (text, reviver) => {
      largestJsonParsedBytes = Math.max(
        largestJsonParsedBytes,
        Buffer.byteLength(text),
      );
      return parse(text, reviver);
    };
    let responseBytes = 0;
    try {
      responseBytes = Buffer.byteLength(JSON.stringify(run()));
    } finally {
      JSON.parse = parse;
    }
    results.push({
      count,
      bulkBytes,
      name,
      responseBytes,
      largestJsonParsedBytes,
      medianMs: samples[7],
      p95Ms: samples[14],
    });
  }
}
console.log(JSON.stringify({ results }, null, 2));
database.close();
