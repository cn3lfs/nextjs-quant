import { randomUUID } from "node:crypto";
import { z } from "zod";
import { strategyObjectSchema } from "trading-strategies";
import {
  alertHistorySchema,
  alertSubscriptionSchema,
} from "~/lib/strategy-facts/alerts";
import { AlertRepository } from "../../db/alert-repository";
import { createAlertPlanSchema, createAlertPlan } from "../../alerts/plans";
import { settings } from "../../infra/settings";
import {
  todayWorkspace,
  workspaceCandidates,
  workspaceCandidate,
} from "../../alerts/workspace";
import { alertKey, type AlertEvent } from "~/lib/strategy-facts/alerts";
import type { Snapshot } from "~/lib/domain";
import type { ShadowRegistration } from "../../alerts/shadow";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
import { loadAccountBook } from "../../portfolio/account-workspace-service";
import { AccountWorkspaceRepository } from "../../db/account-workspace-repository";
export const alertsRouter = createTRPCRouter({
  prepareScreenPlan: p("alerts", "configure")
    .input(
      z.object({
        jobId: z.string().min(1).max(200),
        snapshotId: z.string().min(1).max(200),
      }),
    )
    .mutation(({ input }) => {
      const repo = new AlertRepository();
      return repo.atomic(() => {
        const strategy = strategyObjectSchema.parse(
          repo.screenCandidate(input.jobId, input.snapshotId),
        );
        const snapshot = repo.records.read<Snapshot>(input.snapshotId);
        const bar = (
          snapshot?.rawBars ??
          (snapshot?.adjustment === "none" ? snapshot.bars : [])
        )?.at(-1);
        if (
          !snapshot ||
          !bar ||
          strategy.market !== "cn-equity" ||
          snapshot.period !== strategy.period ||
          !Number.isFinite(bar.close) ||
          bar.close <= 0
        )
          throw new Error("缺少冻结原价或策略身份，不能加入计划");
        const identity = {
          strategyId: strategy.id,
          version: strategy.version,
          market: strategy.market,
          symbol: snapshot.symbol,
          bar: bar.date,
        };
        const event: AlertEvent = {
          ...identity,
          key: alertKey(identity),
          type: "entry",
          price: bar.close,
          stop: null,
          target: null,
          sleeve: strategy.sleeve,
          observedAt: Date.now(),
          mode: "shadow",
          status: "shadow",
          reason: "用户从冻结公式候选准备交易计划；止损/目标由用户明确填写",
          source: `公式任务 ${input.jobId} · 快照 ${input.snapshotId}`,
          wouldSend: false,
          outcomes: [],
        };
        repo.record(strategy, event);
        return workspaceCandidate(repo.event(event.key)!, repo);
      });
    }),
  todayWorkspace: p("alerts", "read").query(() => todayWorkspace()),
  workspaceCandidates: p("alerts", "read")
    .input(
      z.object({
        page: z.number().int().nonnegative().max(1000000),
        strategy: z.string().max(150).optional(),
        market: z.enum(["cn-equity", "crypto"]).optional(),
        minimumRps: z.number().finite().min(0).max(100).optional(),
      }),
    )
    .query(({ input }) => workspaceCandidates(input)),
  workspaceCandidate: p("alerts", "read")
    .input(z.string().min(1).max(1000))
    .query(({ input }) => {
      const repo = new AlertRepository();
      const event = repo.event(input);
      if (!event || event.type !== "entry" || event.status === "missed")
        throw new Error("入场候选不存在");
      return workspaceCandidate(event, repo);
    }),
  alertStatus: p("alerts", "read").query(() => {
    const repo = new AlertRepository();
    return {
      mode: settings().alerts.mode,
      runtime:
        repo.state<{ lastCheck: number; lastPhase?: string; error?: string }>(
          "runtime",
        ) ?? null,
      strategies: repo.definitions().map((s) => ({
        ...s,
        live:
          repo.state<{ live: boolean }>(`strategy:${s.id}:${s.version}`)
            ?.live ?? false,
      })),
      subscriptions: repo.subscriptions(),
      gaps: repo.records
        .all<{ at: number; reason: string }>("alert-state")
        .filter((s) => s.reason)
        .slice(-20),
    };
  }),
  configureAlertStrategy: p("alerts", "configure")
    .input(
      z.object({
        strategy: strategyObjectSchema,
        live: z.boolean(),
        candidates: z.array(z.string().min(1).max(40)).max(6000).default([]),
      }),
    )
    .mutation(({ input }) => {
      const repo = new AlertRepository();
      return repo.atomic(() => {
        const strategy = repo.strategies.saveStrategy(input.strategy);
        repo.saveState(`strategy:${strategy.id}:${strategy.version}`, {
          live: input.live,
          revision: randomUUID(),
        });
        const shadowKey = `shadow:${strategy.id}:${strategy.version}`;
        const shadow = repo.state<ShadowRegistration>(shadowKey);
        if (input.live && shadow?.active)
          repo.saveState(shadowKey, { ...shadow, active: false });
        repo.saveState(
          `universe:${strategy.id}:${strategy.version}`,
          input.candidates,
        );
        return strategy;
      });
    }),
  saveAlertSubscription: p("alerts", "configure")
    .input(alertSubscriptionSchema)
    .mutation(({ input }) => {
      const repo = new AlertRepository();
      return repo.records.save(
        "alert-subscription",
        `alert-subscription:${input.id}`,
        { ...input, revision: randomUUID() },
      );
    }),
  alertHistory: p("alerts", "read")
    .input(alertHistorySchema)
    .query(({ input }) => new AlertRepository().history(input)),
  exportAlertHistory: p("alerts", "read")
    .input(alertHistorySchema)
    .mutation(({ input }) => ({
      basis:
        "观察日T，T+1开盘入场，T+5/10/20收盘；原价无成本滑点，非策略业绩；数字货币按UTC自然日",
      items: new AlertRepository().export(input),
    })),
  alertPlans: p("alerts", "read")
    .input(z.object({ page: z.number().int().nonnegative().default(0) }))
    .query(({ input }) => {
      const plans = new AlertRepository().plans();
      return {
        total: plans.length,
        items: plans.slice(input.page * 20, (input.page + 1) * 20),
      };
    }),
  createAlertPlan: p("alerts", "configure")
    .input(createAlertPlanSchema)
    .mutation(async ({ input }) => {
      const config = settings();
      const repo = new AccountWorkspaceRepository(),
        book = await loadAccountBook(repo, config);
      return createAlertPlan(
        input,
        config,
        Date.now(),
        new AlertRepository(repo.db),
        {
          positions: book.positions,
          industry: (symbol) => {
            const names = book.industryBySymbol.get(symbol) ?? [];
            return names.length === 1 ? names[0]! : "未知";
          },
          assertCurrent: () => repo.assertVersion(book.facts.version),
        },
      );
    }),
  cancelAlertPlan: p("alerts", "configure")
    .input(z.string().min(1).max(200))
    .mutation(({ input }) =>
      new AlertRepository().closePlan(input, "cancelled"),
    ),
  saveHoldingAlert: p("alerts", "configure")
    .input(
      z.object({
        market: z.enum(["cn-equity", "crypto"]),
        symbol: z.string().min(1).max(40),
        account: z.string().max(80).default(""),
        sleeve: z.string().min(1).max(80),
        stop: z.number().finite().positive().nullable(),
        target: z.number().finite().positive().nullable(),
        trailing: z.number().finite().positive().max(0.5).nullable(),
      }),
    )
    .mutation(({ input }) => {
      const repo = new AlertRepository();
      if (
        !settings().alerts.sleeves.some(
          (s) => s.id === input.sleeve && s.market === input.market,
        )
      )
        throw new Error("分仓不存在");
      const symbol =
        input.market === "crypto"
          ? `${input.account}:${input.symbol}`
          : input.symbol;
      return repo.atomic(() => {
        if (input.market === "cn-equity")
          repo.records.save("trade-stop", `trade-stop-${input.symbol}`, {
            stop: input.stop,
          });
        return repo.saveState(`protection:${input.market}:${symbol}`, {
          stop: input.stop,
          target: input.target,
          trailing: input.trailing,
          sleeve: input.sleeve,
        });
      });
    }),
  holdingAlert: p("alerts", "read")
    .input(
      z.object({
        market: z.enum(["cn-equity", "crypto"]),
        symbol: z.string().min(1).max(40),
        account: z.string().max(80).default(""),
      }),
    )
    .query(
      ({ input }) =>
        new AlertRepository().state<{
          stop: number | null;
          target: number | null;
          trailing: number | null;
          sleeve: string;
        }>(
          `protection:${input.market}:${input.market === "crypto" ? `${input.account}:` : ""}${input.symbol}`,
        ) ?? null,
    ),
});
