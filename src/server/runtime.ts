import { quickResearch } from "./quick-research";
import { scheduleSignalLedger } from "./signal-ledger-client";
import { scheduleRps } from "./rps-client";
import { NotificationPolicyStore } from "./notification-policy-store";
import { workProgress } from "~/lib/work-progress";
import { gfCalendarReference } from "./gf-calendar";
import { monitorCalendar } from "./monitor-calendar";
import { verifySecurityTradingStatus } from "./security-trading-status";
import { currentTradingStatus } from "~/lib/security-trading-status";
import { sameMonitorRun, sameMonitorBaseline } from "./monitor-run";
import { validateHistoricalScreen } from "~/lib/historical-screen";
import {
  backtestCostsSchema,
  defaultBacktestCosts,
  type BacktestCosts,
} from "~/lib/backtest-costs";
import {
  localCalendarReference,
  screenDataHealth,
  requireCurrentScreen,
} from "./data-health";
import { randomUUID } from "node:crypto";
import type {
  Monitor,
  Signal,
  Snapshot,
  Job,
  Coverage,
  Candidate,
  Report,
  Strategy,
  Period,
  Backtest,
} from "~/lib/domain";
import { put, get, list, atomic, putChangedBatch, sqlite } from "./db";
import { settings } from "./settings";
import { runWorker, background, recoverJobs, updateJob } from "./jobs";
import { metrics } from "./quant";
import { monitorStrategy } from "./monitor-strategy";
import { analyzeCzscSignal } from "./czsc-signal-analysis";
import { analyze, snapshotEvidence } from "./research";
import { enqueue, drain, recoverDeliveries } from "./notifications";
import { mcpProvider, gatherEvidence } from "./market-data";
import { acquireScheduler } from "./lease";
import type { ScreeningResult } from "./screening";
import { securityDirectory } from "./securities";
import { serializeSnapshot } from "./snapshot-serializer";
import { scheduleNews } from "./news-scheduler";
const scope = globalThis as typeof globalThis & {
  quantRuntime?: {
    started: boolean;
    ticking: boolean;
    lastTick: number;
    recovered: boolean;
  };
};
const state = (scope.quantRuntime ??= {
  started: false,
  ticking: false,
  lastTick: 0,
  recovered: false,
});
function schedulerLeader() {
  if (!acquireScheduler()) return false;
  if (!state.recovered) {
    recoverDeliveries();
    state.lastTick = 0;
    state.recovered = true;
  }
  return true;
}
export function startRuntime() {
  if (state.started) return;
  state.started = true;
  recoverJobs();
  const timer = setInterval(() => void tick().catch(() => {}), 60000),
    outbox = setInterval(() => {
      if (schedulerLeader()) void drain().catch(() => {});
    }, 3000);
  timer.unref();
  outbox.unref();
  void tick().catch(() => {});
}
export function freshCompleted(
  date: string,
  period: Period,
  now: number,
  calendar: string[],
) {
  const local = new Date(now + 8 * 3600000).toISOString(),
    today = local.slice(0, 10),
    minutes = Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
  if (!calendar.includes(today) || date.slice(0, 10) !== today) return false;
  if (period === "day") return minutes >= 15 * 60 + 5;
  const end = Date.parse(date);
  return (
    end <= now &&
    now - end <= 10 * 60000 &&
    ((minutes >= 575 && minutes <= 700) || (minutes >= 785 && minutes <= 910))
  );
}
export function transition(
  previous: { date: string; matched: boolean } | undefined,
  current: { date: string; matched: boolean },
  fresh: boolean,
  resuming: boolean,
) {
  return Boolean(
    previous &&
    previous.date < current.date &&
    !previous.matched &&
    current.matched &&
    fresh &&
    !resuming,
  );
}
export function scanJob() {
  return background("scan", {}, async (job) => {
    const result = await runWorker<Coverage>(
      { type: "scan", root: settings().tdxRoot },
      job.id,
    );
    put("coverage", "coverage", result);
    return { counts: result.counts, securities: result.securities.length };
  });
}
export async function snapshot(
  symbol: string,
  period: Period,
  source: "local" | "mcp" = "local",
) {
  const result =
    source === "mcp"
      ? await mcpProvider.history(symbol, period)
      : await runWorker<Snapshot>({
          type: "snapshot",
          root: settings().tdxRoot,
          symbol,
          period,
        });
  const existing = get<Snapshot>(result.id);
  if (!existing) put("snapshot", result.id, result);
  const profile = (await securityDirectory()).entries[symbol];
  return {
    ...(existing ?? result),
    name: profile?.name ?? result.name ?? existing?.name,
  };
}
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
export function backtestJob(
  snapshotId: string,
  strategy: Strategy,
  initial: number,
  scope: "full" | "window" = "full",
  costInput: BacktestCosts = defaultBacktestCosts,
) {
  const costs = backtestCostsSchema.parse(costInput);
  const selected = get<Snapshot>(snapshotId);
  if (!selected) throw new Error("数据快照不存在，请先加载行情");
  if (scope === "full" && selected.source !== "tdx-local")
    throw new Error("远端快照请选择窗口回测，不能冒充完整本地历史");
  const config = settings();
  return background(
    "backtest",
    {
      snapshotId,
      strategy,
      initial,
      scope,
      costs,
      root: selected.dataRoot ?? config.tdxRoot,
    },
    async (job, signal) => {
      updateJob(job.id, {
        phase:
          scope === "full" ? "读取完整历史并核对所选快照" : "计算快照窗口回测",
      });
      const { result, source } = await runWorker<{
        result: Backtest;
        source: Snapshot;
      }>(
        {
          type: "backtest",
          costs,
          snapshot: selected,
          strategy,
          initial,
          fullRoot:
            scope === "full"
              ? (selected.dataRoot ?? config.tdxRoot)
              : undefined,
        },
        job.id,
      );
      if (signal.aborted) throw new Error("已取消");
      put("snapshot", source.id, source);
      if (config.autoAnalysis)
        background("research", { contextId: job.id }, async (_, abort) =>
          analyze(
            job.id,
            "解释这次研究模拟的结果、回撤和局限。所有数字直接引用结果，不重新计算。",
            [
              {
                id: job.id,
                source: "本机确定性回测引擎",
                asOf: source.bars.at(-1)!.date,
                text: JSON.stringify({
                  ...result,
                  equity: result.equity.filter(
                    (_, i) =>
                      i % Math.max(1, Math.floor(result.equity.length / 30)) ===
                      0,
                  ),
                  trades: result.trades.slice(-30),
                }),
              },
            ],
            abort,
          ),
        );
      return result;
    },
  );
}
export async function tick() {
  if (!schedulerLeader()) return;
  scheduleSignalLedger(Date.now());
  scheduleRps(Date.now());
  scheduleNews();
  if (state.ticking) return;
  state.ticking = true;
  const now = Date.now(),
    resuming = !state.lastTick || now - state.lastTick > 120000;
  state.lastTick = now;
  try {
    const monitors = list<Monitor>("monitor").filter((m) => m.enabled);
    if (!monitors.length) return;
    const config = settings();
    const reference = await monitorCalendar(
      config.tdxRoot,
      config.calendar,
      monitors.some((m) => m.source === "mcp"),
      monitors.every((m) =>
        m.symbols.every((symbol) => /^(sh|sz)/.test(symbol)),
      ),
      now,
    );
    const calendar = reference.days;
    new NotificationPolicyStore(sqlite()).calendar(
      calendar,
      reference.source,
      now,
    );
    const calendarEvidence = {
      source: reference.source,
      hash: reference.hash,
      assessedAt: now,
    };
    for (const monitor of monitors) {
      const updated = {
        ...monitor,
        states: { ...monitor.states },
        tradingStatusChecks: { ...monitor.tradingStatusChecks },
        lastCheck: now,
        error: undefined as string | undefined,
      };
      for (const symbol of monitor.symbols) {
        try {
          if (
            ["czsc", "dual-breakout"].includes(monitor.strategy.type ?? "") &&
            monitor.period !== "day"
          ) {
            updated.error = "缠论/双突破监控仅支持日线";
            continue;
          }
          const source = await snapshot(
            symbol,
            monitor.period,
            monitor.source ?? "local",
          );
          const local = new Date(now + 8 * 3600000).toISOString();
          const completed = source.bars.filter((b) =>
            monitor.period === "5m"
              ? Date.parse(b.date) <= now
              : b.date < local.slice(0, 10) ||
                (b.date === local.slice(0, 10) &&
                  local.slice(11, 16) >= "15:05"),
          );
          const evaluated = await monitorStrategy(
            completed,
            monitor.strategy,
            monitor.states[symbol],
          );
          const value = evaluated.value;
          if (!value) continue;
          const previous = evaluated.previous,
            current = {
              date: value.date,
              matched: value.matched,
              ...(evaluated.keys ? { signalKeys: evaluated.keys } : {}),
            };
          const live = get<Monitor>(monitor.id);
          if (
            !sameMonitorRun(monitor, live) ||
            !sameMonitorBaseline(monitor, live)
          )
            break;
          if (
            transition(
              previous,
              current,
              freshCompleted(value.date, monitor.period, now, calendar),
              resuming,
            )
          ) {
            const id = `signal-${monitor.id}-${symbol}-${value.date.replace(/[^\d]/g, "")}`;
            if (!get(id)) {
              let tradingStatusEvidence;
              try {
                tradingStatusEvidence =
                  await verifySecurityTradingStatus(symbol);
                updated.tradingStatusChecks[symbol] = tradingStatusEvidence;
              } catch {
                updated.error = `${symbol} 交易状态核验失败，已暂停该证券新信号；请检查问财连接`;
                continue;
              }
              const checkedAt = Date.now();
              const latest = get<Monitor>(monitor.id);
              if (
                !sameMonitorRun(monitor, latest) ||
                !sameMonitorBaseline(monitor, latest)
              )
                break;
              if (
                !currentTradingStatus(tradingStatusEvidence, symbol, checkedAt)
              ) {
                updated.error = `${symbol} 交易状态未通过：${tradingStatusEvidence.reason}；已暂停该证券新信号`;
                continue;
              }
              if (
                !freshCompleted(value.date, monitor.period, checkedAt, calendar)
              ) {
                updated.error = `${symbol} 核验完成时行情已过期，等待新的已完成行情`;
                continue;
              }
              const signal: Signal = {
                id,
                monitorId: monitor.id,
                monitorRun: {
                  createdAt: monitor.createdAt,
                  revision: monitor.revision ?? null,
                },
                symbol,
                strategy: monitor.strategy,
                period: monitor.period,
                date: value.date,
                createdAt: checkedAt,
                expiresAt:
                  checkedAt + (monitor.period === "day" ? 86400000 : 600000),
                metrics: value,
                ...(evaluated.details ? { czsc: evaluated.details } : {}),
                ...(evaluated.breakout ? { breakout: evaluated.breakout } : {}),
                snapshotId: source.id,
                source: source.source,
                calendarEvidence,
                tradingStatusEvidence,
              };
              const committed = atomic(() => {
                const active = get<Monitor>(monitor.id);
                const commitTime = Date.now();
                if (
                  !sameMonitorRun(monitor, active) ||
                  !sameMonitorBaseline(monitor, active) ||
                  get(id) ||
                  !currentTradingStatus(
                    tradingStatusEvidence,
                    symbol,
                    commitTime,
                  ) ||
                  !freshCompleted(
                    value.date,
                    monitor.period,
                    commitTime,
                    calendar,
                  )
                )
                  return null;
                put("signal", id, signal);
                enqueue(signal, active.channels, "signal");
                return active;
              });
              if (!committed) break;
              if (committed.ai)
                background("research", { signalId: id }, async (_, abort) => {
                  const report = signal.czsc
                    ? await analyzeCzscSignal(signal, abort)
                    : await analyze(
                        id,
                        "简短解读此规则信号，指出风险及观察条件，不把信号当作已执行交易。",
                        await gatherEvidence(
                          { ...source, bars: completed },
                          monitor.strategy,
                          abort,
                        ),
                        abort,
                      );
                  atomic(() => {
                    const latest = get<Monitor>(monitor.id);
                    if (sameMonitorRun(monitor, latest) && latest.ai)
                      enqueue(signal, latest.channels, "analysis", report);
                  });
                  return report;
                });
            }
          }
          updated.states[symbol] = current;
          if (!calendar.length)
            updated.error = "交易日历不可用，已暂停新信号推送";
          else if (!freshCompleted(value.date, monitor.period, now, calendar))
            updated.error = "等待本交易日已完成行情；旧数据不会推送";
        } catch {
          updated.error = `${symbol} 数据读取失败，请检查本地数据`;
        }
      }
      // Preserve edits made while awaiting I/O, including disabling the subscription.
      atomic(() => {
        const latest = get<Monitor>(monitor.id);
        if (
          !sameMonitorRun(monitor, latest) ||
          !sameMonitorBaseline(monitor, latest)
        )
          return;
        put("monitor", monitor.id, {
          ...latest,
          states: updated.states,
          tradingStatusChecks: updated.tradingStatusChecks,
          lastCheck: updated.lastCheck,
          calendarEvidence,
          error: updated.error,
        });
      });
    }
  } finally {
    state.ticking = false;
  }
}
