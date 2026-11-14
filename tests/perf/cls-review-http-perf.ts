import assert from "node:assert/strict";
import SuperJSON from "superjson";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const base = "http://127.0.0.1:3224";
async function request(name: string, input: unknown) {
  const response = await fetch(
    `${base}/api/trpc/${name}?input=${encodeURIComponent(SuperJSON.stringify(input))}`,
    {
      headers: {
        "x-quant-client": "workbench",
        origin: base,
        connection: "close",
      },
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text.slice(0, 300));
  return {
    bytes: Buffer.byteLength(text),
    value: SuperJSON.deserialize(JSON.parse(text).result.data),
  };
}
const results = [];
const stress = process.argv.includes("--stress");
for (const [name, input, budget] of [
  ["clsReviewReports", 0, null],
  ["clsReviewReportPage", {}, 200],
  ["clsReviewFacts", "cls-review-report:fixture-00000", null],
  [
    "clsReviewFactPage",
    {
      reportId: stress
        ? "cls-review-stress:report-0"
        : "cls-review-report:fixture-00000",
    },
    200,
  ],
  ["clsReviewVerifications", "2020-01-01", null],
  ["clsReviewVerificationPage", { date: "2020-01-01" }, 200],
  ["clsReviewSummary", undefined, 300],
] as const) {
  const times: number[] = [];
  let bytes = 0;
  for (let i = 0; i < 35; i++) {
    const start = performance.now();
    const result = await request(name, input);
    if (i >= 5) times.push(performance.now() - start);
    bytes = result.bytes;
  }
  times.sort((a, b) => a - b);
  results.push({
    name,
    p50: times[15],
    p95: times[28],
    bytes,
    budget,
    passed: budget === null || (times[28]! <= budget && bytes <= 65536),
  });
}
writeFileSync(
  join(
    tmpdir(),
    `logs/quant-cls-review/http-${stress ? "stress" : "comparison"}.json`,
  ),
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results));
assert.ok(
  results.every((row) => row.passed),
  "HTTP budgets",
);
