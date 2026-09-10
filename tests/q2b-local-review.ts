/** Manual integration evidence: isolated DB, real local files, existing worker.
 * pnpm exec tsx tests/q2b-local-review.ts with QUANT_DATA_DIR=.test-data/q2b/data
 * Original formulas remain rejection cases. Technical prefix is explicitly named.
 */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Coverage, Job } from "../src/lib/domain";
import { settingsSchema, strategySchema } from "../src/lib/domain";
import type { ScreeningResult } from "../src/server/screening";
import {
  formulaScreenJob,
  saveFormula,
} from "../src/server/formula-screen-service";
import { get } from "../src/server/db";
import { settings, saveSettings } from "../src/server/settings";
import { runWorker, cancelJob } from "../src/server/jobs";
if (
  resolve(process.env.QUANT_DATA_DIR ?? "") !== resolve(".test-data/q2b/data")
)
  throw new Error("Set isolated QUANT_DATA_DIR first");
saveSettings(
  settingsSchema.parse({ autoAnalysis: false, autoNewsAnalysis: false }),
);
const root = settings().tdxRoot;
const original = await readFile(
  "tests/fixtures/q2b-old-duck-original.tdx",
  "utf8",
);
const formula = saveFormula({
  name: "老鸭头（价量部分，非原公式）",
  source: original.split("FXG:=")[0] + "LYT;",
  parameters: {},
});
const job = formulaScreenJob(formula);
let ticks = 0;
while (["queued", "running"].includes(get<Job>(job.id)!.status)) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (++ticks % 10 === 0) {
    const j = get<Job>(job.id)!;
    console.log(j.status, j.progress, j.phase, j.workProgress?.processed);
  }
  if (ticks > 600) {
    cancelJob(job.id);
    throw new Error("Review exceeded ten minutes");
  }
}
const finished = get<Job>(job.id)!;
assert.equal(finished.status, "completed", finished.error);
const result = finished.result as ScreeningResult;
console.log(
  "formula",
  JSON.stringify({
    total: result.total,
    candidates: result.candidates.length,
    elapsedMs: result.elapsedMs,
    asOf: result.asOf,
  }),
);
const coverage = await runWorker<Coverage>({ type: "scan", root });
const symbols = coverage.securities
  .filter((s) => s.period === "day")
  .map((s) => s.symbol);
const started = performance.now();
const baseline = await runWorker<ScreeningResult>({
  type: "screen",
  root,
  symbols,
  period: "day",
  strategy: strategySchema.parse({}),
});
const baselineWallMs = performance.now() - started;
// Real worker cancellation, not a mocked cancellation token.
const cancelled = formulaScreenJob({ ...formula, name: "取消验证" });
await new Promise((resolve) => setTimeout(resolve, 1000));
cancelJob(cancelled.id);
await new Promise((resolve) => setTimeout(resolve, 500));
assert.equal(get<Job>(cancelled.id)?.status, "cancelled");
assert.equal(get<Job>(cancelled.id)?.result, undefined);
const evidence = {
  capturedAt: new Date().toISOString(),
  root,
  dataDirectory: process.env.QUANT_DATA_DIR,
  formula,
  formulaHash: createHash("sha256").update(formula.source).digest("hex"),
  originalDisposition:
    "三条原文均因范围外函数被明确拒绝；本运行仅老鸭头价量部分，非原文等价替代，验收解释待管理者确认",
  jobId: job.id,
  total: result.total,
  asOf: result.asOf,
  elapsedMs: result.elapsedMs,
  candidateCount: result.candidates.length,
  candidates: result.candidates.map((c) => ({
    symbol: c.symbol,
    snapshotId: c.snapshotId,
    date: c.metrics.date,
  })),
  errorCount: result.errors.length,
  excludedCount: result.excluded.length,
  errors: result.errors,
  baseline: {
    elapsedMs: baseline.elapsedMs,
    wallMs: baselineWallMs,
    total: baseline.total,
    candidateCount: baseline.candidates.length,
  },
  cancelledJobId: cancelled.id,
};
await mkdir("docs/q2b-review", { recursive: true });
await writeFile(
  "docs/q2b-review/local-evidence.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(
  "review",
  JSON.stringify({ ...evidence, candidates: undefined, formula: undefined }),
);
