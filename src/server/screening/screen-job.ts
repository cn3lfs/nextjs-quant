import { workProgress } from "~/lib/research/workflow/work-progress";
import { type Coverage, type Job, type Period, type Snapshot, type Strategy } from "~/lib/domain";
import { validateHistoricalScreen } from "~/lib/screening/historical-screen";
import { get, putChangedBatch } from "../db";
import { settings } from "../infra/settings";
import { background, runWorker, updateJob } from "../jobs/jobs";
import { securityDirectory } from "../market/securities";
import { gfCalendarReference } from "../data-sources/gf/gf-calendar";
import { localCalendarReference, screenDataHealth, requireCurrentScreen } from "../market/data-health";
import { serializeSnapshot } from "./snapshot-serializer";
import { quickResearch } from "../research/quick-research";
import type { ScreeningResult } from "./screening";

export function screenJob(
  strategy: Strategy,
  period: Period,
  symbols?: string[],
  historical: {
    asOf?: string;
    universeSource?: string;
    requireCurrent?: boolean;
  } = {},
) {
  const history = validateHistoricalScreen(historical, symbols);
  const universe = symbols?.length
    ? symbols
    : get<Coverage>("coverage")
        ?.securities.filter((s) => s.period === period)
        .map((s) => s.symbol);
  if (!universe?.length) throw new Error("先扫描本地数据，或输入证券池");
  const config = settings();
  const uniqueSymbols = [...new Set(universe)].sort();
  return background(
    "screen",
    {
      strategy,
      period,
      symbols: uniqueSymbols,
      root: config.tdxRoot,
      ...history,
    },
    async (job, signal) => {
      const timingStart = performance.now();
      updateJob(job.id, { phase: "准备证券主档" });
      const directoryProgressDone = performance.now();
      const directory = await securityDirectory();
      const directoryReadDone = performance.now();
      const names =
        directory.root === config.tdxRoot
          ? Object.fromEntries(
              uniqueSymbols.flatMap((symbol) =>
                directory.entries[symbol]?.name
                  ? [[symbol, directory.entries[symbol]!.name]]
                  : [],
              ),
            )
          : undefined;
      const directoryDone = performance.now();
      const result = await runWorker<ScreeningResult>(
        {
          type: "screen",
          root: config.tdxRoot,
          symbols: uniqueSymbols,
          names,
          period,
          strategy,
          asOf: history.asOf,
        },
        job.id,
      );
      const workerDone = performance.now();
      if (signal.aborted) throw new Error("已取消");
      const calendarStage = "核对选股基准日与交易日历";
      updateJob(job.id, {
        phase: calendarStage,
        workProgress: workProgress(calendarStage, "步骤", 0, 1),
      });
      let calendarReference = await localCalendarReference(
        config.tdxRoot,
        config.calendar,
      );
      if (
        history.requireCurrent &&
        !config.calendar.length &&
        uniqueSymbols.every((symbol) => /^(sh|sz)/.test(symbol))
      ) {
        try {
          calendarReference = await gfCalendarReference(Date.now(), signal);
        } catch {
          signal.throwIfAborted();
          calendarReference.source += "；广发日历不可用，使用本地参考";
        }
      }
      const dataHealth = screenDataHealth(
        result.asOf,
        period,
        Date.now(),
        calendarReference,
      );
      try {
        if (history.requireCurrent) requireCurrentScreen(dataHealth);
      } catch (error) {
        updateJob(job.id, {
          workProgress: workProgress(calendarStage, "步骤", 1, 1, 1),
        });
        throw error;
      }
      updateJob(job.id, {
        workProgress: workProgress(calendarStage, "步骤", 1, 1),
      });
      const calendarDone = performance.now();
      const saveBatches = Math.ceil(result.snapshots.length / 50);
      updateJob(job.id, {
        progress: 96,
        phase: "保存候选快照",
        workProgress: workProgress("保存候选快照", "批次", 0, saveBatches),
      });
      const saveProgressDone = performance.now();
      let snapshotSerializeMs = 0;
      let snapshotChangedRecords = 0;
      for (let i = 0; i < result.snapshots.length; i += 50) {
        signal.throwIfAborted();
        try {
          snapshotChangedRecords += putChangedBatch(
            "snapshot",
            result.snapshots.slice(i, i + 50),
            (snapshot) => {
              const started = performance.now();
              const json = serializeSnapshot(snapshot);
              snapshotSerializeMs += performance.now() - started;
              return json;
            },
            () => {
              signal.throwIfAborted();
              if (get<Job>(job.id)?.status !== "running")
                throw new Error("选股任务已停止，不再保存后续候选");
            },
          );
        } catch (error) {
          updateJob(job.id, {
            workProgress: workProgress(
              "保存候选快照",
              "批次",
              i / 50 + 1,
              saveBatches,
              1,
            ),
          });
          throw error;
        }
        updateJob(job.id, {
          workProgress: workProgress(
            "保存候选快照",
            "批次",
            i / 50 + 1,
            saveBatches,
          ),
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      signal.throwIfAborted();
      const saveDone = performance.now();
      if (get<Job>(job.id)?.status !== "running")
        throw new Error("选股任务已停止，不再启动自动快评");
      updateJob(job.id, {
        phase: "规则筛选完成",
        workProgress: workProgress(
          "规则筛选汇总",
          "证券",
          result.total,
          result.total,
          result.errors.length,
          result.excluded.length,
        ),
      });
      if (config.autoAnalysis && result.candidates.length) {
        const top = result.candidates.slice(0, config.analysisLimit);
        background(
          "research",
          { contextId: job.id, mode: "quick-review" },
          async (researchJob, abort) => {
            const sources = top
              .map((c) => get<Snapshot>(c.snapshotId))
              .filter((s): s is Snapshot => !!s);
            if (sources.length !== top.length)
              throw new Error("候选快照缺失，请重新选股");
            const reviewed = await quickResearch(
              sources,
              strategy,
              abort,
              (done, total, phase, counts, reportIds) =>
                updateJob(researchJob.id, {
                  progress: Math.round((done / total) * 100),
                  phase,
                  ...(counts ? { workProgress: counts } : {}),
                  ...(reportIds ? { result: { reportIds } } : {}),
                }),
              [
                ...(result.poolContext
                  ? [
                      {
                        id: `pool-${result.poolContext.observationHash}`,
                        source: "本次证券池同一时点统计（不是全市场背景）",
                        asOf: result.asOf ?? "未知",
                        text: JSON.stringify(result.poolContext),
                      },
                    ]
                  : []),
                {
                  id: "screen-data-health",
                  source: "本次选股数据健康核验",
                  asOf: dataHealth.dataAsOf ?? "未知",
                  text: JSON.stringify(dataHealth),
                },
              ],
            );
            if (reviewed.paused) {
              updateJob(researchJob.id, { result: reviewed });
              throw new Error(
                `${reviewed.summary}：${reviewed.failures[0]?.reason}`,
              );
            }
            return reviewed;
          },
        );
      }
      return {
        candidates: result.candidates,
        errors: result.errors,
        total: result.total,
        excluded: result.excluded,
        asOf: result.asOf,
        elapsedMs: result.elapsedMs,
        timings: {
          directoryMs: directoryDone - timingStart,
          directoryProgressWriteMs: directoryProgressDone - timingStart,
          directoryReadMs: directoryReadDone - directoryProgressDone,
          directoryNamesMs: directoryDone - directoryReadDone,
          workerRoundTripMs: workerDone - directoryDone,
          workerComputeMs: result.elapsedMs,
          workerQueueMs: result.workerTiming?.queueMs,
          workerResponseWaitMs: result.workerTiming?.responseWaitMs,
          workerUnpackMs: result.workerTiming?.unpackMs,
          calendarMs: calendarDone - workerDone,
          snapshotSaveMs: saveDone - calendarDone,
          snapshotProgressWriteMs: saveProgressDone - calendarDone,
          snapshotSerializeMs,
          snapshotBatchOtherMs:
            saveDone - saveProgressDone - snapshotSerializeMs,
          snapshotChangedRecords,
          cacheHit: result.cacheHit ?? false,
        },
        period,
        dataHealth,
        poolContext: result.poolContext,
        researchMode: history.asOf
          ? "historical"
          : history.requireCurrent
            ? "current"
            : "latest-local",
        requestedAsOf: history.asOf ?? null,
        universeSource: history.universeSource ?? "本次本地证券池",
        researchWarnings: history.asOf
          ? [
              "历史证券池由用户提供，尚未核验完整性；名称采用当前主档，不代表当时简称。",
              "行情不复权，企业行动和历史停复牌尚未核验；不接入晚于该日期的在线资料。",
            ]
          : [],
      };
    },
    { strategy, period, symbols: uniqueSymbols, config, ...history },
  );
}
