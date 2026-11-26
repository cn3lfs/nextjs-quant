import {
  listPendingRunIds,
  listPendingRunIdsByDate,
  settlePendingRunDate,
} from "./provisional-run";
import { createPipelineQuoteReader } from "../execution/pipeline-quote-provider";
import type Database from "better-sqlite3";
import { isLiveVenueKind } from "trading-strategies";
import {
  cnTradingCalendar,
  cnExecutionWindow,
  fallbackWarning,
} from "./cn-trading-calendar";
import { createStrategyTickDeps } from "./strategy-evaluator";
import { beijingClock } from "~/lib/market/market-session";
import { sqlite } from "../db";
import {
  getDeployment,
  getPipelineGlobalConfig,
  listDeployments,
  recordDeploymentFailure,
  type DeploymentRecord,
  type PipelineGlobalConfig,
} from "../db/deployment-repository";
import {
  findPipelineRun,
  getPipelineRun,
  listIntentsByRun,
  type PipelineRunRecord,
} from "../db/pipeline-repository";
import { readSnapshot } from "../db/snapshot";
import {
  executePipelineRun,
  reconcilePendingIntents,
  type PipelineExecutorDeps,
} from "../execution/pipeline-executor";
import { resolveVenueAdapter } from "../execution/venue-router";
import { recordRuntimeError } from "../infra/runtime-errors";
import { downloadReady } from "../jobs/workflow-scheduler";
import {
  runPipelinePlanning,
  type PipelinePlanningDeps,
} from "./signal-risk-runner";

type Db = Database.Database;
type MaybePromise<T> = T | Promise<T>;

export type PipelineSchedulerDeps = PipelinePlanningDeps &
  PipelineExecutorDeps & {
    isTradingDay?: (date: string) => MaybePromise<boolean | null>;
    nextTradingDay?: (date: string) => MaybePromise<string | null>;
    isPostCloseDataReady?: (date: string, now: number) => MaybePromise<boolean>;
  };

type TickResult = {
  skipped: false;
  plannedRuns: number;
  executedRuns: number;
  reconciledIntents: number;
  rolledOverRuns: number;
  expiredIntents: number;
  failures: { deploymentId: string; message: string }[];
};

export type PipelineSchedulerSummary = { skipped: true } | TickResult;

export function computeCryptoRunSlot(nowMs: number, intervalMinutes: number) {
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes <= 0)
    throw new RangeError("加密调度间隔必须为正整数分钟");
  const intervalMs = intervalMinutes * 60_000;
  const slot = new Date(
    Math.floor(nowMs / intervalMs) * intervalMs,
  ).toISOString();
  return { decisionDate: slot.slice(0, 10), runSlot: slot.slice(11, 16) };
}

function activeDeploymentIds(db: Db) {
  const ids: string[] = [];
  let after:
    NonNullable<ReturnType<typeof listDeployments>["nextCursor"]> | undefined;
  do {
    const page = listDeployments({ status: "active", after }, db);
    ids.push(...page.items.map(({ id }) => id));
    after = page.nextCursor ?? undefined;
  } while (after);
  return ids.sort();
}

function autoExecutionEnabled(
  dep: DeploymentRecord,
  config: PipelineGlobalConfig,
) {
  return (
    (dep.executionMode === "auto_sim" && config.autoSimEnabled) ||
    (dep.executionMode === "auto_live" && config.autoLiveEnabled)
  );
}

const publishedPlanStages = new Set<PipelineRunRecord["stage"]>([
  "risk_checked",
  "executing",
  "completed",
  "partial",
  "blocked",
]);

function needsPlanning(run: PipelineRunRecord | null) {
  return !run || !publishedPlanStages.has(run.stage);
}

function plan(
  deployment: DeploymentRecord,
  slot: {
    decisionDate: string;
    executeDate: string;
    runSlot: string;
    calendarWarning?: string | null;
  },
  deps: PipelineSchedulerDeps,
  db: Db,
) {
  const planningDeps: PipelinePlanningDeps =
    deps.readAccountState || deployment.venueBinding.kind === "local_sim"
      ? deps
      : {
          ...deps,
          // External account adapters read the current session's state. The
          // future execution date belongs to the intents, not the snapshot.
          readAccountState: (binding, ...args) =>
            resolveVenueAdapter(binding, deps).readAccountState(
              binding,
              ...args,
            ),
        };
  return runPipelinePlanning(
    {
      deploymentId: deployment.id,
      ...slot,
      triggerKind: "scheduled",
      deps: planningDeps,
    },
    db,
  );
}

// A venue read may still be running when the runtime's next minute tick
// arrives. Only another reconciliation round shares that lock.
const submitting = new WeakSet<Db>();
const reconciling = new WeakSet<Db>();

function startReconciliation(deps: PipelineSchedulerDeps, db: Db) {
  if (reconciling.has(db)) return Promise.resolve(0);
  reconciling.add(db);
  return reconcilePendingIntents({ deps }, db)
    .then(({ queried }) => queried)
    .catch((error: unknown) => {
      recordRuntimeError("scheduler-tick", error);
      return 0;
    })
    .finally(() => reconciling.delete(db));
}

export async function tickPipelineScheduler(
  options: { now?: number; deps?: PipelineSchedulerDeps } = {},
  connection?: Db,
): Promise<PipelineSchedulerSummary> {
  const db = connection ?? sqlite();
  if (submitting.has(db)) return { skipped: true };
  submitting.add(db);
  try {
    const { now: fixedNow, deps: injected } = options;
    const clock =
      injected?.now ?? (fixedNow === undefined ? Date.now : () => fixedNow);
    const now = fixedNow ?? clock();
    const deps = {
      ...injected,
      now: clock,
      readQuote:
        injected?.readQuote ?? createPipelineQuoteReader({ now: clock }),
      // One cache shared by every deployment in this tick. The strategy worker
      // supplies the underlying readers; the factory only scopes the cache.
      strategy: createStrategyTickDeps(injected?.strategy),
    };
    const config = getPipelineGlobalConfig(db);
    const result: TickResult = {
      skipped: false,
      plannedRuns: 0,
      executedRuns: 0,
      reconciledIntents: 0,
      rolledOverRuns: 0,
      expiredIntents: 0,
      failures: [],
    };
    const beijing = beijingClock(now);
    const calendar = cnTradingCalendar(db, beijing.date, deps.isTradingDay);
    const isTradingDay = calendar.session;
    const nextTradingDay = deps.nextTradingDay;
    const nextPlanningSession = nextTradingDay
      ? async (date: string) => {
          const next = await nextTradingDay(date);
          const session =
            next && next > date ? await isTradingDay(next) : false;
          return {
            executeDate: session === false ? null : next,
            calendarWarning: session === null ? fallbackWarning : null,
          };
        }
      : calendar.nextSession;
    const calendarForRollover = {
      session: isTradingDay,
      nextConfirmedSession: nextTradingDay
        ? async (date: string) => {
            const next = await nextTradingDay(date);
            return next && next > date && (await isTradingDay(next)) === true
              ? next
              : null;
          }
        : calendar.nextConfirmedSession,
    };
    const dataReady = deps.isPostCloseDataReady ?? downloadReady;
    const recordingErrors: unknown[] = [];
    const failedDeployments = new Set<string>();

    const deploymentIds = connection
      ? activeDeploymentIds(db)
      : readSnapshot(() => activeDeploymentIds(db));
    const fail = (deploymentId: string, error: unknown) => {
      if (failedDeployments.has(deploymentId)) return;
      failedDeployments.add(deploymentId);
      const message =
        (error instanceof Error ? error.message : String(error)).trim() ||
        "流水线调度失败";
      result.failures.push({ deploymentId, message });
      try {
        recordDeploymentFailure(deploymentId, message, db);
      } catch (recordingError) {
        recordingErrors.push(recordingError);
      }
    };
    const execute = async (
      runId: string,
      executeDate: string,
      executionWindowCheck = deps.executionWindowCheck,
    ) => {
      const execution = await executePipelineRun(
        {
          runId,
          executeDate,
          deps: {
            ...deps,
            executionWindowCheck,
            executionCalendar: calendarForRollover,
          },
        },
        db,
      );
      if (!execution.skipped) result.executedRuns++;
      return execution;
    };

    // 1. Settle provisional A-share plans before any submission: roll a
    //    confirmed-closed date to the next confirmed session, or expire an
    //    intent whose session has truly passed.
    for (const deploymentId of deploymentIds) {
      try {
        const dep = getDeployment(deploymentId, db);
        if (dep?.status !== "active" || dep.market !== "cn-equity") continue;
        for (const runId of listPendingRunIds(deploymentId, db)) {
          const run = getPipelineRun(runId, db);
          if (!run) continue;
          const settled = await settlePendingRunDate(
            run,
            dep,
            db,
            clock,
            calendarForRollover,
            true,
          );
          result.rolledOverRuns += settled.rolledOverRuns;
          result.expiredIntents += settled.expiredIntents;
        }
      } catch (error) {
        fail(deploymentId, error);
      }
    }

    // 2. Fresh A-share opening submissions across every deployment. This runs
    //    before read-only reconciliation and before slow crypto planning so a
    //    slow venue query cannot consume the opening window.
    for (const deploymentId of deploymentIds) {
      if (failedDeployments.has(deploymentId)) continue;
      try {
        const dep = getDeployment(deploymentId, db);
        if (
          dep?.status !== "active" ||
          dep.market !== "cn-equity" ||
          dep.schedule.kind !== "post_close_auto"
        )
          continue;
        if (!dep.schedule.executeAtOpen || !autoExecutionEnabled(dep, config))
          continue;
        const executionWindowCheck = (ms: number, current = dep) =>
          cnExecutionWindow(current, beijing.date, ms) &&
          deps.executionWindowCheck?.(ms, current) !== false;
        if (!executionWindowCheck(now)) continue;
        if ((await isTradingDay(beijing.date)) !== true) continue;
        for (const runId of listPendingRunIdsByDate(
          deploymentId,
          beijing.date,
          db,
        )) {
          if (!executionWindowCheck(clock())) break;
          await execute(runId, beijing.date, executionWindowCheck);
        }
      } catch (error) {
        fail(deploymentId, error);
      }
    }

    // 3. Historical submitted orders are read-only evidence. Querying them
    //    never delays the fresh submissions above.
    const reconciliation = startReconciliation(deps, db);

    // 4. Slow planning and any remaining execution, in deterministic order.
    for (const deploymentId of deploymentIds) {
      if (failedDeployments.has(deploymentId)) continue;
      try {
        const dep = getDeployment(deploymentId, db);
        if (dep?.status !== "active") continue;
        const { schedule } = dep;
        const canPlan =
          deps.readAccountState ||
          !isLiveVenueKind(dep.venueBinding.kind) ||
          config.autoLiveEnabled;

        if (dep.market === "crypto" && schedule.kind === "crypto_interval") {
          const slot = computeCryptoRunSlot(now, schedule.intervalMinutes);
          let run = findPipelineRun(
            deploymentId,
            slot.decisionDate,
            slot.runSlot,
            db,
          );
          if (canPlan && needsPlanning(run)) {
            ({ run } = await plan(
              dep,
              { ...slot, executeDate: slot.decisionDate },
              deps,
              db,
            ));
            result.plannedRuns++;
          }
          if (
            run?.executeDate === slot.decisionDate &&
            autoExecutionEnabled(dep, config) &&
            listIntentsByRun(run.id, db).some(
              ({ status }) => status === "planned" || status === "queued",
            )
          )
            await execute(run.id, slot.decisionDate);
        } else if (
          dep.market === "cn-equity" &&
          schedule.kind === "post_close_auto"
        ) {
          const { date: today, hhmm } = beijing;
          if (hhmm < "15:30" || !schedule.runSignalsAfterClose || !canPlan)
            continue;

          const tradingDay = await isTradingDay(today);
          // An empty calendar permits weekday planning with a download receipt.
          // Opening execution still requires evidence that today is a session.
          if (
            tradingDay !== true &&
            (tradingDay === false ||
              beijing.weekday === 0 ||
              beijing.weekday === 6)
          )
            continue;
          const run = findPipelineRun(deploymentId, today, "daily", db);
          if (!needsPlanning(run) || !(await dataReady(today, now))) continue;
          const { executeDate, calendarWarning } = run
            ? { executeDate: run.executeDate, calendarWarning: null }
            : await nextPlanningSession(today);
          if (!executeDate) continue;
          await plan(
            dep,
            {
              decisionDate: today,
              executeDate,
              runSlot: "daily",
              calendarWarning,
            },
            deps,
            db,
          );
          result.plannedRuns++;
        }
      } catch (error) {
        fail(deploymentId, error);
      }
    }
    if (recordingErrors.length)
      throw new AggregateError(recordingErrors, "流水线部署失败记录写入失败");
    // Keep immediate/offline results in this tick's summary. The runtime
    // must regain control by the next event-loop turn even if a venue stalls.
    result.reconciledIntents = await Promise.race([
      reconciliation,
      new Promise<number>((resolve) => setImmediate(resolve, 0)),
    ]);
    return result;
  } finally {
    submitting.delete(db);
  }
}
