import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { QuantTeamError } from "./errors";
import {
  assertNoLinks,
  assertSafePath,
  assertSafeRunDir,
  assertTeamRootSafe,
  ensureSafeDir,
  runDirFor,
} from "./paths";
import { redactList, redactResult, redactSecrets } from "./redact";
import {
  createInitialRunRecord,
  computeRunStatus,
  isSafeIdentifier,
  summarizeRun,
  type AttemptRecord,
  type BatchDefinition,
  type RunRecord,
  type RunSummary,
  type RuntimeStatus,
  type StructuredResult,
  type TaskRecord,
} from "./types";

export type LockInfo = {
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
};

export type LockHandle = LockInfo & { path: string };

export type LockObservation =
  | { state: "none" }
  | { state: "active"; info: LockInfo }
  | { state: "stale"; info: LockInfo }
  | { state: "unverifiable"; info: LockInfo | null };

export type CancelRequests = {
  run: boolean;
  tasks: Set<string>;
};

export type TaskEnvironment = {
  directory: string;
  quantDataDir: string;
  tmpDir: string;
  env: NodeJS.ProcessEnv;
};

export type RunStatusView = {
  runId: string;
  status: RuntimeStatus;
  definitionHash: string;
  createdAt: string;
  updatedAt: string;
  maxConcurrent: number;
  cancelRequested: boolean;
  lastError: string | null;
  summary: RunSummary;
  tasks: Array<{
    id: string;
    role: string;
    status: RuntimeStatus;
    heavy: boolean;
    dependsOn: string[];
    candidateVersion: string;
    sessionId: string | null;
    attemptCount: number;
    structuredStatus: string | null;
    result: StructuredResult | null;
    blockers: string[];
    lastError: string | null;
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    lastAttempt: {
      attempt: number;
      status: string;
      exitCode: number | null;
      timedOut: boolean;
      cancelled: boolean;
      outputExceeded: boolean;
      permissionDenials: string[];
      childPid: number | null;
      error: { code: string; message: string } | null;
      stdoutPath: string | null;
      stderrPath: string | null;
    } | null;
  }>;
};

export function nowIso(): string {
  return new Date().toISOString();
}

function refreshRecord(record: RunRecord, now = nowIso()): RunRecord {
  record.summary = summarizeRun(record.tasks);
  record.status = computeRunStatus(record.tasks, record.cancelRequested);
  record.updatedAt = now;
  return record;
}

export function ensureRunLayout(teamRoot: string, runId: string) {
  const root = assertTeamRootSafe(teamRoot);
  const runDir = runDirFor(root, runId);
  ensureSafeDir(root, root);
  ensureSafeDir(root, runDir);
  const controlDir = join(runDir, "control");
  const tasksDir = join(runDir, "tasks");
  const envDir = join(runDir, "env");
  ensureSafeDir(runDir, controlDir);
  ensureSafeDir(runDir, tasksDir);
  ensureSafeDir(runDir, envDir);
  return { runDir, controlDir, tasksDir, envDir };
}

export function statePath(runDir: string): string {
  return join(runDir, "run.json");
}

function temporaryPath(target: string): string {
  return `${target}.${randomUUID()}.tmp`;
}

export function writeTextAtomic(target: string, contents: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = temporaryPath(target);
  writeFileSync(temporary, contents, "utf8");
  try {
    renameSync(temporary, target);
  } catch (error) {
    // Never delete a valid target to force a replacement. The old state must
    // survive, and only this call's temporary file may be removed.
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT")
        throw cleanupError;
    }
    throw error;
  }
}

export function writeJsonAtomic(target: string, value: unknown): void {
  writeTextAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

function parseRunRecord(value: unknown, runId: string): RunRecord {
  if (value === null || typeof value !== "object")
    throw new QuantTeamError("RUN_CORRUPT", `运行状态不是对象: ${runId}`);
  const record = value as Partial<RunRecord>;
  if (
    record.schemaVersion !== 1 ||
    record.runId !== runId ||
    typeof record.definitionHash !== "string" ||
    !Array.isArray(record.taskOrder) ||
    record.tasks === null ||
    typeof record.tasks !== "object"
  )
    throw new QuantTeamError("RUN_CORRUPT", `运行状态损坏: ${runId}`);
  return record as RunRecord;
}

export function loadRunRecord(teamRoot: string, runId: string): RunRecord {
  const runDir = assertSafeRunDir(teamRoot, runId);
  const target = statePath(runDir);
  assertNoLinks(runDir, target);
  let contents: string;
  try {
    contents = readFileSync(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new QuantTeamError("RUN_NOT_FOUND", `找不到运行记录: ${runId}`);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new QuantTeamError("RUN_CORRUPT", `运行状态不是合法 JSON: ${runId}`);
  }
  return parseRunRecord(parsed, runId);
}

export function tryLoadRunRecord(
  teamRoot: string,
  runId: string,
): RunRecord | null {
  try {
    return loadRunRecord(teamRoot, runId);
  } catch (error) {
    if ((error as QuantTeamError).code === "RUN_NOT_FOUND") return null;
    throw error;
  }
}

export function saveRunRecord(teamRoot: string, record: RunRecord): RunRecord {
  const runDir = assertSafeRunDir(teamRoot, record.runId);
  return saveRunRecordToDir(runDir, record);
}

export function saveRunRecordToDir(
  runDir: string,
  record: RunRecord,
): RunRecord {
  assertNoLinks(runDir, runDir);
  const target = statePath(runDir);
  assertSafePath(runDir, target);
  assertNoLinks(runDir, target);
  refreshRecord(record);
  writeJsonAtomic(target, record);
  return record;
}

export function createAndSaveRun(
  definition: BatchDefinition,
  teamRoot: string,
  now = nowIso(),
): RunRecord {
  const { runDir } = ensureRunLayout(teamRoot, definition.runId);
  const record = createInitialRunRecord(definition, now);
  saveRunRecordToDir(runDir, record);
  return record;
}

export type ProcessProbe = "alive" | "dead" | "unknown";

export function probeProcess(pid: number): ProcessProbe {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    // EPERM still proves a process exists; anything else is fail-closed.
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

export function isProcessAlive(pid: number): boolean {
  const probe = probeProcess(pid);
  if (probe === "unknown")
    throw new QuantTeamError(
      "LOCK_UNVERIFIABLE",
      `无法确认进程 ${pid} 是否存活`,
    );
  return probe === "alive";
}

function lockPath(runDir: string): string {
  return join(runDir, "run.lock");
}

export function teamLockPath(teamRoot: string): string {
  return join(teamRoot, "coordinator.lock");
}

function parseLock(contents: string): LockInfo | null {
  try {
    const parsed = JSON.parse(contents) as Partial<LockInfo>;
    if (
      typeof parsed.token !== "string" ||
      parsed.token.length === 0 ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.startedAt !== "string"
    )
      return null;
    return parsed as LockInfo;
  } catch {
    return null;
  }
}

export function observeLock(runDir: string): LockObservation {
  return observeLockFile(lockPath(runDir));
}

export function observeLockFile(target: string): LockObservation {
  let contents: string;
  try {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink())
      throw new QuantTeamError("UNSAFE_PATH", `锁文件是符号链接: ${target}`);
    contents = readFileSync(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: "none" };
    throw error;
  }
  const info = parseLock(contents);
  if (!info) return { state: "unverifiable", info: null };
  if (info.hostname !== hostname()) return { state: "unverifiable", info };
  return isProcessAlive(info.pid)
    ? { state: "active", info }
    : { state: "stale", info };
}

/** Only delete a lock after proving its owning process is gone on this host. */
export function acquireLockFile(path: string, label: string): LockHandle {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const info: LockInfo = {
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      startedAt: nowIso(),
    };
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify(info, null, 2)}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      return { ...info, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const observation = observeLockFile(path);
      if (observation.state === "active")
        throw new QuantTeamError(
          "LOCK_ACTIVE",
          `${label}已被进程 ${observation.info.pid} 占用: ${path}`,
        );
      if (observation.state === "unverifiable")
        throw new QuantTeamError(
          "LOCK_UNVERIFIABLE",
          `${label}的持有进程无法确认；请人工检查，不会自动删除或结束未知进程`,
        );
      if (observation.state === "none") continue;
      // Confirmed dead on this host: remove only the stale lock file.
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT")
          throw unlinkError;
      }
    }
  }
  throw new QuantTeamError("LOCK_ACTIVE", `无法取得${label}: ${path}`);
}

export function acquireRunLock(runDir: string): LockHandle {
  ensureSafeDir(runDir, runDir);
  const path = lockPath(runDir);
  assertSafePath(runDir, path);
  return acquireLockFile(path, "运行目录");
}

export function acquireTeamLock(teamRoot: string): LockHandle {
  const root = assertTeamRootSafe(teamRoot);
  ensureSafeDir(root, root);
  const path = teamLockPath(root);
  assertSafePath(root, path);
  try {
    return acquireLockFile(path, "团队协调器");
  } catch (error) {
    if ((error as QuantTeamError).code === "LOCK_ACTIVE")
      throw new QuantTeamError(
        "TEAM_BUSY",
        "另一个 quant-team 协调器正在运行；不会自动等待，请先 status/cancel 或等待其结束",
      );
    throw error;
  }
}

export function releaseLockFile(handle: LockHandle): boolean {
  let contents: string;
  try {
    contents = readFileSync(handle.path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const info = parseLock(contents);
  if (!info || info.token !== handle.token) return false;
  unlinkSync(handle.path);
  return true;
}

export function releaseRunLock(handle: LockHandle): boolean {
  return releaseLockFile(handle);
}

export function releaseTeamLock(handle: LockHandle): boolean {
  return releaseLockFile(handle);
}

function controlDir(runDir: string): string {
  return join(runDir, "control");
}

export function cancelRunMarkerPath(runDir: string): string {
  return join(controlDir(runDir), "cancel-run.json");
}

export function cancelTaskMarkerPath(runDir: string, taskId: string): string {
  if (!isSafeIdentifier(taskId))
    throw new QuantTeamError(
      "INVALID_IDENTIFIER",
      `taskId 不安全: ${JSON.stringify(taskId)}`,
    );
  return join(controlDir(runDir), `cancel-task-${taskId}.json`);
}

export function requestRunCancel(
  teamRoot: string,
  runId: string,
  taskId: string | null = null,
): string {
  const runDir = assertSafeRunDir(teamRoot, runId);
  ensureSafeDir(runDir, controlDir(runDir));
  const target =
    taskId === null
      ? cancelRunMarkerPath(runDir)
      : cancelTaskMarkerPath(runDir, taskId);
  assertSafePath(runDir, target);
  writeJsonAtomic(target, {
    runId,
    taskId,
    requestedAt: nowIso(),
  });
  return target;
}

export function readCancelRequests(runDir: string): CancelRequests {
  const requests: CancelRequests = { run: false, tasks: new Set() };
  const dir = controlDir(runDir);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return requests;
    throw error;
  }
  assertNoLinks(runDir, dir);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === "cancel-run.json") requests.run = true;
    const match = /^cancel-task-([A-Za-z0-9._-]+)\.json$/.exec(entry.name);
    if (match?.[1] && isSafeIdentifier(match[1])) requests.tasks.add(match[1]);
  }
  return requests;
}

export function clearRunCancelMarker(runDir: string): void {
  try {
    unlinkSync(cancelRunMarkerPath(runDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function clearTaskCancelMarker(runDir: string, taskId: string): void {
  try {
    unlinkSync(cancelTaskMarkerPath(runDir, taskId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function attemptDirectory(
  runDir: string,
  taskId: string,
  attempt: number,
): string {
  if (!isSafeIdentifier(taskId))
    throw new QuantTeamError(
      "INVALID_IDENTIFIER",
      `taskId 不安全: ${JSON.stringify(taskId)}`,
    );
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new QuantTeamError("INVALID_IDENTIFIER", `无效尝试序号: ${attempt}`);
  const target = join(runDir, "tasks", taskId, `attempt-${attempt}`);
  assertSafePath(runDir, target);
  return target;
}

export function prepareTaskEnvironment(
  runDir: string,
  taskId: string,
  attempt: number,
  baseEnv: NodeJS.ProcessEnv = process.env,
): TaskEnvironment {
  const directory = attemptDirectory(runDir, taskId, attempt);
  ensureSafeDir(runDir, directory);
  const quantDataDir = join(directory, "quant-data");
  const tmpDir = join(directory, "tmp");
  ensureSafeDir(runDir, quantDataDir);
  ensureSafeDir(runDir, tmpDir);
  return {
    directory,
    quantDataDir,
    tmpDir,
    env: {
      ...baseEnv,
      QUANT_DATA_DIR: quantDataDir,
      TEMP: tmpDir,
      TMP: tmpDir,
      TMPDIR: tmpDir,
    },
  };
}

export function recoverOrphanedTasks(
  record: RunRecord,
  now = nowIso(),
): number {
  let recovered = 0;
  for (const task of Object.values(record.tasks)) {
    if (task.status === "queued" && task.pendingResume) {
      // A resume was queued but the coordinator crashed before starting it.
      // Do not auto-start external work; surface it as an interrupted failure.
      task.status = "failed";
      task.pendingResume = false;
      task.lastError = "中断：resume 已排队但未开始，需要再次显式 resume";
      task.blockers = ["interrupted"];
      task.finishedAt = now;
      recovered += 1;
      continue;
    }
    if (task.status !== "running") continue;
    const attempt = task.attempts.at(-1);
    if (attempt?.status === "running" && attempt.childPid !== null) {
      const probe = probeProcess(attempt.childPid);
      if (probe !== "dead") {
        // Fail closed on PID reuse/unknown ownership. Never kill this PID.
        task.status = "blocked";
        task.lastError = `上次子进程 PID ${attempt.childPid} 仍存活或无法确认；拒绝自动恢复，需人工处理`;
        task.blockers = [`orphan_child_${probe}:${attempt.childPid}`];
        task.finishedAt = now;
        recovered += 1;
        continue;
      }
    }
    if (attempt && attempt.status === "running") {
      attempt.status = "failed";
      attempt.finishedAt = now;
      attempt.error = {
        code: "INTERRUPTED",
        message: "协调器退出时任务仍在运行；需要显式 resume",
      };
    }
    if (!task.sessionId && attempt?.sessionId)
      task.sessionId = attempt.sessionId;
    task.status = "failed";
    task.lastError = "中断：协调器非正常退出，任务未自动重试";
    task.blockers = ["interrupted"];
    task.finishedAt = now;
    recovered += 1;
  }
  if (Object.values(record.tasks).some((task) => task.attempts.length > 0)) {
    // A run that made progress and crashed must not silently continue queued
    // work on a repeated `run`; make the residue terminal and require a new run.
    for (const task of Object.values(record.tasks)) {
      if (task.status !== "queued") continue;
      task.status = "blocked";
      task.blockers = ["interrupted"];
      task.lastError = "协调器退出后任务未调度；需要新建运行";
      task.finishedAt = now;
      recovered += 1;
    }
  }
  if (recovered > 0) refreshRecord(record, now);
  return recovered;
}

function viewAttempt(attempt: AttemptRecord | undefined) {
  if (!attempt) return null;
  return {
    attempt: attempt.attempt,
    status: attempt.status,
    exitCode: attempt.exitCode,
    timedOut: attempt.timedOut,
    cancelled: attempt.cancelled,
    outputExceeded: attempt.outputExceeded,
    permissionDenials: [...attempt.permissionDenials],
    childPid: attempt.childPid,
    error: attempt.error
      ? {
          code: attempt.error.code,
          message: redactSecrets(attempt.error.message),
        }
      : null,
    stdoutPath: attempt.stdoutPath,
    stderrPath: attempt.stderrPath,
  };
}

function viewTask(task: TaskRecord) {
  return {
    id: task.id,
    role: task.role,
    status: task.status,
    heavy: task.heavy,
    dependsOn: [...task.dependsOn],
    candidateVersion: task.candidateVersion,
    sessionId: task.sessionId,
    attemptCount: task.attempts.length,
    structuredStatus: task.structuredStatus,
    result: task.result ? redactResult(task.result) : null,
    blockers: redactList(task.blockers),
    lastError: task.lastError ? redactSecrets(task.lastError) : null,
    queuedAt: task.queuedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    lastAttempt: viewAttempt(task.attempts.at(-1)),
  };
}

export function toRunStatusView(record: RunRecord): RunStatusView {
  return {
    runId: record.runId,
    status: record.status,
    definitionHash: record.definitionHash,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    maxConcurrent: record.definition.maxConcurrent,
    cancelRequested: record.cancelRequested,
    lastError: record.lastError ? redactSecrets(record.lastError) : null,
    summary: { ...record.summary },
    tasks: record.taskOrder
      .map((id) => record.tasks[id])
      .filter((task): task is TaskRecord => task !== undefined)
      .map(viewTask),
  };
}
