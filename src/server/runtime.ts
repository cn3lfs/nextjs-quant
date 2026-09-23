import { isMarketIndex } from "~/lib/market/market-indices";
import { scheduleSignalLedger } from "./monitoring/signal-ledger-client";
import { scheduleRps } from "./screening/rps-client";
import { scheduleIntraday } from "./monitoring/intraday-client";
import { scheduleClsReview } from "./news/cls-review-scheduler";
import { NotificationPolicyStore } from "./infra/notification-policy-store";
import { monitorCalendar } from "./monitoring/monitor-calendar";
import { verifySecurityTradingStatus } from "./market/security-trading-status";
import { currentTradingStatus } from "~/lib/market/security-trading-status";
import { sameMonitorRun, sameMonitorBaseline } from "./monitoring/monitor-run";
import { randomUUID } from "node:crypto";
import type {
  Monitor,
  Signal,
  Job,
  Coverage,
  Period,
} from "~/lib/domain";
import { put, get, list, atomic, sqlite } from "./db";
import { settings } from "./infra/settings";
import { runWorker, background, recoverJobs, updateJob } from "./jobs/jobs";
import { metrics } from "~/lib/screening/screening-metrics";
import { monitorStrategy } from "./monitoring/monitor-strategy";
import { analyzeCzscSignal } from "./strategies/chan/czsc-signal-analysis";
import { analyze, snapshotEvidence } from "./research/research";
import { enqueue, drain, recoverDeliveries } from "./infra/notifications";
import { gatherEvidence } from "./research/gather-evidence";
import { acquireScheduler } from "./infra/lease";
import { scheduleNews } from "./news/news-scheduler";
import { snapshot } from "./market/snapshot";
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
export async function tick() {
  if (!schedulerLeader()) return;
  scheduleSignalLedger(Date.now());
  scheduleRps(Date.now());
  scheduleIntraday(Date.now());
  scheduleClsReview();
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
      monitors.some((m) => m.source !== "local" && m.source !== "mcp"),
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
