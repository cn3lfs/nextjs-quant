import { TRPCError } from "@trpc/server";
import {
  deployableStrategySpecSchema,
  deploymentMarkets,
  deploymentProvenanceSchema,
  deploymentRiskPolicySchema,
  deploymentScheduleSchema,
  deploymentStatuses,
  executionModes,
  isExecutionModeCompatibleWithVenue,
  poolPolicySchema,
  regimeGateSpecSchema,
  universeSpecSchema,
  venueBindingSchema,
} from "trading-strategies";
import { z } from "zod";
import { sqlite } from "../../db";
import { AccountWorkspaceRepository } from "../../db/account-workspace-repository";
import {
  createDeployment,
  getDeployment,
  getPipelineGlobalConfig,
  listDeployments,
  setGlobalAutoLiveEnabled,
  setGlobalAutoSimEnabled,
  updateDeploymentConfig,
  updateDeploymentMode,
  updateDeploymentStatus,
  type DeploymentRecord,
} from "../../db/deployment-repository";
import {
  findPipelineRun,
  getIntent,
  getPipelineRun,
  listExecutionAuditEvents,
  listIntentsByRun,
  listPipelineRuns,
  transitionIntentStatus,
} from "../../db/pipeline-repository";
import {
  getActivePoolEntries,
  listPoolEntries,
  manualAddPoolEntry,
  manualEvictPoolEntry,
} from "../../db/pool-repository";
import {
  approveAndExecuteIntent,
  executePipelineRun,
  reconcilePendingIntents,
} from "../../execution/pipeline-executor";
import { resolveVenueAdapter } from "../../execution/venue-router";
import {
  runPipelinePlanning,
  type PipelinePlanningDeps,
} from "../../pipeline/signal-risk-runner";
import { capabilityProcedure as p, createTRPCRouter } from "../trpc";

const idSchema = z.string().trim().min(1);
const dateSchema = z.string().date();
const cursorSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const timestampSchema = z.number().int().safe().nonnegative();
const pageLimitSchema = z.number().int().min(1).max(1000).default(50);

const deploymentCursorSchema = z
  .object({ updatedAt: timestampSchema, id: idSchema })
  .strict();
const runCursorSchema = z
  .object({
    decisionDate: dateSchema,
    startedAt: timestampSchema,
    id: idSchema,
  })
  .strict();

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor<T>(schema: z.ZodType<T>, value: string): T {
  return schema.parse(
    JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
  );
}

const beijingDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function beijingToday(now: number = Date.now()): string {
  const parts = beijingDate.formatToParts(new Date(now));
  const pick = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

const deploymentCreateSchema = z
  .object({
    id: idSchema.optional(),
    name: z.string().trim().min(1),
    market: z.enum(deploymentMarkets),
    status: z.enum(["draft", "active"]).default("draft"),
    executionMode: z.enum(executionModes).default("shadow"),
    strategySpec: deployableStrategySpecSchema,
    universeSpec: universeSpecSchema,
    regimeGate: regimeGateSpecSchema,
    riskPolicy: deploymentRiskPolicySchema,
    venueBinding: venueBindingSchema,
    poolPolicy: poolPolicySchema.default({}),
    schedule: deploymentScheduleSchema,
    provenance: deploymentProvenanceSchema,
  })
  .strict();

const deploymentConfigPatchSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    strategySpec: deployableStrategySpecSchema.optional(),
    universeSpec: universeSpecSchema.optional(),
    regimeGate: regimeGateSpecSchema.optional(),
    riskPolicy: deploymentRiskPolicySchema.optional(),
    venueBinding: venueBindingSchema.optional(),
    poolPolicy: poolPolicySchema.optional(),
    schedule: deploymentScheduleSchema.optional(),
    provenance: deploymentProvenanceSchema.optional(),
  })
  .strict();

const liveConfirmationPhrase = "ENABLE_LIVE_TRADING";

function nextCnWeekday(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

const pipelineStageSchema = z.enum([
  "universe",
  "signals",
  "risk",
  "execute",
  "reconcile",
  "full",
]);

function requireDeploymentOrThrow(
  id: string,
  db: ReturnType<typeof sqlite>,
): DeploymentRecord {
  const deployment = getDeployment(id, db);
  if (!deployment)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `策略部署不存在：${id}`,
    });
  return deployment;
}

export const pipelineRouter = createTRPCRouter({
  pipelineGlobalConfig: p("portfolio", "read").query(() =>
    getPipelineGlobalConfig(sqlite()),
  ),
  pipelineSetGlobalAutoSim: p("portfolio", "configure")
    .input(z.object({ enabled: z.boolean() }).strict())
    .mutation(({ input }) => setGlobalAutoSimEnabled(input.enabled, sqlite())),
  pipelineSetGlobalAutoLive: p("portfolio", "configure")
    .input(
      z
        .object({
          enabled: z.boolean(),
          confirmationPhrase: z.string().optional(),
        })
        .strict(),
    )
    .mutation(({ input }) => {
      if (input.enabled && input.confirmationPhrase !== liveConfirmationPhrase)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "开启实盘自动执行必须输入确认短语 ENABLE_LIVE_TRADING",
        });
      return setGlobalAutoLiveEnabled(input.enabled, sqlite());
    }),
  deploymentList: p("portfolio", "read")
    .input(
      z
        .object({
          status: z.enum(deploymentStatuses).optional(),
          market: z.enum(deploymentMarkets).optional(),
          limit: pageLimitSchema,
          cursor: cursorSchema.optional(),
        })
        .strict(),
    )
    .query(({ input }) => {
      const db = sqlite();
      const after = input.cursor
        ? decodeCursor(deploymentCursorSchema, input.cursor)
        : undefined;
      const page = listDeployments(
        {
          status: input.status,
          market: input.market,
          limit: input.limit,
          ...(after ? { after } : {}),
        },
        db,
      );
      return {
        items: page.items.map((deployment) => ({
          ...deployment,
          activePoolCount: getActivePoolEntries(deployment.id, db).length,
          latestRun:
            listPipelineRuns({ deploymentId: deployment.id, limit: 1 }, db)
              .items[0] ?? null,
        })),
        nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      };
    }),
  deploymentGet: p("portfolio", "read")
    .input(z.object({ id: idSchema }).strict())
    .query(({ input }) => {
      const db = sqlite();
      const deployment = requireDeploymentOrThrow(input.id, db);
      return {
        deployment,
        activePool: getActivePoolEntries(deployment.id, db),
        runs: listPipelineRuns({ deploymentId: deployment.id, limit: 10 }, db)
          .items,
      };
    }),
  deploymentCreate: p("portfolio", "configure")
    .input(deploymentCreateSchema)
    .mutation(({ input }) => createDeployment(input, sqlite())),
  deploymentUpdateMode: p("portfolio", "configure")
    .input(
      z
        .object({
          id: idSchema,
          status: z.enum(deploymentStatuses).optional(),
          executionMode: z.enum(executionModes).optional(),
          pauseReason: z.string().trim().min(1).optional(),
        })
        .strict(),
    )
    .mutation(({ input }) => {
      const db = sqlite();
      return new AccountWorkspaceRepository(db).atomic(() => {
        let deployment = requireDeploymentOrThrow(input.id, db);
        const venue = deployment.venueBinding.kind;
        if (
          input.executionMode &&
          !isExecutionModeCompatibleWithVenue(input.executionMode, venue)
        )
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `部署执行模式与交易通道不匹配：${input.executionMode} / ${venue}`,
          });
        if (input.status)
          deployment = updateDeploymentStatus(
            input.id,
            input.status,
            input.pauseReason,
            db,
          );
        if (input.executionMode)
          return updateDeploymentMode(input.id, input.executionMode, db);
        return deployment;
      });
    }),
  deploymentUpdateConfig: p("portfolio", "configure")
    .input(
      z.object({ id: idSchema, patch: deploymentConfigPatchSchema }).strict(),
    )
    .mutation(({ input }) =>
      updateDeploymentConfig(input.id, input.patch, sqlite()),
    ),
  deploymentArchive: p("portfolio", "configure")
    .input(z.object({ id: idSchema }).strict())
    .mutation(({ input }) =>
      updateDeploymentStatus(input.id, "archived", undefined, sqlite()),
    ),
  deploymentPoolList: p("portfolio", "read")
    .input(
      z
        .object({
          deploymentId: idSchema,
          status: z.enum(["watching", "evicted"]).optional(),
          limit: pageLimitSchema,
          cursor: cursorSchema.optional(),
        })
        .strict(),
    )
    .query(({ input }) =>
      listPoolEntries(
        input.deploymentId,
        {
          status: input.status,
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        sqlite(),
      ),
    ),
  deploymentPoolAdd: p("portfolio", "configure")
    .input(
      z
        .object({
          deploymentId: idSchema,
          symbol: z.string().trim().min(1),
          asOf: dateSchema.optional(),
          entryPrice: z.number().finite().positive().optional(),
          reason: z.string().trim().min(1).optional(),
        })
        .strict(),
    )
    .mutation(({ input }) =>
      manualAddPoolEntry(
        input.deploymentId,
        {
          symbol: input.symbol,
          asOf: input.asOf ?? beijingToday(),
          entryPrice: input.entryPrice,
          reason: input.reason,
        },
        sqlite(),
      ),
    ),
  deploymentPoolEvict: p("portfolio", "configure")
    .input(
      z
        .object({
          deploymentId: idSchema,
          symbol: z.string().trim().min(1),
          asOf: dateSchema.optional(),
          reason: z.string().trim().min(1).optional(),
        })
        .strict(),
    )
    .mutation(({ input }) =>
      manualEvictPoolEntry(
        input.deploymentId,
        input.symbol,
        {
          asOf: input.asOf ?? beijingToday(),
          reason: input.reason,
        },
        sqlite(),
      ),
    ),
  pipelineRunStep: p("portfolio", "compute")
    .input(
      z
        .object({
          deploymentId: idSchema,
          decisionDate: dateSchema,
          executeDate: dateSchema.optional(),
          runSlot: z.string().trim().min(1).optional(),
          stage: pipelineStageSchema,
          manualApproved: z.boolean().optional(),
        })
        .strict(),
    )
    .mutation(async ({ input }) => {
      const db = sqlite();
      const deployment = getDeployment(input.deploymentId, db);
      const defaultExecuteDate =
        deployment?.market === "cn-equity"
          ? nextCnWeekday(input.decisionDate)
          : input.decisionDate;
      const executeDate = input.executeDate ?? defaultExecuteDate;
      const deps: PipelinePlanningDeps = {
        readAccountState: (binding, asOfDate) =>
          resolveVenueAdapter(binding).readAccountState(binding, asOfDate, db),
      };
      switch (input.stage) {
        case "universe":
        case "signals":
        case "risk":
          return runPipelinePlanning(
            {
              deploymentId: input.deploymentId,
              decisionDate: input.decisionDate,
              executeDate,
              runSlot: input.runSlot,
              triggerKind: "manual",
              stopAfterStage: input.stage,
              deps,
            },
            db,
          );
        case "execute": {
          const run = findPipelineRun(
            input.deploymentId,
            input.decisionDate,
            input.runSlot ?? "daily",
            db,
          );
          if (!run)
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "流水线运行不存在，请先执行规划阶段",
            });
          return executePipelineRun(
            {
              runId: run.id,
              executeDate: run.executeDate,
              manualApproved: input.manualApproved,
            },
            db,
          );
        }
        case "reconcile":
          return reconcilePendingIntents(
            { deploymentId: input.deploymentId },
            db,
          );
        case "full": {
          const planned = await runPipelinePlanning(
            {
              deploymentId: input.deploymentId,
              decisionDate: input.decisionDate,
              executeDate,
              runSlot: input.runSlot,
              triggerKind: "manual",
              deps,
            },
            db,
          );
          const deployment = requireDeploymentOrThrow(input.deploymentId, db);
          if (
            planned.intents.length > 0 &&
            deployment.executionMode !== "shadow"
          ) {
            const execution = await executePipelineRun(
              {
                runId: planned.run.id,
                executeDate: planned.run.executeDate,
                manualApproved: input.manualApproved,
              },
              db,
            );
            return { ...planned, execution };
          }
          return { ...planned, execution: null };
        }
      }
    }),
  pipelineRunsList: p("portfolio", "read")
    .input(
      z
        .object({
          deploymentId: idSchema.optional(),
          limit: pageLimitSchema,
          cursor: cursorSchema.optional(),
        })
        .strict(),
    )
    .query(({ input }) => {
      const after = input.cursor
        ? decodeCursor(runCursorSchema, input.cursor)
        : undefined;
      const page = listPipelineRuns(
        {
          deploymentId: input.deploymentId,
          limit: input.limit,
          ...(after ? { after } : {}),
        },
        sqlite(),
      );
      return {
        items: page.items,
        nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      };
    }),
  pipelineRunDetail: p("portfolio", "read")
    .input(z.object({ runId: idSchema }).strict())
    .query(({ input }) => {
      const db = sqlite();
      const run = getPipelineRun(input.runId, db);
      if (!run)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `流水线运行不存在：${input.runId}`,
        });
      return {
        run,
        intents: listIntentsByRun(run.id, db),
        auditEvents: listExecutionAuditEvents(
          {
            deploymentId: run.deploymentId,
            runId: run.id,
            limit: 100,
          },
          db,
        ).items,
      };
    }),
  pipelineIntentCancel: p("portfolio", "configure")
    .input(
      z
        .object({
          intentId: idSchema,
          reason: z.string().trim().min(1).optional(),
        })
        .strict(),
    )
    .mutation(({ input }) =>
      transitionIntentStatus(
        input.intentId,
        "cancelled",
        { errorSummary: input.reason ?? "用户手动取消" },
        sqlite(),
      ),
    ),
  pipelineIntentApprove: p("portfolio", "compute")
    .input(
      z
        .object({
          intentId: idSchema,
          executeDate: dateSchema.optional(),
        })
        .strict(),
    )
    .mutation(({ input }) => {
      const db = sqlite();
      const intent = getIntent(input.intentId, db);
      if (!intent)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `订单意图不存在：${input.intentId}`,
        });
      return approveAndExecuteIntent(
        {
          intentId: input.intentId,
          executeDate: input.executeDate ?? intent.executeDate,
        },
        db,
      );
    }),
});
