import {
  monitorSaveSchema,
  monitorToggleSchema,
  deliveryConfirmSchema,
} from "~/lib/strategy-facts/monitor-workspace-actions";
import {
  saveWorkspaceMonitor,
  toggleWorkspaceMonitor,
  confirmWorkspaceDelivery,
  monitorConfigurationVersion,
} from "../../monitoring/monitor-workspace-actions";
import {
  monitorPageSchema,
  signalPageSchema,
  deliveryPageSchema,
  monitorWorkspaceId,
} from "~/lib/strategy-facts/monitor-workspace";
import {
  monitorWorkspacePage,
  signalWorkspacePage,
  deliveryWorkspacePage,
  monitorWorkspaceSummary,
  monitorWorkspaceExport,
  monitorWorkspaceDetail,
  signalWorkspaceDetail,
  deliveryWorkspaceDetail,
} from "../../monitoring/monitor-workspace-query";
import { marketSourceSchema } from "~/lib/market/market-source";
import { localCalendarReference } from "../../market/data-health";
import { settings } from "../../infra/settings";
import {
  ledgerHistorySchema,
  ledgerRunsSchema,
  ledgerDecisionsSchema,
  ledgerDateSchema,
  ledgerIdSchema,
} from "~/lib/strategy-facts/signal-ledger-query";
import {
  ledgerHistory,
  ledgerSummary,
  ledgerDetail,
  ledgerRuns,
  ledgerDecisions,
  ledgerAnalysis,
} from "../../monitoring/signal-ledger-query";
import { SignalLedgerStore } from "../../monitoring/signal-ledger-store";
import type { NotificationDecision } from "~/lib/strategy-facts/notification-policy";
import {
  intradayConfigSchema,
  intradaySchedule,
} from "~/lib/strategy-facts/intraday-schedule";
import {
  intradayHistorySchema,
  intradayRunsSchema,
} from "~/lib/strategy-facts/intraday-history";
import {
  intradayHistory,
  intradayRuns,
} from "../../monitoring/intraday-history";
import type { IntradayRun } from "../../monitoring/intraday-job";
import {
  intradayConfig,
  intradayLastCheck,
  saveIntradayConfig,
  intradayDependencies,
} from "../../monitoring/intraday-service";
import {
  intradayWorkerStatus,
  scheduleIntraday,
} from "../../monitoring/intraday-client";
import { IntradayStore } from "../../monitoring/intraday-store";
import { IntradayJob } from "../../monitoring/intraday-job";
import { sqlite as chartSqlite } from "../../db";
import { analyzeCzsc } from "../../strategies/chan/czsc";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  strategySchema,
  symbolSchema,
  periodSchema,
  type Channel,
  type Monitor,
  type Delivery,
  type Signal,
} from "~/lib/domain";
import { list, put } from "../../db";
import { saveChannel, testDelivery } from "../../infra/notifications";
import { createTRPCRouter, publicProcedure as p } from "../trpc";
function recordOfKind<T>(kind: string, id: string): T | undefined {
  const row = chartSqlite()
    .prepare("SELECT payload FROM records WHERE kind=? AND id=?")
    .get(kind, id) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as T) : undefined;
}
export const monitoringRouter = createTRPCRouter({
  monitorWorkspaceSave: p.input(monitorSaveSchema).mutation(({ input }) => {
    const value = saveWorkspaceMonitor(chartSqlite(), input);
    return {
      ...value,
      configurationVersion: monitorConfigurationVersion(value),
    };
  }),
  monitorWorkspaceToggle: p
    .input(monitorToggleSchema)
    .mutation(({ input }) => toggleWorkspaceMonitor(chartSqlite(), input)),
  deliveryWorkspaceConfirm: p
    .input(deliveryConfirmSchema)
    .mutation(({ input }) => confirmWorkspaceDelivery(chartSqlite(), input)),
  monitorWorkspaceExport: p
    .input(
      z.object({
        kind: z.enum(["monitor", "signal", "delivery"]),
        id: monitorWorkspaceId,
      }),
    )
    .query(({ input }) =>
      monitorWorkspaceExport(chartSqlite(), input.kind, input.id),
    ),
  monitorWorkspaceSummary: p.query(() =>
    monitorWorkspaceSummary(chartSqlite()),
  ),
  monitorWorkspacePage: p
    .input(monitorPageSchema)
    .query(({ input }) => monitorWorkspacePage(chartSqlite(), input)),
  signalWorkspacePage: p
    .input(signalPageSchema)
    .query(({ input }) => signalWorkspacePage(chartSqlite(), input)),
  deliveryWorkspacePage: p
    .input(deliveryPageSchema)
    .query(({ input }) => deliveryWorkspacePage(chartSqlite(), input)),
  monitorWorkspaceDetail: p
    .input(monitorWorkspaceId)
    .query(({ input }) => monitorWorkspaceDetail(chartSqlite(), input)),
  signalWorkspaceDetail: p
    .input(monitorWorkspaceId)
    .query(({ input }) => signalWorkspaceDetail(chartSqlite(), input)),
  deliveryWorkspaceDetail: p
    .input(monitorWorkspaceId)
    .query(({ input }) => deliveryWorkspaceDetail(chartSqlite(), input)),
  ledgerCalendar: p.query(async () => {
    const config = settings();
    const reference = await localCalendarReference(
      config.tdxRoot,
      config.calendar,
    );
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const days = [...new Set(reference.days)]
      .filter((day) => ledgerDateSchema.safeParse(day).success && day <= today)
      .sort()
      .slice(-30);
    return {
      from: days.length === 30 ? days[0]! : null,
      to: days.length === 30 ? days.at(-1)! : null,
      source: reference.source,
    };
  }),
  ledgerSummary: p.query(() => ledgerSummary(chartSqlite())),
  ledgerHistory: p
    .input(ledgerHistorySchema)
    .query(({ input }) => ledgerHistory(chartSqlite(), input)),
  ledgerDetail: p
    .input(ledgerIdSchema)
    .query(({ input }) => ledgerDetail(chartSqlite(), input)),
  ledgerRuns: p
    .input(ledgerRunsSchema)
    .query(({ input }) => ledgerRuns(chartSqlite(), input)),
  ledgerRunDetail: p.input(ledgerDateSchema).query(({ input }) => {
    const run = new SignalLedgerStore(chartSqlite()).run(input);
    if (!run) throw new Error("台账任务不存在");
    return run;
  }),
  ledgerDecisions: p
    .input(ledgerDecisionsSchema)
    .query(({ input }) => ledgerDecisions(chartSqlite(), input)),
  ledgerDecisionDetail: p.input(ledgerIdSchema).query(({ input }) => {
    const decision = recordOfKind<NotificationDecision>(
      "notification-decision",
      input,
    );
    if (!decision) throw new Error("投递决策不存在");
    return decision;
  }),
  ledgerAnalysis: p.query(() => ledgerAnalysis(chartSqlite())),
  intradayRuns: p
    .input(intradayRunsSchema)
    .query(({ input }) => intradayRuns(chartSqlite(), input)),
  intradayRunDetail: p
    .input(z.string().regex(/^intraday-run:[a-f0-9]{64}$/))
    .query(({ input }) => {
      const run = recordOfKind<IntradayRun>("intraday-run", input);
      if (!run) throw new Error("预选批次不存在");
      return run;
    }),
  intradaySummary: p.query(() => ({
    config: intradayConfig(),
    lastCheck: intradayLastCheck(),
    worker: intradayWorkerStatus(),
  })),
  intradayStorage: p.query(() => new IntradayStore(chartSqlite()).usage()),
  intradayHistory: p
    .input(intradayHistorySchema)
    .query(({ input }) => intradayHistory(chartSqlite(), input)),
  intradayStatus: p
    .input(z.object({ offset: z.number().int().min(0).default(0) }))
    .query(({ input }) => {
      const store = new IntradayStore(chartSqlite());
      const job = new IntradayJob(
        store,
        intradayDependencies((bars) => analyzeCzsc(bars, true)),
      );
      return {
        config: intradayConfig(),
        storage: store.usage(),
        lastCheck: intradayLastCheck(),
        worker: intradayWorkerStatus(),
        runs: job.runs(),
        rows: store.page(input.offset).map((row) => ({
          ...row,
          value: {
            ...row.value,
            snapshot: { ...row.value.snapshot, bars: undefined },
          },
          attempts: row.attempts.map((attempt) => ({
            ...attempt,
            close: { ...attempt.close, snapshot: undefined },
          })),
        })),
      };
    }),
  intradayExport: p
    .input(z.string().regex(/^intraday-preview:[a-f0-9]{64}$/))
    .query(({ input }) => {
      const store = new IntradayStore(chartSqlite());
      const observation = store.observation(input);
      if (!observation) throw new Error("预选记录不存在");
      return {
        schemaVersion: 1,
        observation,
        attempts: store.attempts(input),
        run: recordOfKind("intraday-run", observation.sessionId),
      };
    }),
  intradaySave: p
    .input(intradayConfigSchema)
    .mutation(({ input }) => saveIntradayConfig(input)),
  intradayRemove: p
    .input(z.string().regex(/^intraday-preview:[a-f0-9]{64}$/))
    .mutation(({ input }) => {
      if (intradayWorkerStatus().running)
        throw new Error("任务仍在执行，请完成后清理");
      new IntradayStore(chartSqlite()).remove(input);
      return { removed: true };
    }),
  intradayRun: p.mutation(async () => {
    if (intradayWorkerStatus().running) return { outcome: "running" as const };
    const config = intradayConfig();
    if (!config.enabled) return { outcome: "disabled" as const };
    const dependencies = intradayDependencies((bars) =>
      analyzeCzsc(bars, true),
    );
    const calendar = await dependencies.calendar();
    const now = Date.now();
    const schedule = intradaySchedule(config, now, calendar);
    if (schedule.trading !== "open") return { outcome: schedule.trading };
    if (!schedule.previousTradingDay) return { outcome: "unknown" as const };
    const due = schedule.slots.some((slot) => slot.status === "due");
    const missed = schedule.slots.some((slot) => slot.status === "missed");
    if (!due && !missed && !schedule.closeDue)
      return { outcome: "pending" as const };
    if (intradayWorkerStatus().running) return { outcome: "running" as const };
    void scheduleIntraday(now, true);
    return {
      outcome: due
        ? ("started" as const)
        : schedule.closeDue
          ? ("confirming" as const)
          : ("missed" as const),
    };
  }),
  saveChannel: p.input(z.unknown()).mutation(({ input }) => saveChannel(input)),
  testChannel: p.input(z.string()).mutation(({ input }) => testDelivery(input)),
  deliveries: p.query(() => list<Delivery>("delivery", 200)),
  retryDelivery: p.input(z.string()).mutation(({ input }) => {
    const original = deliveryWorkspaceDetail(chartSqlite(), input);
    if (!original) throw new Error("投递不存在");
    if (!original.channel) throw new Error("通知渠道不存在");
    return confirmWorkspaceDelivery(chartSqlite(), {
      deliveryId: input,
      requestId: randomUUID(),
      expectedChannelVersion: original.channel.destinationVersion,
    });
  }),
  monitors: p.query(() => list<Monitor>("monitor")),
  saveMonitor: p
    .input(
      z.object({
        id: z.string().optional(),
        name: z.string().min(1).max(80),
        symbols: z.array(symbolSchema).min(1).max(20),
        strategy: strategySchema,
        period: periodSchema,
        source: marketSourceSchema.default("local"),
        channels: z.array(z.string()).max(20),
        ai: z.boolean(),
        enabled: z.boolean(),
      }),
    )
    .mutation(({ input }) => {
      if (
        ["czsc", "dual-breakout"].includes(input.strategy.type ?? "") &&
        input.period !== "day"
      )
        throw new Error("缠论/双突破监控仅支持日线");
      for (const id of input.channels)
        if (!recordOfKind<Channel>("channel", id))
          throw new Error("通知渠道不存在");
      if (
        input.id &&
        chartSqlite()
          .prepare("SELECT id FROM records WHERE id=? AND kind<>'monitor'")
          .get(input.id)
      )
        throw new Error("不能覆盖其他类型记录");
      const id = input.id ?? `monitor-${randomUUID()}`;
      return put<Monitor>("monitor", id, {
        ...input,
        id,
        states: {},
        revision: randomUUID(),
        createdAt: Date.now(),
      });
    }),
  toggleMonitor: p
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(({ input }) => {
      const m = recordOfKind<Monitor>("monitor", input.id);
      if (!m) throw new Error("监控不存在");
      return put("monitor", m.id, {
        ...m,
        enabled: input.enabled,
        states: {},
        revision: randomUUID(),
      });
    }),
  signals: p.query(() => list<Signal>("signal", 100)),
});
