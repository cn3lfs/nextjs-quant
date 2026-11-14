/** Repeatable synthetic before/after query comparison. Never use a user DB. */
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { sqlite, put } from "../../src/server/db";
import { taskState } from "../../src/server/db/task-history";
import { readScreenResultPage } from "../../src/server/db/screen-result-pages";
import {
  exportFormulaScreen,
  exportStoredFormulaScreen,
} from "../../src/server/screening/formula-screen-service";
import type { Candidate, Job } from "../../src/lib/domain";
import {
  pageScreenResults,
  type StoredScreenResult,
} from "../../src/server/screening/screen-results";

assert.ok(process.env.QUANT_DATA_DIR);
assert.ok(
  resolve(process.env.QUANT_DATA_DIR).startsWith(
    resolve(".test-data/optimization-20261113/d-repositories") + sep,
  ),
);
const db = sqlite();
assert.deepEqual(db.prepare("SELECT count(*) n FROM records").get(), { n: 0 });
const count = 6154;
const formula = { name: "D benchmark", source: "选股:C>0;", parameters: {} };
const candidates: Candidate[] = Array.from({ length: count }, (_, i) => ({
  symbol: `sh${600000 + i}`,
  name: `合成${i}`,
  snapshotId: `s${i}`,
  metrics: {
    close: i + 1,
    change: i % 7,
    fast: 1,
    slow: 1,
    volumeRatio: 1,
    matched: true,
    score: i % 11,
    date: "2026-11-13",
  },
}));
const result: StoredScreenResult = {
  formula,
  candidates,
  excluded: [],
  errors: [],
  total: count,
  asOf: null,
  elapsedMs: 1,
  period: "day",
  researchMode: "latest-local",
  universeSource: "synthetic-6154",
  researchWarnings: [],
};
const job: Job = {
  id: "benchmark",
  type: "screen",
  status: "completed",
  progress: 100,
  createdAt: 1,
  updatedAt: 2,
  input: { type: "formula-screen", formula, root: "synthetic", now: 1 },
  result: { ...result, snapshots: ["UNREQUESTED".repeat(400000)] },
};
put("job", job.id, job);
const previousRead = () =>
  JSON.parse(
    (
      db
        .prepare("SELECT payload FROM records WHERE kind='job' AND id=?")
        .get(job.id) as { payload: string }
    ).payload,
  ) as Job;
const page = { page: 0, excludedPage: 0, errorPage: 0, query: "" };
assert.deepEqual(
  exportStoredFormulaScreen(job.id),
  exportFormulaScreen(previousRead()),
);
assert.deepEqual(readScreenResultPage(job.id, page), {
  jobId: job.id,
  ...pageScreenResults(result, page),
});
const cases = {
  previousSummary: () => {
    const { input: _input, result: _result, ...summary } = previousRead();
    return summary;
  },
  projectedSummary: () => taskState(job.id),
  previousFirstPage: () =>
    pageScreenResults(previousRead().result as StoredScreenResult, page),
  projectedFirstPage: () => readScreenResultPage(job.id, page),
  previousFullExport: () => exportFormulaScreen(previousRead()),
  boundedFullExport: () => exportStoredFormulaScreen(job.id),
};
const measurements = [];
for (const [name, run] of Object.entries(cases)) {
  run();
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
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
  let responseBytes: number;
  try {
    responseBytes = Buffer.byteLength(JSON.stringify(run()));
  } finally {
    JSON.parse = parse;
  }
  measurements.push({
    name,
    medianMs: samples[3],
    maxMs: samples[6],
    largestJsonParsedBytes,
    responseBytes,
  });
}
console.log(
  JSON.stringify(
    { count, jobBytes: Buffer.byteLength(JSON.stringify(job)), measurements },
    null,
    2,
  ),
);
db.close();
