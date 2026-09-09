import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { defaultStrategy, type Job } from "../src/lib/domain";
import { scan } from "../src/server/tdx";
import { get, put, sqlite } from "../src/server/db";
import { screenJob } from "../src/server/runtime";

// Never write benchmark jobs into the user's research archive.
process.env.QUANT_DATA_DIR = mkdtempSync(
  join(tmpdir(), "quant-screen-benchmark-"),
);
const cacheOption = process.argv.find((arg) => arg.startsWith("--cache-mib="));
if (cacheOption) {
  const mib = Number(cacheOption.slice("--cache-mib=".length));
  if (!Number.isInteger(mib) || mib < 1 || mib > 128)
    throw new Error("cache-mib must be an integer from 1 to 128");
  sqlite().pragma(`cache_size = ${-mib * 1024}`);
}
const root =
  process.argv.find((a) => a.startsWith("--root="))?.slice(7) ?? "E:/new_tdx64";
put("settings", "settings", { tdxRoot: root, autoAnalysis: false });
const coverage = await scan(root);
put("coverage", "coverage", coverage);
const firstOnly = process.argv.includes("--first-only");
const varyName = process.argv.includes("--vary-name");
const changeFast = process.argv.includes("--change-fast");
if (firstOnly && changeFast)
  throw new Error("--change-fast needs repeated rounds");
const inspectMemory = process.argv.includes("--inspect-memory");
if (inspectMemory && !global.gc)
  throw new Error(
    "Memory inspection requires node --expose-gc --import tsx; production does not force GC",
  );
for (const period of ["day", "5m"] as const) {
  const measurements: number[] = [];
  const baselines = new Map<number, string>();
  for (let round = 0; round < (firstOnly ? 1 : changeFast ? 7 : 6); round++) {
    const startedAt = Date.now();
    const started = performance.now();
    // Exercise descriptive-name edits without changing calculations; these should reuse results.
    let requestedStrategy = varyName
      ? { ...defaultStrategy, name: `${defaultStrategy.name} #${round}` }
      : defaultStrategy;
    if (changeFast && round > 0)
      requestedStrategy = { ...requestedStrategy, fast: 6 };
    const job = screenJob(requestedStrategy, period);
    const phases: { phase: string; elapsedMs: number }[] = [];
    let saved: Job | undefined;
    do {
      await new Promise((resolve) => setTimeout(resolve, 10));
      saved = get<Job>(job.id);
      if (saved?.phase && phases.at(-1)?.phase !== saved.phase)
        phases.push({
          phase: saved.phase,
          elapsedMs: performance.now() - started,
        });
      if (performance.now() - started > 120000)
        throw new Error(`Job observation deadline: ${job.id}`);
    } while (saved?.status === "queued" || saved?.status === "running");
    const elapsedMs = performance.now() - started;
    const completedAt = Date.now();
    if (saved?.status !== "completed")
      throw new Error(
        JSON.stringify({
          id: job.id,
          status: saved?.status,
          error: saved?.error,
        }),
      );
    const result = saved.result as {
      candidates: unknown[];
      errors: unknown[];
      excluded: unknown[];
      asOf: string;
      total: number;
      timings: unknown;
      researchMode: string;
    };
    if (result.errors.length)
      throw new Error(`Read failures: ${result.errors.length}`);
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          candidates: result.candidates,
          excluded: result.excluded,
          asOf: result.asOf,
          total: result.total,
        }),
      )
      .digest("hex");
    const baseline = baselines.get(requestedStrategy.fast);
    if (baseline && baseline !== hash)
      throw new Error(
        "Results changed: reject timing comparison and inspect source updates",
      );
    baselines.set(requestedStrategy.fast, hash);
    if (round > (changeFast ? 1 : 0)) measurements.push(elapsedMs);
    console.log(
      JSON.stringify({
        period,
        round,
        varyName,
        fast: requestedStrategy.fast,
        workProgress: saved.workProgress,
        jobId: job.id,
        phase:
          changeFast && round === 1
            ? "changed-rule-first"
            : round
              ? "repeat"
              : "first-in-process",
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        crossedMinute:
          Math.floor(startedAt / 60000) !== Math.floor(completedAt / 60000),
        elapsedMs,
        phases,
        total: result.total,
        candidates: result.candidates.length,
        asOf: result.asOf,
        resultHash: hash,
        timings: result.timings,
        researchMode: result.researchMode,
        memory: {
          ...process.memoryUsage(),
          maxRssBytes: process.resourceUsage().maxRSS * 1024,
        },
      }),
    );
  }
  if (!measurements.length) continue;
  measurements.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      period,
      repeatRounds: 5,
      medianMs: measurements[2],
      p95Ms: measurements[4],
      scope:
        "server job creation through persisted completion; excludes UI/HTTP, scan and OS cold-cache reset",
      dataDirectory: process.env.QUANT_DATA_DIR,
    }),
  );
}
if (inspectMemory) {
  const memory = (phase: string) =>
    console.log(
      JSON.stringify({
        diagnostic: "memory",
        phase,
        ...process.memoryUsage(),
        maxRssBytes: process.resourceUsage().maxRSS * 1024,
      }),
    );
  await new Promise((resolve) => setTimeout(resolve, 5000));
  memory("idle-5s");
  global.gc!();
  await new Promise((resolve) => setTimeout(resolve, 100));
  memory("after-main-isolate-gc");
  // This script owns an isolated process/database; never use this in the application.
  const state = (
    globalThis as typeof globalThis & {
      quantJobs?: {
        workers: Map<string, unknown>;
        idle: import("node:worker_threads").Worker[];
      };
    }
  ).quantJobs;
  if (state?.workers.size) throw new Error("Unexpected live benchmark job");
  await Promise.all(
    (state?.idle.slice() ?? []).map((worker) => worker.terminate()),
  );
  global.gc!();
  await new Promise((resolve) => setTimeout(resolve, 100));
  memory("after-owned-workers-stop-and-main-gc");
}
