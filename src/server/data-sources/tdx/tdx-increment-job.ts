import { createHash } from "node:crypto";
import { historicalDateSchema } from "~/lib/historical-screen";
import { symbolSchema } from "~/lib/domain";
import { get, put } from "../../db";
import { claimWorkflow } from "../../jobs/workflow-lease";
import { refreshDailyIncrement } from "./tdx-increment-refresh";

export type IncrementJob = {
  id: string;
  date: string;
  symbols: string[];
  status:
    "running" | "waiting-publication" | "published" | "partial" | "failed";
  attempts: number;
  updatedAt: number;
  nextAttemptAt: number;
  snapshotIds: string[];
  coverage?: {
    available: number;
    unavailable: { symbol: string; reason: string }[];
  };
  error?: string;
};

/** A scheduled tick does one bounded attempt. Retry state survives app restarts. */
export async function runIncrementJob(
  date: string,
  symbols: string[],
  options: {
    force?: boolean;
    now?: number;
    refresh?: typeof refreshDailyIncrement;
    allowUnavailable?: boolean;
  } = {},
) {
  historicalDateSchema.parse(date);
  symbols = [
    ...new Set(symbols.map((symbol) => symbolSchema.parse(symbol))),
  ].sort();
  if (!symbols.length) throw new Error("增量任务证券清单为空");
  const now = options.now ?? Date.now();
  const id = `tdx-increment-job-${date}-${createHash("sha256").update(JSON.stringify(symbols)).digest("hex").slice(0, 20)}`;
  const lease = claimWorkflow(`tdx-increment-${date}`);
  if (!lease) throw new Error("该日期增量任务正在运行");
  try {
    const previous = get<IncrementJob>(id);
    if (
      !options.force &&
      previous &&
      previous.attempts >= 8 &&
      previous.status === "published"
    )
      return previous;
    if (!options.force && previous && previous.attempts >= 8)
      return put("tdx-increment-job", id, {
        ...previous,
        status: "failed",
        error: "本清单当日已尝试8次，等待人工重试",
        updatedAt: now,
      } satisfies IncrementJob);
    if (!options.force && previous && previous.nextAttemptAt > now)
      return previous;
    const running: IncrementJob = {
      id,
      date,
      symbols,
      status: "running",
      attempts: (previous?.attempts ?? 0) + 1,
      updatedAt: now,
      nextAttemptAt: now + 15 * 60000,
      snapshotIds: previous?.snapshotIds ?? [],
    };
    put("tdx-increment-job", id, running);
    try {
      const result = await (options.refresh ?? refreshDailyIncrement)(
        date,
        symbols,
        () => lease.assert(),
        { allowUnavailable: options.allowUnavailable },
      );
      lease.assert();
      return put("tdx-increment-job", id, {
        ...running,
        status:
          result.status === "not-published"
            ? "waiting-publication"
            : result.status,
        snapshotIds:
          result.status !== "not-published"
            ? result.snapshots.map((snapshot) => snapshot.id)
            : running.snapshotIds,
        coverage:
          result.status !== "not-published"
            ? {
                available: result.snapshots.reduce(
                  (n, snapshot) => n + snapshot.records.length,
                  0,
                ),
                unavailable: result.snapshots.flatMap(
                  (snapshot) => snapshot.unavailable,
                ),
              }
            : previous?.coverage,
      } satisfies IncrementJob);
    } catch (error) {
      lease.assert();
      return put("tdx-increment-job", id, {
        ...running,
        status: "failed",
        error: error instanceof Error ? error.message : "日线增量任务失败",
      } satisfies IncrementJob);
    }
  } finally {
    lease.release();
  }
}
