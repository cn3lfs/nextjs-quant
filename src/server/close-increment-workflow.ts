import { get } from "./db";
import { settings } from "./settings";
import { completedRpsObservation } from "./rps-observation";
import { securityNames, isAStock } from "./tdx";
import { isRpsMarketSymbol } from "~/lib/rps";
import { runIncrementJob, type IncrementJob } from "./tdx-increment-job";
import type { DailyIncrementSnapshot } from "./tdx-daily-cache";
import {
  runRpsObservation,
  coverageAllowsPublication,
} from "./rps-observation-job";

export const incrementalReferenceIndices = [
  "sh000001",
  "sz399001",
  "sz399006",
  "sh000016",
  "sh000300",
  "sh000905",
  "sh000852",
];
export async function currentIncrementUniverse(root: string) {
  const names = await Promise.all(
    ["sh", "sz"].map((market) => securityNames(root, market, true)),
  );
  const stocks = [
    ...new Set(names.flatMap((map) => [...map.keys()].filter(isAStock))),
  ].sort();
  if (!stocks.length) throw new Error("当前沪深证券名录为空");
  return stocks;
}

/** Check immutable evidence, not merely a task's counters or a downloader exit code. */
export function checkIncrementCoverage(
  job: IncrementJob,
  expected: string[],
  load = (id: string) => get<DailyIncrementSnapshot>(id),
) {
  if (job.status !== "published" && job.status !== "partial")
    return {
      ready: false,
      reason: "增量尚未发布",
      available: 0,
      total: expected.length,
    };
  const expectedSet = new Set(expected.filter(isRpsMarketSymbol));
  const requested = new Set(job.symbols.filter(isRpsMarketSymbol));
  if (
    !expectedSet.size ||
    requested.size !== expectedSet.size ||
    [...expectedSet].some((symbol) => !requested.has(symbol))
  )
    return {
      ready: false,
      reason: "增量任务清单与当前沪深证券池不一致",
      available: 0,
      total: expectedSet.size,
    };
  const available = new Set<string>();
  let reference = false;
  for (const id of job.snapshotIds) {
    const snapshot = load(id);
    if (!snapshot || snapshot.date !== job.date || snapshot.id !== id)
      throw new Error("增量发布证据缺失或日期不一致");
    for (const record of snapshot.records) {
      if (record.bar.date !== job.date) throw new Error("增量K线日期不一致");
      if (expectedSet.has(record.symbol)) available.add(record.symbol);
      if (record.symbol === "sh000001") reference = true;
    }
  }
  const ready =
    reference && coverageAllowsPublication(available.size, expectedSet.size);
  return {
    ready,
    reason: !reference
      ? "缺少当日上证指数参考"
      : ready
        ? "增量覆盖已达到RPS门槛"
        : "有效增量覆盖不足90%",
    available: available.size,
    total: expectedSet.size,
  };
}

export async function runCloseIncrementWorkflow(now = Date.now()) {
  const wall = new Date(now + 8 * 3600000).toISOString();
  if (wall.slice(11, 16) < "15:30")
    throw new Error("收盘增量任务从15:30开始检查发布状态");
  const date = wall.slice(0, 10);
  const root = settings().tdxRoot;
  // Scheduled retries reuse the immutable close publication. Corrections must
  // create an explicit revision, not silently replace an existing observation.
  const existing = completedRpsObservation(root, date, "close");
  if (existing)
    return {
      status: "complete" as const,
      observationId: existing.id,
      reused: true,
    };
  const stocks = await currentIncrementUniverse(root);
  const job = await runIncrementJob(
    date,
    [...stocks, ...incrementalReferenceIndices],
    { now, allowUnavailable: true },
  );
  const coverage = checkIncrementCoverage(job, stocks);
  if (!coverage.ready)
    return {
      status: "waiting" as const,
      jobId: job.id,
      coverage,
      nextAttemptAt: job.nextAttemptAt,
    };
  const observation = await runRpsObservation("close", now);
  return {
    status: "complete" as const,
    jobId: job.id,
    coverage,
    observationId: observation.id,
  };
}
