import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireRunLock,
  acquireTeamLock,
  assertNoLinks,
  assertSafePath,
  assertTeamRootSafe,
  blockDependentTasks,
  buildClaudeArgs,
  cancelRun,
  createInitialRunRecord,
  dependencyFingerprint,
  ensureRunLayout,
  getRunStatus,
  isProcessAlive,
  loadRunRecord,
  observeLock,
  parseBatchDefinition,
  parseClaudeOutput,
  recoverOrphanedTasks,
  releaseRunLock,
  releaseTeamLock,
  resolveClaudeExecutable,
  resumeRunTask,
  roles,
  runChildProcess,
  runDirFor,
  saveRunRecord,
  saveRunRecordToDir,
  startRun,
  writeJsonAtomic,
  type AttemptRecord,
  type StructuredResult,
  type TaskOutcome,
  type TaskRunner,
} from "../../scripts/lib/quant-team/index";
import { parseCliArgs, runCli } from "../../scripts/quant-team";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "quant-team-"));
  roots.push(root);
  return root;
}

function teamRoot(): string {
  return join(tempRoot(), "quant-team");
}

function baseTask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    role: "researcher",
    goal: `完成 ${id} 的研究`,
    candidateVersion: "current-repo-version",
    inputRefs: [],
    completionCriteria: [`${id} 有可核实结论`],
    ...overrides,
  };
}

function batch(overrides: Record<string, unknown> = {}) {
  return { runId: "run-1", tasks: [baseTask("a")], ...overrides };
}

function result(
  status: StructuredResult["status"] = "complete",
  conclusion = "ok",
): StructuredResult {
  return {
    status,
    conclusion,
    facts: ["fact"],
    evidence: ["evidence"],
    blockers: status === "complete" ? [] : ["blocked"],
    next: ["next"],
  };
}

function completed(sessionId: string, conclusion = "ok"): TaskOutcome {
  return {
    kind: "completed",
    started: true,
    sessionId,
    structuredStatus: "complete",
    result: result("complete", conclusion),
    blockers: [],
    error: null,
    timedOut: false,
    cancelled: false,
    outputExceeded: false,
    exitCode: 0,
    permissionDenials: [],
    isError: false,
  };
}

function failedOutcome(
  sessionId: string | null,
  code = "FAILED",
  message = "failed",
): TaskOutcome {
  return {
    kind: "failed",
    started: sessionId !== null,
    sessionId,
    structuredStatus: null,
    result: null,
    blockers: [code],
    error: { code, message },
    timedOut: false,
    cancelled: false,
    outputExceeded: false,
    exitCode: 1,
    permissionDenials: [],
    isError: false,
  };
}

function blockedOutcome(sessionId: string): TaskOutcome {
  return {
    ...completed(sessionId),
    kind: "blocked",
    structuredStatus: "blocked",
    result: result("blocked", "needs more evidence"),
    blockers: ["needs more evidence"],
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected error code ${code}`);
}

async function expectCodeAsync(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected error code ${code}`);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function attemptRecord(
  sessionId: string,
  upstreamFingerprint: string,
): AttemptRecord {
  return {
    attempt: 1,
    sessionId,
    startedAt: new Date().toISOString(),
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
    upstreamFingerprint,
    childPid: null,
    stdoutPath: null,
    stderrPath: null,
    promptPath: null,
  };
}

describe("quant-team batch contract", () => {
  it("accepts six roles, forces backtester heavy, and rejects traversal or invalid graph input", () => {
    const definition = parseBatchDefinition({
      runId: "run-roles",
      maxConcurrent: 6,
      tasks: roles.map((role) => baseTask(role, { role })),
    });
    expect(definition.tasks).toHaveLength(6);
    expect(
      definition.tasks.find((task) => task.id === "backtester")?.heavy,
    ).toBe(true);
    expect(definition.tasks.find((task) => task.id === "reviewer")?.heavy).toBe(
      false,
    );

    expectCode(
      () => parseBatchDefinition(batch({ runId: "../escape" })),
      "INVALID_BATCH",
    );
    expectCode(
      () => parseBatchDefinition(batch({ tasks: [baseTask("a/b")] })),
      "INVALID_BATCH",
    );
    expectCode(
      () =>
        parseBatchDefinition(
          batch({ tasks: [baseTask("a", { inputRefs: ["../secret"] })] }),
        ),
      "INVALID_BATCH",
    );
    expectCode(
      () => parseBatchDefinition(batch({ maxConcurrent: 7 })),
      "INVALID_BATCH",
    );
    expectCode(
      () =>
        parseBatchDefinition(
          batch({ tasks: [baseTask("a", { timeoutMs: 0 })] }),
        ),
      "INVALID_BATCH",
    );
    expectCode(
      () => parseBatchDefinition({ runId: "run-1", tasks: [] }),
      "INVALID_BATCH",
    );
    expectCode(
      () =>
        parseBatchDefinition(
          batch({
            tasks: [baseTask("a"), baseTask("a")],
          }),
        ),
      "DUPLICATE_TASK_ID",
    );
    expectCode(
      () =>
        parseBatchDefinition(
          batch({ tasks: [baseTask("a", { dependsOn: ["a"] })] }),
        ),
      "SELF_DEPENDENCY",
    );
    expectCode(
      () =>
        parseBatchDefinition(
          batch({ tasks: [baseTask("a", { dependsOn: ["missing"] })] }),
        ),
      "UNKNOWN_DEPENDENCY",
    );
    expectCode(
      () =>
        parseBatchDefinition(
          batch({
            tasks: [
              baseTask("a", { dependsOn: ["b"] }),
              baseTask("b", { dependsOn: ["a"] }),
            ],
          }),
        ),
      "DEPENDENCY_CYCLE",
    );
  });

  it("refuses traversal identifiers and symlink/junction escapes on run paths", () => {
    const root = tempRoot();
    const team = join(root, "team");
    const outside = join(root, "outside");
    mkdirSync(team, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const link = join(team, "evil");
    symlinkSync(
      outside,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );

    expectCode(() => assertNoLinks(team, link), "UNSAFE_PATH");
    expectCode(
      () => assertSafePath(team, join(team, "..", "outside")),
      "UNSAFE_PATH",
    );
    expectCode(() => runDirFor(team, "../escape"), "INVALID_IDENTIFIER");

    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const dataLink = join(repo, ".test-data");
    symlinkSync(
      outside,
      dataLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    expectCode(
      () => assertTeamRootSafe(join(dataLink, "quant-team"), repo),
      "UNSAFE_PATH",
    );
    const rootLink = join(repo, "team-link");
    symlinkSync(
      outside,
      rootLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    expectCode(() => assertTeamRootSafe(rootLink, repo), "UNSAFE_PATH");
  });
});

describe("quant-team scheduler", () => {
  it("runs six independent roles concurrently and never exceeds maxConcurrent", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const runner: TaskRunner = async (request) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(30);
      active -= 1;
      return completed(request.sessionId);
    };
    const record = await startRun(
      {
        runId: "run-concurrency",
        maxConcurrent: 6,
        tasks: roles.map((role) => baseTask(role, { role })),
      },
      { teamRoot: teamRoot(), runner },
    );
    expect(calls).toBe(6);
    expect(maxActive).toBe(6);
    expect(record.status).toBe("completed");
    expect(record.summary).toMatchObject({ total: 6, completed: 6 });
  });

  it("allows one heavy build/backtest at a time and forces backtester heavy", async () => {
    let active = 0;
    let heavyActive = 0;
    let maxActive = 0;
    let maxHeavy = 0;
    const seen: Array<{ id: string; heavy: boolean }> = [];
    const runner: TaskRunner = async (request) => {
      active += 1;
      if (request.task.heavy) heavyActive += 1;
      maxActive = Math.max(maxActive, active);
      maxHeavy = Math.max(maxHeavy, heavyActive);
      seen.push({ id: request.task.id, heavy: request.task.heavy });
      await wait(40);
      if (request.task.heavy) heavyActive -= 1;
      active -= 1;
      return completed(request.sessionId);
    };
    const record = await startRun(
      {
        runId: "run-heavy",
        tasks: [
          baseTask("h1", { role: "backtester", heavy: false }),
          baseTask("h2", { role: "backtester" }),
          baseTask("n1", { role: "researcher" }),
        ],
      },
      { teamRoot: teamRoot(), runner },
    );
    expect(maxHeavy).toBe(1);
    expect(maxActive).toBe(2);
    expect(seen.find((item) => item.id === "h1")?.heavy).toBe(true);
    expect(seen.find((item) => item.id === "h2")?.heavy).toBe(true);
    expect(record.status).toBe("completed");
  });

  it("blocks downstream tasks for failed and blocked dependencies instead of hanging", async () => {
    const called: string[] = [];
    const runner: TaskRunner = async (request) => {
      called.push(request.task.id);
      if (request.task.id === "f")
        return failedOutcome(request.sessionId, "FAILED");
      if (request.task.id === "b") return blockedOutcome(request.sessionId);
      return completed(request.sessionId);
    };
    const record = await startRun(
      {
        runId: "run-deps",
        tasks: [
          baseTask("f", { role: "data" }),
          baseTask("fc", { dependsOn: ["f"] }),
          baseTask("b", { role: "risk" }),
          baseTask("bc", { dependsOn: ["b"] }),
        ],
      },
      { teamRoot: teamRoot(), runner },
    );
    expect(called.sort()).toEqual(["b", "f"]);
    expect(record.tasks.f?.status).toBe("failed");
    expect(record.tasks.b?.status).toBe("blocked");
    expect(record.tasks.fc?.status).toBe("blocked");
    expect(record.tasks.fc?.blockers).toEqual(["dependency:f:failed"]);
    expect(record.tasks.bc?.blockers).toEqual(["dependency:b:blocked"]);
    expect(record.status).toBe("failed");
    expect(record.summary).toMatchObject({ failed: 1, blocked: 3 });
  });

  it("treats a cancelled dependency as blocking for its dependents", () => {
    const definition = parseBatchDefinition(
      batch({
        runId: "run-cancel-dep",
        tasks: [baseTask("a"), baseTask("b", { dependsOn: ["a"] })],
      }),
    );
    const record = createInitialRunRecord(definition, new Date().toISOString());
    const dependency = record.tasks.a;
    if (!dependency) throw new Error("missing task a");
    dependency.status = "cancelled";
    expect(blockDependentTasks(record, new Date().toISOString())).toEqual([
      "b",
    ]);
    expect(record.tasks.b?.blockers).toEqual(["dependency:a:cancelled"]);
  });

  it("does not launch backtest when the risk gate returns blocked", async () => {
    const called: string[] = [];
    const runner: TaskRunner = async (request) => {
      called.push(request.task.id);
      if (request.task.id === "risk-before")
        return blockedOutcome(request.sessionId);
      return completed(request.sessionId);
    };
    const record = await startRun(
      {
        runId: "run-risk-gate",
        tasks: [
          baseTask("risk-before", { role: "risk" }),
          baseTask("backtest", {
            role: "backtester",
            dependsOn: ["risk-before"],
          }),
        ],
      },
      { teamRoot: teamRoot(), runner },
    );
    expect(called).toEqual(["risk-before"]);
    expect(record.tasks.backtest?.status).toBe("blocked");
    expect(record.tasks.backtest?.blockers).toEqual([
      "dependency:risk-before:blocked",
    ]);
    expect(record.status).toBe("blocked");
  });

  it("returns the existing state for the same run definition and rejects a changed one", async () => {
    let calls = 0;
    const runner: TaskRunner = async (request) => {
      calls += 1;
      return completed(request.sessionId);
    };
    const root = teamRoot();
    const first = await startRun(batch(), { teamRoot: root, runner });
    const second = await startRun(batch(), { teamRoot: root, runner });
    expect(first.status).toBe("completed");
    expect(second.definitionHash).toBe(first.definitionHash);
    expect(calls).toBe(1);
    await expectCodeAsync(
      () =>
        startRun(
          batch({ tasks: [baseTask("a", { goal: "changed definition" })] }),
          { teamRoot: root, runner },
        ),
      "DEFINITION_CONFLICT",
    );
  });
});

describe("quant-team coordinator ownership", () => {
  it("rejects an overlapping run id with TEAM_BUSY instead of exceeding the team-wide cap", async () => {
    let startedResolve: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const root = teamRoot();
    let secondCalls = 0;
    const first = startRun(batch({ runId: "run-team-a" }), {
      teamRoot: root,
      runner: async (request) => {
        startedResolve();
        await gate;
        return completed(request.sessionId);
      },
    });
    await started;
    await expectCodeAsync(
      () =>
        startRun(batch({ runId: "run-team-b" }), {
          teamRoot: root,
          runner: async (request) => {
            secondCalls += 1;
            return completed(request.sessionId);
          },
        }),
      "TEAM_BUSY",
    );
    expect(secondCalls).toBe(0);
    release();
    expect((await first).status).toBe("completed");
    const second = await startRun(batch({ runId: "run-team-b" }), {
      teamRoot: root,
      runner: async (request) => {
        secondCalls += 1;
        return completed(request.sessionId);
      },
    });
    expect(second.status).toBe("completed");
    expect(secondCalls).toBe(1);
  });

  it("releases the team lock only with its own token", () => {
    const root = teamRoot();
    const lock = acquireTeamLock(root);
    expect(releaseTeamLock({ ...lock, token: "not-mine" })).toBe(false);
    expect(releaseTeamLock(lock)).toBe(true);
  });
});

describe("quant-team resume and cancellation", () => {
  it("resumes only failed tasks with the exact stored session id and preserves attempts", async () => {
    const attemptsSeen: string[] = [];
    const runner: TaskRunner = async (request) => {
      attemptsSeen.push(`${request.resume}:${request.sessionId}`);
      if (!request.resume)
        return failedOutcome(request.sessionId, "TRANSIENT", "try later");
      return completed(request.sessionId);
    };
    const root = teamRoot();
    const record = await startRun(batch(), { teamRoot: root, runner });
    const sessionId = record.tasks.a?.sessionId;
    expect(record.tasks.a?.status).toBe("failed");
    expect(sessionId).toBeTruthy();
    expect(attemptsSeen).toEqual([`false:${sessionId}`]);

    const resumed = await resumeRunTask("run-1", "a", {
      teamRoot: root,
      runner,
    });
    expect(resumed.tasks.a?.status).toBe("completed");
    expect(resumed.tasks.a?.attempts).toHaveLength(2);
    expect(resumed.tasks.a?.attempts[0]?.sessionId).toBe(sessionId);
    expect(resumed.tasks.a?.attempts[1]?.sessionId).toBe(sessionId);
    expect(attemptsSeen).toEqual([`false:${sessionId}`, `true:${sessionId}`]);
    await expectCodeAsync(
      () => resumeRunTask("run-1", "a", { teamRoot: root, runner }),
      "TASK_COMPLETE",
    );
  });

  it("rejects resume without a known session and when upstream results changed", async () => {
    const runner: TaskRunner = async (request) => {
      if (request.task.id === "a") return completed(request.sessionId);
      return failedOutcome(request.sessionId, "FAILED");
    };
    const root = teamRoot();
    const record = await startRun(
      {
        runId: "run-upstream",
        tasks: [baseTask("a"), baseTask("b", { dependsOn: ["a"] })],
      },
      { teamRoot: root, runner },
    );
    expect(record.tasks.a?.status).toBe("completed");
    expect(record.tasks.b?.status).toBe("failed");

    const upstreamChanged = loadRunRecord(root, "run-upstream");
    const upstreamTask = upstreamChanged.tasks.a;
    const upstreamResult = upstreamTask?.result;
    if (!upstreamTask || !upstreamResult) throw new Error("missing upstream");
    upstreamTask.result = { ...upstreamResult, conclusion: "changed upstream" };
    saveRunRecord(root, upstreamChanged);

    await expectCodeAsync(
      () => resumeRunTask("run-upstream", "b", { teamRoot: root, runner }),
      "UPSTREAM_CHANGED",
    );

    const blockedRoot = teamRoot();
    await startRun(
      {
        runId: "run-unknown-session",
        tasks: [baseTask("a"), baseTask("b", { dependsOn: ["a"] })],
      },
      {
        teamRoot: blockedRoot,
        runner: async (request) =>
          request.task.id === "a"
            ? failedOutcome(request.sessionId, "FAILED")
            : completed(request.sessionId),
      },
    );
    await expectCodeAsync(
      () =>
        resumeRunTask("run-unknown-session", "b", {
          teamRoot: blockedRoot,
          runner,
        }),
      "UNKNOWN_SESSION",
    );

    const spawnRoot = teamRoot();
    await startRun(batch({ runId: "run-no-session" }), {
      teamRoot: spawnRoot,
      runner: async () => failedOutcome(null, "SPAWN_ERROR"),
    });
    expect(loadRunRecord(spawnRoot, "run-no-session").tasks.a?.sessionId).toBe(
      null,
    );
    await expectCodeAsync(
      () =>
        resumeRunTask("run-no-session", "a", {
          teamRoot: spawnRoot,
          runner,
        }),
      "UNKNOWN_SESSION",
    );
  });

  it("refuses a duplicate active resume while the first coordinator holds the lock", async () => {
    let resumeStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      resumeStarted = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: TaskRunner = async (request) => {
      if (!request.resume)
        return failedOutcome(request.sessionId, "FAILED", "first attempt");
      resumeStarted();
      await gate;
      return completed(request.sessionId);
    };
    const root = teamRoot();
    await startRun(batch(), { teamRoot: root, runner });
    const firstResume = resumeRunTask("run-1", "a", {
      teamRoot: root,
      runner,
      pollIntervalMs: 20,
    });
    await started;
    await expectCodeAsync(
      () => resumeRunTask("run-1", "a", { teamRoot: root, runner }),
      "TEAM_BUSY",
    );
    release();
    const resumed = await firstResume;
    expect(resumed.tasks.a?.status).toBe("completed");
  });

  it("cancels queued tasks immediately and stops a running owned task through the coordinator", async () => {
    let startedResolve: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let calls = 0;
    const runner: TaskRunner = async (request) => {
      calls += 1;
      if (request.task.id === "a") {
        startedResolve();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return {
          ...completed(request.sessionId),
          kind: "cancelled",
          structuredStatus: null,
          result: null,
          blockers: ["cancelled"],
          cancelled: true,
        };
      }
      return completed(request.sessionId);
    };
    const root = teamRoot();
    const running = startRun(
      {
        runId: "run-cancel",
        maxConcurrent: 1,
        tasks: [baseTask("a"), baseTask("b")],
      },
      { teamRoot: root, runner, pollIntervalMs: 20 },
    );
    await started;
    const cancellation = await cancelRun("run-cancel", null, {
      teamRoot: root,
    });
    expect(cancellation.mode).toBe("requested");
    const record = await running;
    expect(calls).toBe(1);
    expect(record.status).toBe("cancelled");
    expect(record.tasks.a?.status).toBe("cancelled");
    expect(record.tasks.b?.status).toBe("cancelled");
    expect(record.summary).toMatchObject({ cancelled: 2 });
  });

  it("keeps partial cancellation accurate when only one running task is cancelled", async () => {
    let startedResolve: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const runner: TaskRunner = async (request) => {
      if (request.task.id === "a") {
        startedResolve();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return {
          ...completed(request.sessionId),
          kind: "cancelled",
          structuredStatus: null,
          result: null,
          blockers: ["cancelled"],
          cancelled: true,
        };
      }
      return completed(request.sessionId);
    };
    const root = teamRoot();
    const running = startRun(
      {
        runId: "run-partial-cancel",
        maxConcurrent: 2,
        tasks: [baseTask("a"), baseTask("b")],
      },
      { teamRoot: root, runner, pollIntervalMs: 20 },
    );
    await started;
    const cancellation = await cancelRun("run-partial-cancel", "a", {
      teamRoot: root,
    });
    expect(cancellation.mode).toBe("requested");
    const record = await running;
    expect(record.tasks.a?.status).toBe("cancelled");
    expect(record.tasks.b?.status).toBe("completed");
    expect(record.status).toBe("cancelled");
    expect(record.summary).toMatchObject({ completed: 1, cancelled: 1 });
  });

  it("releases the heavy slot only after the cancelled heavy task exits", async () => {
    let startedResolve: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const events: string[] = [];
    const runner: TaskRunner = async (request) => {
      if (request.task.id === "h1") {
        events.push("h1-start");
        startedResolve();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        events.push("h1-exit");
        return {
          ...completed(request.sessionId),
          kind: "cancelled",
          structuredStatus: null,
          result: null,
          blockers: ["cancelled"],
          cancelled: true,
        };
      }
      events.push("h2-start");
      return completed(request.sessionId);
    };
    const root = teamRoot();
    const running = startRun(
      {
        runId: "run-heavy-cancel",
        tasks: [
          baseTask("h1", { role: "backtester" }),
          baseTask("h2", { role: "backtester" }),
        ],
      },
      { teamRoot: root, runner, pollIntervalMs: 20 },
    );
    await started;
    const cancellation = await cancelRun("run-heavy-cancel", "h1", {
      teamRoot: root,
    });
    expect(cancellation.mode).toBe("requested");
    const record = await running;
    expect(events).toEqual(["h1-start", "h1-exit", "h2-start"]);
    expect(record.tasks.h1?.status).toBe("cancelled");
    expect(record.tasks.h2?.status).toBe("completed");
  });

  it("applies a cancel immediately when no coordinator owns the lock", async () => {
    const root = teamRoot();
    await startRun(batch(), {
      teamRoot: root,
      runner: async (request) => completed(request.sessionId),
    });
    const result = await cancelRun("run-1", null, { teamRoot: root });
    expect(result.mode).toBe("applied");
    expect(result.state.status).toBe("cancelled");
  });

  it("recovers crashed running tasks as interrupted and resumes them explicitly", async () => {
    const root = teamRoot();
    const definition = parseBatchDefinition({
      runId: "run-orphan",
      tasks: [baseTask("a")],
    });
    const { runDir } = ensureRunLayout(root, "run-orphan");
    const record = createInitialRunRecord(definition, new Date().toISOString());
    const task = record.tasks.a;
    if (!task) throw new Error("missing task a");
    task.status = "running";
    task.sessionId = "stored-session";
    task.startedAt = new Date().toISOString();
    const deadChild = spawnSync(process.execPath, ["-e", ""]);
    const storedAttempt = attemptRecord(
      "stored-session",
      dependencyFingerprint(record, task),
    );
    storedAttempt.childPid = deadChild.pid ?? null;
    task.attempts = [storedAttempt];
    saveRunRecordToDir(runDir, record);

    const loaded = loadRunRecord(root, "run-orphan");
    expect(recoverOrphanedTasks(loaded)).toBe(1);
    saveRunRecord(root, loaded);
    const recovered = loadRunRecord(root, "run-orphan");
    expect(recovered.tasks.a?.status).toBe("failed");
    expect(recovered.tasks.a?.blockers).toEqual(["interrupted"]);
    expect(recovered.tasks.a?.attempts[0]?.error?.code).toBe("INTERRUPTED");

    let requestSeen: { resume: boolean; sessionId: string } | null = null;
    const runner: TaskRunner = async (request) => {
      requestSeen = {
        resume: request.resume,
        sessionId: request.sessionId,
      };
      return completed(request.sessionId);
    };
    const resumed = await resumeRunTask("run-orphan", "a", {
      teamRoot: root,
      runner,
    });
    expect(requestSeen).toEqual({
      resume: true,
      sessionId: "stored-session",
    });
    expect(resumed.tasks.a?.status).toBe("completed");
    expect(resumed.tasks.a?.attempts).toHaveLength(2);

    // A resume queued before a crash must not auto-run when `run` is repeated.
    const queuedDefinition = parseBatchDefinition({
      runId: "run-orphan-resume",
      tasks: [baseTask("a")],
    });
    const { runDir: queuedRunDir } = ensureRunLayout(root, "run-orphan-resume");
    const queuedRecord = createInitialRunRecord(
      queuedDefinition,
      new Date().toISOString(),
    );
    const queuedTask = queuedRecord.tasks.a;
    if (!queuedTask) throw new Error("missing queued task a");
    const queuedAttempt = attemptRecord(
      "queued-session",
      dependencyFingerprint(queuedRecord, queuedTask),
    );
    queuedAttempt.status = "failed";
    queuedAttempt.finishedAt = new Date().toISOString();
    queuedTask.sessionId = "queued-session";
    queuedTask.pendingResume = true;
    queuedTask.attempts = [queuedAttempt];
    saveRunRecordToDir(queuedRunDir, queuedRecord);

    let autoCalls = 0;
    const noAutoRunner: TaskRunner = async (request) => {
      autoCalls += 1;
      return completed(request.sessionId);
    };
    const repeated = await startRun(
      { runId: "run-orphan-resume", tasks: [baseTask("a")] },
      { teamRoot: root, runner: noAutoRunner },
    );
    expect(autoCalls).toBe(0);
    expect(repeated.tasks.a?.status).toBe("failed");
    expect(repeated.tasks.a?.blockers).toEqual(["interrupted"]);
    const queuedResumed = await resumeRunTask("run-orphan-resume", "a", {
      teamRoot: root,
      runner: noAutoRunner,
    });
    expect(queuedResumed.tasks.a?.status).toBe("completed");
    expect(queuedResumed.tasks.a?.attempts.at(-1)?.sessionId).toBe(
      "queued-session",
    );
  });
});

describe("quant-team orphan child safety", () => {
  it("refuses resume while the prior child PID is still alive and never kills it", async () => {
    const root = teamRoot();
    const definition = parseBatchDefinition({
      runId: "run-orphan-child",
      tasks: [baseTask("a")],
    });
    const { runDir } = ensureRunLayout(root, "run-orphan-child");
    const record = createInitialRunRecord(definition, new Date().toISOString());
    const task = record.tasks.a;
    if (!task) throw new Error("missing task a");
    task.status = "running";
    task.sessionId = "orphan-session";
    task.startedAt = new Date().toISOString();
    const attempt = attemptRecord(
      "orphan-session",
      dependencyFingerprint(record, task),
    );
    attempt.childPid = process.pid;
    task.attempts = [attempt];
    saveRunRecordToDir(runDir, record);

    const loaded = loadRunRecord(root, "run-orphan-child");
    expect(recoverOrphanedTasks(loaded)).toBe(1);
    expect(loaded.tasks.a?.status).toBe("blocked");
    expect(loaded.tasks.a?.blockers[0]).toMatch(/^orphan_child_alive:/);
    saveRunRecord(root, loaded);

    let calls = 0;
    await expectCodeAsync(
      () =>
        resumeRunTask("run-orphan-child", "a", {
          teamRoot: root,
          runner: async (request) => {
            calls += 1;
            return completed(request.sessionId);
          },
        }),
      "ORPHAN_CHILD_ALIVE",
    );
    expect(calls).toBe(0);
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});

describe("quant-team Claude process boundary", () => {
  it("rejects malformed exit-0 output and blocks on permission denials", () => {
    const malformed = parseClaudeOutput({ stdout: "not json", exitCode: 0 });
    expect(malformed.kind).toBe("failed");
    expect(malformed.error?.code).toBe("MALFORMED_OUTPUT");

    const structuredOutput = result("complete");
    const valid = {
      session_id: "session-1",
      is_error: false,
      structured_output: structuredOutput,
    };
    const ok = parseClaudeOutput({
      stdout: JSON.stringify(valid),
      exitCode: 0,
    });
    expect(ok.kind).toBe("completed");
    expect(ok.sessionId).toBe("session-1");

    const denied = parseClaudeOutput({
      stdout: JSON.stringify({
        ...valid,
        permission_denials: [
          { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
        ],
      }),
      exitCode: 0,
    });
    expect(denied.kind).toBe("blocked");
    expect(denied.blockers).toEqual(["permission_denied:Bash"]);
    expect(JSON.stringify(denied)).not.toContain("rm -rf");

    const error = parseClaudeOutput({
      stdout: JSON.stringify({ ...valid, is_error: true, result: "boom" }),
      exitCode: 0,
    });
    expect(error.kind).toBe("failed");
    expect(error.error?.code).toBe("CLAUDE_ERROR");

    const missing = parseClaudeOutput({
      stdout: JSON.stringify({ session_id: "s", is_error: false }),
      exitCode: 0,
    });
    expect(missing.error?.code).toBe("MISSING_STRUCTURED_OUTPUT");

    const badSchema = parseClaudeOutput({
      stdout: JSON.stringify({
        session_id: "s",
        structured_output: { status: "complete" },
      }),
      exitCode: 0,
    });
    expect(badSchema.error?.code).toBe("MALFORMED_STRUCTURED_OUTPUT");

    const completeWithBlockers = parseClaudeOutput({
      stdout: JSON.stringify({
        session_id: "s",
        structured_output: {
          ...structuredOutput,
          blockers: ["risk veto must be blocked"],
        },
      }),
      exitCode: 0,
    });
    expect(completeWithBlockers.kind).toBe("failed");
    expect(completeWithBlockers.error?.code).toBe(
      "MALFORMED_STRUCTURED_OUTPUT",
    );

    expect(
      parseClaudeOutput({
        stdout: "",
        exitCode: 0,
        timedOut: true,
      }).error?.code,
    ).toBe("TIMEOUT");
    expect(
      parseClaudeOutput({
        stdout: "",
        exitCode: null,
        cancelled: true,
      }).kind,
    ).toBe("cancelled");
  });

  it("builds CLI args without model/effort overrides and restricts the tool surface", () => {
    const read = buildClaudeArgs({
      role: "researcher",
      sessionId: "session-1",
      resume: false,
    });
    expect(read).toContain("--print");
    expect(read).toContain("--output-format");
    expect(read).toContain("--json-schema");
    expect(read[read.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    expect(read[read.indexOf("--session-id") + 1]).toBe("session-1");
    expect(read).toContain("--strict-mcp-config");
    expect(read[read.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(read.join(" ")).not.toMatch(
      /--model|--effort|--continue|--allowedTools|dangerously|acceptEdits/,
    );

    const resumed = buildClaudeArgs({
      role: "backtester",
      sessionId: "session-2",
      resume: true,
    });
    const tools = resumed[resumed.indexOf("--tools") + 1] ?? "";
    expect(tools).toContain("Bash");
    expect(tools).not.toMatch(/Agent|Task|Write|Edit/);
    expect(resumed.slice(resumed.indexOf("--resume"))).toEqual([
      "--resume",
      "session-2",
    ]);
    expect(resumed).not.toContain("--continue");
  });

  it("resolves PATH shims to the installed binary and has no hardcoded fallback", () => {
    const root = tempRoot();
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "claude.cmd"),
      '@echo off\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\n',
    );
    const packageBin = join(
      bin,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
    );
    mkdirSync(packageBin, { recursive: true });
    const native = join(packageBin, "claude.exe");
    writeFileSync(native, "");
    expect(resolveClaudeExecutable(bin, "win32")).toBe(native);

    const unixBin = join(root, "unix-bin");
    mkdirSync(unixBin, { recursive: true });
    const unixExecutable = join(unixBin, "claude");
    writeFileSync(unixExecutable, "#!/bin/sh\n");
    chmodSync(unixExecutable, 0o755);
    expect(resolveClaudeExecutable(unixBin, "linux")).toBe(unixExecutable);

    expectCode(
      () => resolveClaudeExecutable("", process.platform),
      "CLAUDE_EXECUTABLE_NOT_FOUND",
    );
  });

  it("distinguishes timeout from cancellation and reaps the owned node child", async () => {
    const script = "setInterval(()=>{},1000)";
    const timedOut = await runChildProcess({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 150,
    });
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.cancelled).toBe(false);
    expect(timedOut.pid).not.toBeNull();
    await wait(150);
    if (timedOut.pid !== null) expect(isProcessAlive(timedOut.pid)).toBe(false);

    const controller = new AbortController();
    const running = runChildProcess({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    await wait(150);
    controller.abort();
    const cancelled = await running;
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.timedOut).toBe(false);
    await wait(150);
    if (cancelled.pid !== null)
      expect(isProcessAlive(cancelled.pid)).toBe(false);
  });

  it("bounds output, keeps only partial content and marks the task failed", async () => {
    const child = await runChildProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(4000))"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
      maxBytesPerStream: 100,
    });
    expect(child.outputExceeded).toBe(true);
    expect(child.stdout).toHaveLength(100);
    const parsed = parseClaudeOutput({
      stdout: child.stdout,
      stderr: child.stderr,
      exitCode: child.exitCode,
      outputExceeded: child.outputExceeded,
    });
    expect(parsed.kind).toBe("failed");
    expect(parsed.error?.code).toBe("OUTPUT_LIMIT");
  });

  it("passes isolated absolute QUANT_DATA_DIR and temp directories per task attempt", async () => {
    const capture: { env: NodeJS.ProcessEnv | null } = { env: null };
    const root = teamRoot();
    await startRun(batch(), {
      teamRoot: root,
      runner: async (request) => {
        capture.env = request.env;
        return completed(request.sessionId);
      },
    });
    const captured = capture.env;
    if (!captured) throw new Error("runner did not receive env");
    const keys = ["QUANT_DATA_DIR", "TEMP", "TMP", "TMPDIR"] as const;
    for (const key of keys) {
      const value = captured[key];
      expect(typeof value).toBe("string");
      expect(isAbsolute(value ?? "")).toBe(true);
      expect(value).toContain(join("tasks", "a", "attempt-1"));
      expect(statSync(value ?? "").isDirectory()).toBe(true);
    }
    expect(captured.QUANT_DATA_DIR).not.toBe(process.env.QUANT_DATA_DIR);
    expect(new Set([captured.TEMP, captured.TMP, captured.TMPDIR]).size).toBe(
      1,
    );
  });
});

describe("quant-team persistence and redaction", () => {
  it("prevents overlapping coordinators and replaces a lock only after the owner is dead", () => {
    const root = teamRoot();
    const { runDir } = ensureRunLayout(root, "run-lock");
    const lock = acquireRunLock(runDir);
    expectCode(() => acquireRunLock(runDir), "LOCK_ACTIVE");
    expect(releaseRunLock({ ...lock, token: "not-mine" })).toBe(false);
    expect(observeLock(runDir).state).toBe("active");
    expect(releaseRunLock(lock)).toBe(true);
    expect(observeLock(runDir).state).toBe("none");

    const dead = spawnSync(process.execPath, ["-e", ""]);
    writeJsonAtomic(join(runDir, "run.lock"), {
      token: "dead",
      pid: dead.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    });
    expect(observeLock(runDir).state).toBe("stale");
    const replacement = acquireRunLock(runDir);
    expect(replacement.pid).toBe(process.pid);
    expect(releaseRunLock(replacement)).toBe(true);
  });

  it("redacts secrets from persisted summaries and status views", async () => {
    const root = teamRoot();
    const secret = "sk-abcdefghijklmnopqrstuvwxyz";
    await startRun(batch(), {
      teamRoot: root,
      runner: async (request) => ({
        ...completed(request.sessionId, `token ${secret}`),
        blockers: ["api_key=supersecret"],
      }),
    });
    const state = readFileSync(join(root, "run-1", "run.json"), "utf8");
    const view = JSON.stringify(getRunStatus("run-1", { teamRoot: root }));
    expect(state).not.toContain(secret);
    expect(state).not.toContain("supersecret");
    expect(view).not.toContain(secret);
    expect(view).not.toContain("supersecret");
  });

  it("parses CLI commands and runs a batch through the injected runner", async () => {
    expect(parseCliArgs(["--help"])).toEqual({ command: "help" });
    expect(parseCliArgs(["cancel", "--run", "run-1", "--task", "a"])).toEqual({
      command: "cancel",
      run: "run-1",
      task: "a",
    });
    expectCode(() => parseCliArgs(["run"]), "INVALID_CLI");
    expectCode(
      () => parseCliArgs(["status", "--run", "run-1", "--input", "x"]),
      "INVALID_CLI",
    );

    const root = tempRoot();
    const input = join(root, "batch.json");
    writeFileSync(
      input,
      JSON.stringify({
        runId: "cli-run",
        tasks: [baseTask("a")],
      }),
    );
    const result = await runCli(["run", "--input", input], {
      teamRoot: join(root, "team"),
      runner: async (request) => completed(request.sessionId),
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      state: { runId: string; status: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.state.runId).toBe("cli-run");
    expect(payload.state.status).toBe("completed");
  });
});
