import { randomUUID } from "node:crypto";
import { z } from "zod";
import { strategyObjectSchema } from "trading-strategies";
import {
  alertHistorySchema,
  alertSubscriptionSchema,
} from "~/lib/strategy-facts/alerts";
import { AlertRepository } from "../../db/alert-repository";
import {
  createAlertPlanSchema,
  createAlertPlan,
  storedCandidateEligibility,
} from "../../alerts/plans";
import { settings } from "../../infra/settings";
import {
  todayWorkspace,
  workspaceCandidates,
  workspaceCandidate,
} from "../../alerts/workspace";
import { equityDailyReadiness } from "../../alerts/readiness";
import { alertKey, type AlertEvent } from "~/lib/strategy-facts/alerts";
import type { Snapshot } from "~/lib/domain";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
import { loadAccountBook } from "../../portfolio/account-workspace-service";
import { AccountWorkspaceRepository } from "../../db/account-workspace-repository";
import { cryptoRiskSummary } from "../../crypto-trading/risk-summary";
import { planCorrelation } from "../../portfolio/plan-correlation";
/** One versioned account read per request, shared by all candidate sources. */
async function planAccountContext(localOnly: boolean) {
  const config = settings(),
    now = Date.now();
  const accounts = new AccountWorkspaceRepository();
  const book = await loadAccountBook(accounts, config, now, { localOnly });
  return {
    config,
    now,
    book,
    repo: new AlertRepository(accounts.db),
    assertCurrent: () => accounts.assertVersion(book.facts.version),
  };
}
export const alertsRouter = createTRPCRouter({
  planCorrelation: p("portfolio", "read")
    .input(z.string().min(1).max(1000))
    .query(({ input }) => planCorrelation(input, settings())),
  cryptoRiskSummary: p("cryptoSimulation", "read").query(() =>
    cryptoRiskSummary(),
  ),
  prepareScreenPlan: p("alerts", "configure")
    .input(
      z.object({
        jobId: z.string().min(1).max(200),
        snapshotId: z.string().min(1).max(200),
      }),
    )
    .mutation(async ({ input }) => {
      const { repo, book, now, assertCurrent } = await planAccountContext(true);
      return repo.atomic(() => {
        assertCurrent();
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
          type: "entry" as const,
          price: bar.close,
          strategyId: strategy.id,
          version: strategy.version,
          market: strategy.market,
          symbol: snapshot.symbol,
          bar: bar.date,
        };
        const signalBar = snapshot.bars.at(-1);
        if (
          signalBar?.date !== bar.date ||
          !Number.isFinite(signalBar.close) ||
          signalBar.close <= 0
        )
          throw new Error("快照信号价与原价日期不一致");
        const event: AlertEvent & {
          signalPrice: number;
          signalPriceBasis: Snapshot["adjustment"];
          executionRawPrice: number;
        } = {
          ...identity,
          key: alertKey(identity),
          executionRawPrice: bar.close,
          signalPrice: signalBar.close,
          signalPriceBasis: snapshot.adjustment,
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
        const saved = repo.event(event.key)!;
        return {
          ...workspaceCandidate(saved, repo, now, book.positions),
          ...storedCandidateEligibility(saved, repo),
        };
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
        // Today pins pagination to its original close. Scan uses the local reference.
        scanCloseDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
      }),
    )
    .query(async ({ input }) => {
      const { config, repo, book, now, assertCurrent } =
        await planAccountContext(true);
      const readiness = await equityDailyReadiness(config, now);
      const scan = {
        closeDate:
          input.scanCloseDate === undefined ||
          input.scanCloseDate === readiness.expectedDate
            ? readiness.expectedDate
            : null,
        calendar: readiness.calendar,
      };
      const result = workspaceCandidates(
        input,
        repo,
        now,
        book.positions,
        scan,
      );
      assertCurrent();
      return result;
    }),
  workspaceCandidate: p("alerts", "read")
    .input(z.string().min(1).max(1000))
    .query(async ({ input }) => {
      const { config, repo, book, now, assertCurrent } =
        await planAccountContext(true);
      const event = repo.event(input);
      if (!event || event.type !== "entry" || event.status === "missed")
        throw new Error("入场候选不存在");
      const readiness =
        event.market === "cn-equity"
          ? await equityDailyReadiness(config, now)
          : null;
      const result = {
        ...workspaceCandidate(event, repo, now, book.positions),
        ...storedCandidateEligibility(
          event,
          repo,
          readiness
            ? {
                closeDate: readiness.expectedDate,
                calendar: readiness.calendar,
              }
            : undefined,
        ),
      };
      assertCurrent();
      return result;
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
    .input(
      z.object({
        page: z.number().int().nonnegative().default(0),
        id: z.string().min(1).max(200).optional(),
      }),
    )
    .query(({ input }) => {
      const repo = new AlertRepository();
      const selected = input.id ? repo.strategies.plan(input.id) : null;
      const plans = input.id ? (selected ? [selected] : []) : repo.plans();
      return {
        total: plans.length,
        items: plans.slice(input.page * 20, (input.page + 1) * 20),
      };
    }),
  createAlertPlan: p("alerts", "configure")
    .input(createAlertPlanSchema)
    .mutation(async ({ input }) => {
      const { config, repo, book, now, assertCurrent } =
        await planAccountContext(false);
      const readiness =
        repo.event(input.eventKey)?.market === "cn-equity"
          ? await equityDailyReadiness(config, now)
          : null;
      return createAlertPlan(input, config, now, repo, {
        closeReference: readiness
          ? { closeDate: readiness.expectedDate, calendar: readiness.calendar }
          : undefined,
        positions: book.positions,
        industryGroups: (symbol) => book.industryBySymbol.get(symbol) ?? [],
        industrySource: book.industrySource,
        assertCurrent,
      });
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
