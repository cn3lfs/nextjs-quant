import { randomUUID } from "node:crypto";
import { createClaudeRunner } from "./claude";
import { QuantTeamError, errorMessage } from "./errors";
import { assertSafeRunDir, defaultTeamRoot, repoRoot } from "./paths";
import { buildTaskPrompt } from "./prompts";
import { redactList, redactResult, redactSecrets } from "./redact";
import {
  activeHeavyCount,
  blockDependentTasks,
  cancelQueuedTasks,
  completedDependencyResults,
  dependencyFingerprint,
  hasQueuedTasks,
  selectStartableTasks,
} from "./scheduler";
import {
  acquireRunLock,
  acquireTeamLock,
  clearRunCancelMarker,
  clearTaskCancelMarker,
  createAndSaveRun,
  ensureRunLayout,
  loadRunRecord,
  nowIso,
  observeLock,
  prepareTaskEnvironment,
  probeProcess,
  readCancelRequests,
  recoverOrphanedTasks,
  releaseRunLock,
  releaseTeamLock,
  requestRunCancel,
  saveRunRecordToDir,
  toRunStatusView,
  tryLoadRunRecord,
  type RunStatusView,
} from "./state";
import {
  isSafeIdentifier,
  parseBatchDefinition,
  type AttemptRecord,
  type RunRecord,
  type StructuredResult,
  type TaskOutcome,
  type TaskRecord,
  type TaskRunner,
} from "./types";

export type CoordinatorOptions = {
  teamRoot?: string;
  runner?: TaskRunner;
  pollIntervalMs?: number;
  now?: () => string;
  cwd?: string;
  baseEnv?: NodeJS.ProcessEnv;
};

type ActiveTask = {
  controller: AbortController;
  promise: Promise<TaskOutcome>;
  heavy: boolean;
};

const DEFAULT_POLL_INTERVAL_MS = 200;

function optionsTeamRoot(options: CoordinatorOptions): string {
  return options.teamRoot ?? defaultTeamRoot;
}

function freezeTask(task: TaskRecord): TaskRecord {
  return structuredClone(task);
}

function runnerException(error: unknown): TaskOutcome {
  return {
    kind: "failed",
    started: false,
    sessionId: null,
    structuredStatus: null,
    result: null,
    blockers: ["runner_exception"],
    error: {
      code: "RUNNER_EXCEPTION",
      message: redactSecrets(errorMessage(error)),
    },
    timedOut: false,
    cancelled: false,
    outputExceeded: false,
    exitCode: null,
    permissionDenials: [],
    isError: false,
  };
}

function finishTask(
  record: RunRecord,
  task: TaskRecord,
  attempt: AttemptRecord,
  outcomeInput: TaskOutcome,
  now: string,
): void {
  let outcome = outcomeInput;
  if (
    outcome.sessionId !== null &&
    attempt.sessionId !== null &&
    outcome.sessionId !== attempt.sessionId
  )
    outcome = {
      ...outcome,
      kind: "failed",
      structuredStatus: null,
      result: null,
      blockers: ["session_mismatch"],
      error: {
        code: "SESSION_MISMATCH",
        message: "任务返回的 session_id 与启动时不一致",
      },
    };

  attempt.finishedAt = now;
  attempt.status = outcome.kind;
  attempt.exitCode = outcome.exitCode;
  attempt.timedOut = outcome.timedOut;
  attempt.cancelled = outcome.cancelled;
  attempt.outputExceeded = outcome.outputExceeded;
  attempt.permissionDenials = redactList(outcome.permissionDenials, 20);
  attempt.isError = outcome.isError;
  attempt.structuredStatus = outcome.structuredStatus;
  attempt.result = outcome.result ? redactResult(outcome.result) : null;
  attempt.error = outcome.error
    ? {
        code: outcome.error.code,
        message: redactSecrets(outcome.error.message),
      }
    : null;
  attempt.sessionId = outcome.sessionId ?? attempt.sessionId;
  attempt.stdoutPath = outcome.stdoutPath ?? attempt.stdoutPath;
  attempt.stderrPath = outcome.stderrPath ?? attempt.stderrPath;
  attempt.promptPath = outcome.promptPath ?? attempt.promptPath;

  task.status = outcome.kind;
  task.structuredStatus = outcome.structuredStatus;
  task.result = outcome.result ? redactResult(outcome.result) : null;
  task.blockers = redactList(outcome.blockers);
  task.lastError = outcome.error ? redactSecrets(outcome.error.message) : null;
  task.finishedAt = now;
  if (outcome.sessionId) task.sessionId = outcome.sessionId;
  else if (outcome.started) task.sessionId = attempt.sessionId;
  if (outcome.kind === "cancelled") task.cancelRequested = true;
}

function markQueuedUnresolvable(record: RunRecord, now: string): number {
  let count = 0;
  for (const id of record.taskOrder) {
    const task = record.tasks[id];
    if (!task || task.status !== "queued") continue;
    task.status = "blocked";
    task.blockers = ["dependency_unresolvable"];
    task.lastError = "依赖图无法继续调度";
    task.finishedAt = now;
    count += 1;
  }
  return count;
}

function failureOutcome(message: string): TaskOutcome {
  return {
    kind: "failed",
    started: false,
    sessionId: null,
    structuredStatus: null,
    result: null,
    blockers: ["internal_error"],
    error: { code: "INTERNAL_ERROR", message: redactSecrets(message) },
    timedOut: false,
    cancelled: false,
    outputExceeded: false,
    exitCode: null,
    permissionDenials: [],
    isError: false,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function startRun(
  input: unknown,
  options: CoordinatorOptions = {},
): Promise<RunRecord> {
  const definition = parseBatchDefinition(input);
  const teamRoot = optionsTeamRoot(options);
  const teamLock = acquireTeamLock(teamRoot);
  try {
    const { runDir } = ensureRunLayout(teamRoot, definition.runId);
    const lock = acquireRunLock(runDir);
    try {
      const existing = tryLoadRunRecord(teamRoot, definition.runId);
      if (existing) {
        if (existing.definitionHash !== definition.definitionHash)
          throw new QuantTeamError(
            "DEFINITION_CONFLICT",
            `runId ${definition.runId} 已存在不同定义；拒绝覆盖`,
          );
        const recovered = recoverOrphanedTasks(existing, options.now?.());
        if (recovered > 0) saveRunRecordToDir(runDir, existing);
        // Only an untouched run (created before any attempt) may continue
        // automatically. Anything with prior attempts requires explicit resume.
        const untouched = Object.values(existing.tasks).every(
          (task) =>
            task.status === "queued" &&
            task.attempts.length === 0 &&
            !task.pendingResume,
        );
        if (
          existing.status === "queued" &&
          !existing.cancelRequested &&
          untouched
        )
          return await coordinate(existing, runDir, options);
        return existing;
      }
      const record = createAndSaveRun(
        definition,
        teamRoot,
        options.now?.() ?? nowIso(),
      );
      return await coordinate(record, runDir, options);
    } finally {
      releaseRunLock(lock);
    }
  } finally {
    releaseTeamLock(teamLock);
  }
}

async function coordinate(
  record: RunRecord,
  runDir: string,
  options: CoordinatorOptions,
): Promise<RunRecord> {
  const runner = options.runner ?? createClaudeRunner();
  const pollIntervalMs = Math.max(
    10,
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
  const now = options.now ?? nowIso;
  const cwd = options.cwd ?? repoRoot;
  const baseEnv = options.baseEnv ?? process.env;
  const active = new Map<string, ActiveTask>();

  const startTask = (task: TaskRecord) => {
    const attemptNumber = task.attempts.length + 1;
    const environment = prepareTaskEnvironment(
      runDir,
      task.id,
      attemptNumber,
      baseEnv,
    );
    const sessionId = task.sessionId ?? randomUUID();
    const resume = task.pendingResume && task.sessionId !== null;
    const upstream = completedDependencyResults(record, task);
    const prompt = buildTaskPrompt(record, task, upstream);
    const startedAt = now();
    const fingerprint = dependencyFingerprint(record, task);
    const attempt: AttemptRecord = {
      attempt: attemptNumber,
      sessionId,
      startedAt,
      finishedAt: null,
      status: "running",
      exitCode: null,
      timedOut: false,
      cancelled: false,
      outputExceeded: false,
      permissionDenials: [],
      isError: false,
      structuredStatus: null,
      result: null,
      error: null,
      upstreamFingerprint: fingerprint,
      childPid: null,
      stdoutPath: null,
      stderrPath: null,
      promptPath: null,
    };
    task.attempts.push(attempt);
    task.status = "running";
    task.pendingResume = false;
    task.cancelRequested = false;
    task.startedAt = startedAt;
    task.finishedAt = null;
    task.blockers = [];
    task.lastError = null;
    task.upstreamFingerprint = fingerprint;

    const controller = new AbortController();
    const frozenTask = freezeTask(task);
    const execution = Promise.resolve().then(() =>
      runner({
        task: frozenTask,
        prompt,
        env: environment.env,
        cwd,
        sessionId,
        resume,
        timeoutMs: task.timeoutMs,
        signal: controller.signal,
        attemptDir: environment.directory,
        onSpawn: (pid) => {
          attempt.childPid = pid;
          // Persist before the child can do work; a crash must leave enough
          // evidence to refuse a duplicate resume without killing a PID that
          // may have been reused by an unrelated process.
          saveRunRecordToDir(runDir, record);
        },
        upstream,
      }),
    );
    const promise = execution
      .catch((error) => failureOutcome(errorMessage(error)))
      .then((outcome) => {
        finishTask(record, task, attempt, outcome, now());
        active.delete(task.id);
        return outcome;
      });
    active.set(task.id, { controller, promise, heavy: task.heavy });
  };

  const startAvailable = (): number => {
    const heavy = activeHeavyCount(active.keys(), record);
    const ids = selectStartableTasks(record, active.size, heavy);
    for (const id of ids) {
      const task = record.tasks[id];
      if (task) startTask(task);
    }
    return ids.length;
  };

  const pollCancellation = (): boolean => {
    const requests = readCancelRequests(runDir);
    if (!requests.run && requests.tasks.size === 0) return false;
    let changed = false;
    if (requests.run) {
      if (!record.cancelRequested) {
        record.cancelRequested = true;
        changed = true;
      }
      if (cancelQueuedTasks(record, now()).length > 0) changed = true;
      for (const [id, item] of active) {
        const task = record.tasks[id];
        if (task) task.cancelRequested = true;
        if (!item.controller.signal.aborted) item.controller.abort("cancelled");
      }
      clearRunCancelMarker(runDir);
    }
    if (requests.tasks.size > 0) {
      for (const id of requests.tasks) {
        const task = record.tasks[id];
        if (task?.status === "queued") {
          if (cancelQueuedTasks(record, now(), new Set([id])).length > 0)
            changed = true;
        } else if (task?.status === "running") {
          task.cancelRequested = true;
          const item = active.get(id);
          if (item && !item.controller.signal.aborted)
            item.controller.abort("cancelled");
          changed = true;
        }
        clearTaskCancelMarker(runDir, id);
      }
    }
    return changed;
  };

  const onSignal = () => {
    record.cancelRequested = true;
    for (const item of active.values()) {
      if (!item.controller.signal.aborted) item.controller.abort("cancelled");
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let fatal: unknown = null;
  try {
    while (true) {
      let changed = pollCancellation();
      if (record.cancelRequested) {
        if (cancelQueuedTasks(record, now()).length > 0) changed = true;
        for (const [id, item] of active) {
          const task = record.tasks[id];
          if (task) task.cancelRequested = true;
          if (!item.controller.signal.aborted)
            item.controller.abort("cancelled");
        }
      }
      if (blockDependentTasks(record, now()).length > 0) changed = true;
      if (startAvailable() > 0) changed = true;
      if (changed) saveRunRecordToDir(runDir, record);

      if (active.size === 0) {
        if (hasQueuedTasks(record)) {
          if (markQueuedUnresolvable(record, now()) > 0) {
            saveRunRecordToDir(runDir, record);
            continue;
          }
        }
        break;
      }

      await Promise.race([
        ...Array.from(active.values(), (item) =>
          item.promise.then(() => undefined),
        ),
        delay(pollIntervalMs),
      ]);
    }
  } catch (error) {
    fatal = error;
    for (const item of active.values()) item.controller.abort("fatal");
    await Promise.race([
      Promise.allSettled(Array.from(active.values(), (item) => item.promise)),
      delay(5_000),
    ]);
    for (const id of record.taskOrder) {
      const task = record.tasks[id];
      if (task?.status !== "running") continue;
      task.status = "failed";
      task.lastError = "协调器内部错误中断了任务";
      task.blockers = ["interrupted"];
      task.finishedAt = now();
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  if (fatal) record.lastError = redactSecrets(errorMessage(fatal));
  saveRunRecordToDir(runDir, record);
  return record;
}

export async function resumeRunTask(
  runId: string,
  taskId: string,
  options: CoordinatorOptions = {},
): Promise<RunRecord> {
  if (!isSafeIdentifier(runId) || !isSafeIdentifier(taskId))
    throw new QuantTeamError(
      "INVALID_IDENTIFIER",
      "runId/taskId 不安全，拒绝恢复",
    );
  const teamRoot = optionsTeamRoot(options);
  const teamLock = acquireTeamLock(teamRoot);
  try {
    const runDir = assertSafeRunDir(teamRoot, runId);
    // Pending cancel requests are never dropped by resume; the coordinator
    // observes them after the task is queued again.
    const lock = acquireRunLock(runDir);
    try {
      const record = loadRunRecord(teamRoot, runId);
      if (recoverOrphanedTasks(record, options.now?.()) > 0)
        saveRunRecordToDir(runDir, record);
      const task = record.tasks[taskId];
      if (!task)
        throw new QuantTeamError("TASK_NOT_FOUND", `找不到任务: ${taskId}`);
      if (task.status === "running")
        throw new QuantTeamError("TASK_ACTIVE", `任务仍在运行: ${taskId}`);
      if (task.status === "completed")
        throw new QuantTeamError(
          "TASK_COMPLETE",
          `已完成任务不能 resume: ${taskId}`,
        );
      if (
        task.status !== "failed" &&
        task.status !== "blocked" &&
        task.status !== "cancelled"
      )
        throw new QuantTeamError(
          "TASK_NOT_RESUMABLE",
          `任务状态 ${task.status} 不能 resume`,
        );
      const lastAttempt = task.attempts.at(-1);
      const orphanBlocker = task.blockers.find((blocker) =>
        blocker.startsWith("orphan_child_"),
      );
      if (lastAttempt?.status === "running" && lastAttempt.childPid !== null) {
        const probe = probeProcess(lastAttempt.childPid);
        if (probe !== "dead")
          throw new QuantTeamError(
            probe === "alive"
              ? "ORPHAN_CHILD_ALIVE"
              : "ORPHAN_CHILD_UNVERIFIABLE",
            `上次子进程 PID ${lastAttempt.childPid} ${
              probe === "alive" ? "仍存活" : "状态无法确认"
            }；拒绝 resume，且不会结束未知 PID`,
          );
        lastAttempt.status = "failed";
        lastAttempt.finishedAt = options.now?.() ?? nowIso();
        lastAttempt.error = {
          code: "INTERRUPTED",
          message: "上次子进程已退出，继续显式 resume",
        };
        task.blockers = ["interrupted"];
      } else if (orphanBlocker) {
        throw new QuantTeamError(
          "ORPHAN_CHILD_UNVERIFIABLE",
          `任务 ${taskId} 有中断子进程但缺少可核验 PID；拒绝 resume`,
        );
      }
      if (!task.sessionId)
        throw new QuantTeamError(
          "UNKNOWN_SESSION",
          `任务 ${taskId} 没有已知 session_id；不会使用 --continue 或新建会话冒充 resume`,
        );
      const currentFingerprint = dependencyFingerprint(record, task);
      const lastFingerprint = task.attempts.at(-1)?.upstreamFingerprint;
      if (lastFingerprint && lastFingerprint !== currentFingerprint)
        throw new QuantTeamError(
          "UPSTREAM_CHANGED",
          `任务 ${taskId} 的上游结果已变化；不能静默复用旧结果，请新建运行`,
        );

      task.status = "queued";
      task.pendingResume = true;
      task.cancelRequested = false;
      task.blockers = [];
      task.lastError = null;
      task.startedAt = null;
      task.finishedAt = null;
      record.cancelRequested = false;
      saveRunRecordToDir(runDir, record);
      return await coordinate(record, runDir, options);
    } finally {
      releaseRunLock(lock);
    }
  } finally {
    releaseTeamLock(teamLock);
  }
}

export type CancelResult = {
  mode: "requested" | "applied" | "noop";
  state: RunStatusView;
};

function cancelRunningRecords(
  record: RunRecord,
  taskId: string | null,
  now: string,
) {
  if (taskId === null) record.cancelRequested = true;
  for (const id of record.taskOrder) {
    if (taskId !== null && id !== taskId) continue;
    const task = record.tasks[id];
    if (!task) continue;
    if (task.status !== "queued" && task.status !== "running") continue;
    task.status = "cancelled";
    task.cancelRequested = true;
    task.blockers = ["cancelled"];
    task.lastError = "任务被取消";
    task.finishedAt = now;
    const attempt = task.attempts.at(-1);
    if (attempt && attempt.status === "running") {
      attempt.status = "cancelled";
      attempt.cancelled = true;
      attempt.finishedAt = now;
      attempt.error = { code: "CANCELLED", message: "任务被取消" };
    }
  }
  // A task-scoped offline cancel leaves other running tasks orphaned. Record
  // them as interrupted failures instead of leaving the run hanging forever.
  if (taskId !== null) recoverOrphanedTasks(record, now);
}

export async function cancelRun(
  runId: string,
  taskId: string | null = null,
  options: CoordinatorOptions = {},
): Promise<CancelResult> {
  if (
    !isSafeIdentifier(runId) ||
    (taskId !== null && !isSafeIdentifier(taskId))
  )
    throw new QuantTeamError(
      "INVALID_IDENTIFIER",
      "runId/taskId 不安全，拒绝取消",
    );
  const teamRoot = optionsTeamRoot(options);
  const record = loadRunRecord(teamRoot, runId);
  if (taskId !== null && !record.tasks[taskId])
    throw new QuantTeamError("TASK_NOT_FOUND", `找不到任务: ${taskId}`);
  const { runDir } = ensureRunLayout(teamRoot, runId);
  requestRunCancel(teamRoot, runId, taskId);
  const observation = observeLock(runDir);
  if (observation.state === "active" || observation.state === "unverifiable")
    return {
      mode: "requested",
      state: toRunStatusView(loadRunRecord(teamRoot, runId)),
    };

  let lock: ReturnType<typeof acquireRunLock>;
  try {
    lock = acquireRunLock(runDir);
  } catch (error) {
    if ((error as QuantTeamError).code === "LOCK_ACTIVE")
      return {
        mode: "requested",
        state: toRunStatusView(loadRunRecord(teamRoot, runId)),
      };
    throw error;
  }
  try {
    const current = loadRunRecord(teamRoot, runId);
    cancelRunningRecords(current, taskId, options.now?.() ?? nowIso());
    saveRunRecordToDir(runDir, current);
    if (taskId === null) clearRunCancelMarker(runDir);
    else clearTaskCancelMarker(runDir, taskId);
    return { mode: "applied", state: toRunStatusView(current) };
  } finally {
    releaseRunLock(lock);
  }
}

export function getRunStatus(
  runId: string,
  options: CoordinatorOptions = {},
): RunStatusView {
  if (!isSafeIdentifier(runId))
    throw new QuantTeamError("INVALID_IDENTIFIER", "runId 不安全，拒绝读取");
  const record = loadRunRecord(optionsTeamRoot(options), runId);
  return toRunStatusView(record);
}

export type { StructuredResult };
