import type Database from "better-sqlite3";
import { isLiveVenueKind } from "trading-strategies";
import { closeScanWindow } from "~/lib/market/close-scan-window";
import { beijingClock } from "~/lib/market/market-session";
import { settingsSchema } from "~/lib/domain";
import { sqlite } from "../db";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
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
  listIntentsByDate,
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
import { downloadReady } from "../jobs/workflow-scheduler";
import { localCalendarReference } from "../market/data-health";
import {
  runPipelinePlanning,
  type PipelinePlanningDeps,
} from "./signal-risk-runner";

type Db = Database.Database;
type MaybePromise<T> = T | Promise<T>;

export type PipelineSchedulerDeps = PipelinePlanningDeps &
  PipelineExecutorDeps & {
    isTradingDay?: (date: string) => MaybePromise<boolean>;
    nextTradingDay?: (date: string) => MaybePromise<string | null>;
    isPostCloseDataReady?: (date: string, now: number) => MaybePromise<boolean>;
  };

type TickResult = {
  skipped: false;
  plannedRuns: number;
  executedRuns: number;
  reconciledIntents: number;
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
  return ids;
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
  slot: { decisionDate: string; executeDate: string; runSlot: string },
  deps: PipelineSchedulerDeps,
  db: Db,
) {
  const planningDeps =
    deps.readAccountState || deployment.venueBinding.kind === "local_sim"
      ? deps
      : {
          ...deps,
          // External account adapters read the current session's state. The
          // future execution date belongs to the intents, not the snapshot.
          readAccountState: () =>
            resolveVenueAdapter(deployment.venueBinding, deps).readAccountState(
              deployment.venueBinding,
              slot.decisionDate,
              db,
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

let ticking = false;

export async function tickPipelineScheduler(
  options: { now?: number; deps?: PipelineSchedulerDeps } = {},
  connection?: Db,
): Promise<PipelineSchedulerSummary> {
  if (ticking) return { skipped: true };
  ticking = true;
  try {
    const db = connection ?? sqlite();
    const { now: fixedNow, deps: injected } = options;
    const clock =
      fixedNow === undefined ? (injected?.now ?? Date.now) : () => fixedNow;
    const now = clock();
    const deps = { ...injected, now: clock };
    const config = getPipelineGlobalConfig(db);
    const result: TickResult = {
      skipped: false,
      plannedRuns: 0,
      executedRuns: 0,
      reconciledIntents: 0,
      failures: [],
    };
    let localDays: Promise<string[]> | undefined;
    const tradingDays = () =>
      (localDays ??= (async () => {
        const { tdxRoot, calendar } = settingsSchema.parse(
          new AccountWorkspaceRepository(db).record("settings") ?? {},
        );
        return (await localCalendarReference(tdxRoot, calendar)).days;
      })());
    const isTradingDay =
      deps.isTradingDay ??
      (async (date) => (await tradingDays()).includes(date));
    const nextTradingDay =
      deps.nextTradingDay ??
      (async (date) =>
        beijingClock(closeScanWindow(date, await tradingDays()).deadline).date);
    const dataReady = deps.isPostCloseDataReady ?? downloadReady;
    const beijing = beijingClock(now);
    const recordingErrors: unknown[] = [];

    const deploymentIds = connection
      ? activeDeploymentIds(db)
      : readSnapshot(() => activeDeploymentIds(db));
    for (const deploymentId of deploymentIds) {
      try {
        const dep = getDeployment(deploymentId, db);
        if (dep?.status !== "active") continue;
        const { schedule } = dep;
        const canPlan =
          deps.readAccountState ||
          !isLiveVenueKind(dep.venueBinding.kind) ||
          config.autoLiveEnabled;
        const reconcile = async () => {
          const { queried } = await reconcilePendingIntents(
            { deploymentId, deps },
            db,
          );
          result.reconciledIntents += queried;
        };
        const execute = async (runId: string, executeDate: string) => {
          const execution = await executePipelineRun(
            { runId, executeDate, deps },
            db,
          );
          if (!execution.skipped) result.executedRuns++;
        };

        if (schedule.kind === "manual_only") {
          await reconcile();
        } else if (
          dep.market === "crypto" &&
          schedule.kind === "crypto_interval"
        ) {
          const slot = computeCryptoRunSlot(now, schedule.intervalMinutes);
          await reconcile();
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
          const afterClose = hhmm >= "15:30" && schedule.runSignalsAfterClose;
          const inOpenWindow = (time: string) =>
            time >= schedule.openStartTime && time <= schedule.openCutoffTime;
          const inExecutionWindow = inOpenWindow(hhmm);
          if (!afterClose && !inExecutionWindow) continue;

          const tradingDay = await isTradingDay(today);
          // An empty calendar permits weekday planning with a download receipt.
          // Opening execution still requires evidence that today is a session.
          if (
            afterClose &&
            canPlan &&
            (tradingDay ||
              (!deps.isTradingDay &&
                beijing.weekday > 0 &&
                beijing.weekday < 6 &&
                (await tradingDays()).length === 0))
          ) {
            const run = findPipelineRun(deploymentId, today, "daily", db);
            if (needsPlanning(run) && (await dataReady(today, now))) {
              const executeDate =
                run?.executeDate ?? (await nextTradingDay(today));
              if (executeDate && (run || executeDate > today)) {
                await plan(
                  dep,
                  { decisionDate: today, executeDate, runSlot: "daily" },
                  deps,
                  db,
                );
                result.plannedRuns++;
              }
            }
          }

          if (!inExecutionWindow || !tradingDay) continue;
          await reconcile();
          if (!schedule.executeAtOpen || !autoExecutionEnabled(dep, config))
            continue;
          const runIds = new Set(
            listIntentsByDate(today, ["planned", "queued"], db)
              .filter((intent) => intent.deploymentId === deploymentId)
              .map((intent) => intent.runId),
          );
          for (const runId of runIds) {
            const current = beijingClock(clock());
            if (current.date !== today || !inOpenWindow(current.hhmm)) break;
            await execute(runId, today);
          }
        }
      } catch (error) {
        const message =
          (error instanceof Error ? error.message : String(error)).trim() ||
          "流水线调度失败";
        result.failures.push({ deploymentId, message });
        try {
          recordDeploymentFailure(deploymentId, message, db);
        } catch (recordingError) {
          recordingErrors.push(recordingError);
        }
      }
    }
    if (recordingErrors.length)
      throw new AggregateError(recordingErrors, "流水线部署失败记录写入失败");
    return result;
  } finally {
    ticking = false;
  }
}
