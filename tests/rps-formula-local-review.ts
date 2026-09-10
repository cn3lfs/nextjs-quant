/** Manual S3a acceptance on real local files. No source files are written.
 * $env:QUANT_DATA_DIR='.test-data/s3a'; pnpm exec tsx tests/rps-formula-local-review.ts
 * Existing test lifecycle owns cleanup, including abandoned runs after 24 hours.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setup } from "./global-setup";
import { settingsSchema } from "../src/lib/domain";
import { rpsPolicy, type RpsProgress } from "../src/lib/rps";
import { sqlite } from "../src/server/db";
import { RpsStore } from "../src/server/rps-store";
import { localRpsDependencies, runRpsJob } from "../src/server/rps-job";
import { screenFormula } from "../src/server/formula-screening";

assert.equal(
  resolve(process.env.QUANT_DATA_DIR ?? ""),
  resolve(".test-data/s3a"),
);
const cleanup = setup();
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "s3a-"));
try {
  const root = process.env.TDX_ROOT ?? settingsSchema.parse({}).tdxRoot;
  const now = Date.now();
  const store = new RpsStore(sqlite());
  const progress: RpsProgress = {
    id: crypto.randomUUID(),
    mode: "backfill",
    status: "running",
    phase: "start",
    scanned: 0,
    total: 0,
    completedDays: 0,
    totalDays: 1,
    startedAt: now,
    updatedAt: now,
  };
  assert.equal(store.claim(progress), true);
  let lastLog = 0;
  const batch = await runRpsJob(
    store,
    localRpsDependencies(root, []),
    { mode: "backfill", days: 1 },
    progress,
    now,
    (p) => {
      if (Date.now() - lastLog > 10000) {
        console.log("RPS", p.phase, p.scanned, p.total);
        lastLog = Date.now();
      }
    },
  );
  assert.equal(batch.status, "complete", batch.error);
  const day = store.latest()!;
  console.log(
    JSON.stringify({
      root,
      date: day.date,
      mode: day.mode,
      pool: day.pool,
      counts: day.counts,
      inputHash: day.inputHash,
      warning: rpsPolicy.backfillWarning,
    }),
  );
  const formulas = [
    [
      "月线反转 5.0",
      `{月线反转 5.0}
A:=C/MA(C,250)>1;
NH:=IF(H<HHV(H,50),0,1); B:=COUNT(NH,30);
D:=IF(RPS50<=85,0,1);
NN:=IF(C>MA(C,250),1,0); AA:=COUNT(NN,30);
AB:=HIGH/HHV(HIGH,120)>0.9;
A AND B AND D AND AA>2 AND AA<30 AND AB;`,
    ],
    ["接近一年新高", "CLOSE/HHV(HIGH,250)>0.9;"],
    ["一年新高", "NH:IF(H<HHV(H,250),0,1);"],
  ];
  for (const [name, source] of formulas) {
    const result = await screenFormula({
      type: "formula-screen",
      root,
      now,
      formula: { name: name!, source: source!, parameters: {} },
    });
    assert.equal(result.asOf, day.date);
    assert.equal(
      result.errors.length,
      0,
      JSON.stringify(result.errors.slice(0, 3)),
    );
    if (name === "月线反转 5.0") {
      const strong = new Set(
        store
          .ranking(day.date, 50)
          .filter((v) => v.rps > 85)
          .map((v) => v.symbol),
      );
      assert.ok(strong.size > 0);
      assert.ok(result.candidates.every((c) => strong.has(c.symbol)));
    }
    console.log(
      JSON.stringify({
        name,
        total: result.total,
        asOf: result.asOf,
        candidates: result.candidates.length,
        excluded: result.excluded.length,
        errors: result.errors.length,
        elapsedMs: Math.round(result.elapsedMs),
      }),
    );
  }
} finally {
  sqlite().close();
  cleanup();
}
