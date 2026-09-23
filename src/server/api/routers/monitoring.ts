import { marketSourceSchema } from "~/lib/market/market-source";
import { intradayConfigSchema } from "~/lib/strategy-facts/intraday-schedule";
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
  intradayRun: p.mutation(() => {
    void scheduleIntraday(Date.now(), true);
    return intradayWorkerStatus();
  }),
  saveChannel: p.input(z.unknown()).mutation(({ input }) => saveChannel(input)),
  testChannel: p.input(z.string()).mutation(({ input }) => testDelivery(input)),
  deliveries: p.query(() => list<Delivery>("delivery", 200)),
  retryDelivery: p.input(z.string()).mutation(({ input }) => {
    const d = recordOfKind<Delivery>("delivery", input);
    if (!d) throw new Error("投递不存在");
    const id = `manual-${randomUUID()}`;
    return put("delivery", id, {
      ...d,
      id,
      body: `【手动重发历史通知】\n${d.body}`,
      manualRetry: true,
      remoteId: undefined,
      error: undefined,
      status: "pending",
      attempts: 0,
      nextAt: Date.now(),
      expiresAt: Date.now() + 600000,
      createdAt: Date.now(),
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
