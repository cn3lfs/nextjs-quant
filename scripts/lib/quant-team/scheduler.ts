import { hashParts, type RunRecord, type TaskRecord } from "./types";

export function dependencyFingerprint(
  record: RunRecord,
  task: TaskRecord,
): string {
  return hashParts(
    task.dependsOn.map((id) => {
      const dependency = record.tasks[id];
      return {
        id,
        status: dependency?.status ?? "missing",
        sessionId: dependency?.sessionId ?? null,
        candidateVersion: dependency?.candidateVersion ?? null,
        result: dependency?.result ?? null,
      };
    }),
  );
}

/**
 * A dependency only unblocks downstream when it completed successfully.
 * Blocked, failed and cancelled dependencies block their dependents instead of
 * leaving the graph hanging.
 */
export function blockDependentTasks(record: RunRecord, now: string): string[] {
  const blocked: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of record.taskOrder) {
      const task = record.tasks[id];
      if (!task || task.status !== "queued") continue;
      const terminalDependency = task.dependsOn.find((dependencyId) => {
        const dependency = record.tasks[dependencyId];
        return (
          !dependency ||
          dependency.status === "blocked" ||
          dependency.status === "failed" ||
          dependency.status === "cancelled"
        );
      });
      if (!terminalDependency) continue;
      const dependency = record.tasks[terminalDependency];
      task.status = "blocked";
      task.blockers = [
        `dependency:${terminalDependency}:${dependency?.status ?? "missing"}`,
      ];
      task.lastError = `依赖 ${terminalDependency} 未成功完成，下游任务被阻断`;
      task.finishedAt = now;
      blocked.push(id);
      changed = true;
    }
  }
  return blocked;
}

export function activeHeavyCount(
  activeIds: Iterable<string>,
  record: RunRecord,
) {
  let count = 0;
  for (const id of activeIds) if (record.tasks[id]?.heavy === true) count += 1;
  return count;
}

export function selectStartableTasks(
  record: RunRecord,
  runningTotal: number,
  runningHeavy: number,
): string[] {
  const startable: string[] = [];
  let total = runningTotal;
  let heavy = runningHeavy;
  for (const id of record.taskOrder) {
    const task = record.tasks[id];
    if (!task || task.status !== "queued") continue;
    const dependenciesComplete = task.dependsOn.every(
      (dependencyId) => record.tasks[dependencyId]?.status === "completed",
    );
    if (!dependenciesComplete) continue;
    if (total >= record.definition.maxConcurrent) break;
    if (task.heavy && heavy >= 1) continue;
    startable.push(id);
    total += 1;
    if (task.heavy) heavy += 1;
  }
  return startable;
}

export function hasPendingWork(record: RunRecord): boolean {
  return Object.values(record.tasks).some(
    (task) => task.status === "queued" || task.status === "running",
  );
}

export function hasQueuedTasks(record: RunRecord): boolean {
  return Object.values(record.tasks).some((task) => task.status === "queued");
}

export function cancelQueuedTasks(
  record: RunRecord,
  now: string,
  onlyIds?: ReadonlySet<string>,
): string[] {
  const cancelled: string[] = [];
  for (const id of record.taskOrder) {
    const task = record.tasks[id];
    if (
      !task ||
      task.status !== "queued" ||
      (onlyIds !== undefined && !onlyIds.has(id))
    )
      continue;
    task.status = "cancelled";
    task.cancelRequested = true;
    task.blockers = ["cancelled_before_start"];
    task.lastError = "任务在开始前被取消";
    task.finishedAt = now;
    cancelled.push(id);
  }
  return cancelled;
}

export function completedDependencyResults(
  record: RunRecord,
  task: TaskRecord,
): Array<{
  id: string;
  result: NonNullable<TaskRecord["result"]>;
  sessionId: string | null;
}> {
  return task.dependsOn.flatMap((id) => {
    const dependency = record.tasks[id];
    if (!dependency || dependency.status !== "completed" || !dependency.result)
      return [];
    return [{ id, result: dependency.result, sessionId: dependency.sessionId }];
  });
}
