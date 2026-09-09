import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { scan } from "../src/server/tdx";
import { get, put, list } from "../src/server/db";
import { screenJob } from "../src/server/runtime";
import {
  exportScreenResults,
  pageScreenResults,
  type StoredScreenResult,
} from "../src/server/screen-results";
import { metrics } from "../src/server/quant";
import { defaultStrategy, type Job, type Snapshot } from "../src/lib/domain";

const directory = await mkdtemp(
  join(tmpdir(), "quant-current-screen-verification-"),
);
process.env.QUANT_DATA_DIR = directory;
const root = "E:/new_tdx64";
put("settings", "settings", {
  tdxRoot: root,
  autoAnalysis: false,
  llmProvider: "codex",
});
console.log(JSON.stringify({ phase: "scan", directory }));
const coverage = await scan(root);
put("coverage", "coverage", coverage);
const symbols = [
  ...new Set(
    coverage.securities.filter((s) => s.period === "day").map((s) => s.symbol),
  ),
].sort();
assert.ok(symbols.length > 0);
const strategy = { ...defaultStrategy, minVolumeRatio: 1.2 };
async function complete(job: Job) {
  let phase = "";
  for (;;) {
    const saved = get<Job>(job.id);
    assert.ok(saved);
    if (saved.phase !== phase) {
      phase = saved.phase ?? "";
      console.log(
        JSON.stringify({ id: saved.id, status: saved.status, phase }),
      );
    }
    if (!["queued", "running"].includes(saved.status)) return saved;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const latest = await complete(screenJob(strategy, "day", symbols));
assert.equal(latest.status, "completed", latest.error);
const result = latest.result as StoredScreenResult;
assert.equal(result.total, symbols.length);
assert.equal(result.researchMode, "latest-local");
assert.ok(result.asOf);
const before = JSON.stringify(latest);
for (const candidate of result.candidates) {
  const snapshot = get<Snapshot>(candidate.snapshotId);
  assert.ok(snapshot, candidate.snapshotId);
  assert.equal(snapshot.symbol, candidate.symbol);
  assert.equal(snapshot.period, "day");
  assert.equal(snapshot.source, "tdx-local");
  assert.equal(snapshot.bars.at(-1)?.date, result.asOf);
  assert.equal(candidate.metrics.date, result.asOf);
  assert.deepEqual(metrics(snapshot.bars, strategy), candidate.metrics);
}
const pages = [];
for (
  let page = 0;
  page < Math.max(1, Math.ceil(result.candidates.length / 50));
  page++
) {
  const paged = pageScreenResults(result, {
    page,
    query: "",
    excludedPage: page,
    errorPage: page,
  });
  assert.deepEqual(paged.dataHealth, result.dataHealth);
  assert.equal(paged.asOf, result.asOf);
  pages.push(...paged.candidates);
}
assert.deepEqual(pages, result.candidates);
const exported = exportScreenResults(latest);
assert.deepEqual(exported.candidates, result.candidates);
assert.deepEqual(exported.excluded, result.excluded);
assert.deepEqual(exported.errors, result.errors);
assert.deepEqual(exported.dataHealth, result.dataHealth);
assert.deepEqual(exported.poolContext, result.poolContext);
assert.equal(exported.parameters.root, root);
assert.deepEqual(exported.parameters.symbols, symbols);
assert.equal(JSON.stringify(get(latest.id)), before);
const savedSnapshots = list<Snapshot>("snapshot", 20000).length;
const strict = await complete(
  screenJob(strategy, "day", symbols, { requireCurrent: true }),
);
if (strict.status === "completed") {
  assert.equal(
    (strict.result as StoredScreenResult).dataHealth?.status,
    "aligned",
  );
  assert.equal((strict.result as StoredScreenResult).researchMode, "current");
} else {
  assert.equal(strict.status, "failed");
  assert.match(strict.error ?? "", /严格当前模式未通过/);
  assert.equal(strict.phase, "核对选股基准日与交易日历");
  assert.deepEqual(strict.workProgress, {
    stage: "核对选股基准日与交易日历",
    unit: "步骤",
    processed: 1,
    total: 1,
    failed: 1,
    excluded: 0,
  });
  assert.equal(list<Snapshot>("snapshot", 20000).length, savedSnapshots);
}
assert.equal(
  list<Job>("job", 20000).filter((j) => j.type === "research").length,
  0,
);
assert.equal(list("report", 20000).length, 0);
const summary = {
  directory,
  latestJobId: latest.id,
  strictJobId: strict.id,
  symbols: symbols.length,
  asOf: result.asOf,
  candidates: result.candidates.length,
  excluded: result.excluded?.length ?? 0,
  errors: result.errors.length,
  exclusionReasons: Object.fromEntries(
    [...new Set(result.excluded?.map((e) => e.reason))].map((reason) => [
      reason,
      result.excluded?.filter((e) => e.reason === reason).length,
    ]),
  ),
  health: result.dataHealth,
  strictStatus: strict.status,
  strictPhase: strict.phase,
  strictWorkProgress: strict.workProgress,
  strictError: strict.error ?? null,
  candidatesRecomputed: result.candidates.length,
  candidatePages: Math.ceil(result.candidates.length / 50),
  exportHash: createHash("sha256")
    .update(JSON.stringify(exported))
    .digest("hex"),
  recordsUnchanged: true,
  researchJobs: 0,
  reports: 0,
};
await writeFile(
  "output/current-screen-export.json",
  JSON.stringify(exported, null, 2),
);
await writeFile(
  "output/current-screen-verification.json",
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary));
