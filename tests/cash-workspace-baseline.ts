import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, cpus, totalmem } from "node:os";
import { cashReconciliationPage } from "../src/lib/portfolio/cash-reconciliation";
import { cashWorkspaceFixture } from "./helpers/cash-workspace-fixture";
const results = [];
for (const count of [100, 1000, 10000]) {
  const result = cashWorkspaceFixture(count, 20000);
  assert.deepEqual(
    result.days.slice(0, 4).map((day) => day.status),
    ["matched", "difference", "unavailable", "conflict"],
  );
  assert.equal(result.days[1]!.difference, 0.01);
  const samples = [];
  let bytes = 0;
  for (let i = 0; i < 35; i++) {
    const start = performance.now();
    const page = cashReconciliationPage(result, { pageIndex: 0, pageSize: 20 });
    const serialized = JSON.stringify(page);
    if (i >= 5) samples.push(performance.now() - start);
    bytes = Buffer.byteLength(serialized);
    assert.equal(page.total, count);
  }
  samples.sort((a, b) => a - b);
  results.push({
    count,
    n: samples.length,
    p50: samples[14],
    p95: samples[28],
    bytes,
  });
}
const report = {
  results,
  cpu: cpus()[0]?.model,
  ram: totalmem(),
  node: process.version,
  build: readFileSync(".next/BUILD_ID", "utf8").trim(),
  scope:
    "old cash page projection plus JSON serialization; excludes accountReview build and HTTP; 20000 rows on first day",
};
writeFileSync(
  join(tmpdir(), "logs/quant-cash-reconciliation/q0-query-baseline.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
