import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve, win32 } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { thsdkSessionRoot } from "../../infra/paths";
import { recordRuntimeError } from "../../infra/runtime-errors";
import {
  THSDK_CONTROL_METHODS,
  ThsdkError,
  isAllowedReadMethod,
  isMutatingMethod,
  sanitizeThsdkText,
  thsdkErrorCodes,
  validateThsdkRequestJson,
  type ThsdkErrorCode,
  type ThsdkWorkerCallMessage,
  type ThsdkWorkerMessage,
  type ThsdkWorkerReply,
} from "./thsdk-contract";

export type ThsdkClientOptions = {
  workerScriptPath?: string;
  sessionRoot?: string;
  minIntervalMs?: number;
  defaultTimeoutMs?: number;
  watchdogGraceMs?: number;
  maxConsecutiveCrashes?: number;
  circuitCooldownMs?: number;
};
export type ThsdkCallOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  dllPath: string;
  expectedSha256: string;
  sessionDir: string;
};
export type ThsdkClient = {
  invokeRead<T = unknown>(
    method: string,
    params: unknown,
    options: ThsdkCallOptions,
  ): Promise<T>;
  invokeControl<T = unknown>(
    method: string,
    params: unknown,
    options: ThsdkCallOptions,
  ): Promise<T>;
  shutdown(budgetMs?: number): Promise<void>;
  getState(): {
    running: boolean;
    generation: number;
    circuitOpenUntil: number | null;
    consecutiveCrashes: number;
    lastErrorCode: ThsdkErrorCode | null;
  };
};

const cancelled = () => new ThsdkError("cancelled", "THSDK 请求已取消");
const locked = () =>
  new ThsdkError("session_locked", "THSDK 会话已被其他进程占用");
const unavailable = () => new ThsdkError("unavailable", "THSDK 客户端不可用");

function checkedInteger(value: number, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new ThsdkError("invalid_request", "THSDK 客户端参数超出允许范围");
  return value;
}

function errno(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}

function pidMayBeAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) !== "ESRCH";
  }
}

// The kernel guard serializes stale-PID replacement as well as first creation.
// Without it two contenders can both read a dead PID and unlink the winner's lock.
async function reserveSession(root: string) {
  mkdirSync(root, { recursive: true });
  const canonical = realpathSync.native(root);
  const name = createHash("sha256")
    .update(process.platform === "win32" ? canonical.toLowerCase() : canonical)
    .digest("hex");
  const endpoint =
    process.platform === "win32"
      ? "\\\\.\\pipe\\quant-thsdk-" + name
      : process.platform === "linux"
        ? "\0quant-thsdk-" + name
        : join(canonical, ".worker.sock");
  const guard = createServer((socket) => socket.destroy());
  await new Promise<void>((done, reject) => {
    guard.once("error", reject);
    guard.listen(endpoint, () => {
      guard.off("error", reject);
      done();
    });
  }).catch((error: unknown) => {
    throw errno(error) === "EADDRINUSE" ? locked() : unavailable();
  });
  const path = join(canonical, "worker.lock");
  let published = false;
  try {
    let contents: string | undefined;
    try {
      contents = readFileSync(path, "utf8");
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
    if (contents !== undefined) {
      const { pid } = JSON.parse(contents) as { pid: number };
      if (!Number.isSafeInteger(pid) || pid <= 0) throw locked();
      if (pid !== process.pid && pidMayBeAlive(pid)) throw locked();
    }
    return {
      publish(pid: number) {
        const record = JSON.stringify({
          pid,
          startedAt: Date.now(),
          ownerPid: process.pid,
        });
        try {
          writeFileSync(path + ".tmp", record, { mode: 0o600 });
          renameSync(path + ".tmp", path);
        } catch (error) {
          rmSync(path + ".tmp", { force: true });
          throw error;
        }
        published = true;
      },
      release() {
        try {
          if (published) rmSync(path, { force: true });
        } finally {
          guard.close();
        }
      },
    };
  } catch (error) {
    guard.close();
    throw error instanceof ThsdkError ? error : unavailable();
  }
}

function minimalEnv(): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return {
    SystemRoot: systemRoot,
    PATH: [win32.join(systemRoot, "System32"), systemRoot].join(";"),
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NODE_ENV: process.env.NODE_ENV,
    // Node otherwise copies this from its own environment even with an explicit env.
    NODE_V8_COVERAGE: undefined,
  };
}

type Job = {
  call: Omit<ThsdkWorkerCallMessage, "id">;
  options: ThsdkCallOptions;
  controller: AbortController;
  sent: boolean;
  watchdog?: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: ThsdkError) => void;
};
type Session = {
  child: ChildProcess;
  key: string;
  closed: Promise<void>;
  stderr: string;
};

export function createThsdkClient(
  options: ThsdkClientOptions = {},
): ThsdkClient {
  const workerPath = resolve(
    /* turbopackIgnore: true */ options.workerScriptPath ??
      "runtime/thsdk-worker.cjs",
  );
  const maxTimerMs = 2_147_483_647;
  const interval = Math.max(
    65,
    checkedInteger(options.minIntervalMs ?? 65, 0, maxTimerMs),
  );
  const grace = checkedInteger(
    options.watchdogGraceMs ?? 500,
    0,
    maxTimerMs - 600_000,
  );
  const crashThreshold = checkedInteger(
    options.maxConsecutiveCrashes ?? 3,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const cooldown = checkedInteger(
    options.circuitCooldownMs ?? 30_000,
    0,
    maxTimerMs,
  );
  const queue = new Set<Job>();
  let current: Job | undefined;
  let draining = Promise.resolve();
  let session: Session | undefined;
  let retiring = Promise.resolve();
  let closing: Promise<void> | undefined;
  let stopped = false;
  let generation = 0;
  let sequence = 0;
  let nextDispatch = 0;
  let consecutiveCrashes = 0;
  let circuitOpenUntil = 0;
  let lastErrorCode: ThsdkErrorCode | null = null;

  function retire(s: Session) {
    session = undefined;
    generation++;
    retiring = s.closed;
    return s;
  }

  function rejectJobs(error: ThsdkError) {
    for (const job of queue) job.reject(error);
    queue.clear();
    if (current) {
      current.controller.abort(error);
      current.reject(error);
    }
  }

  function poison(s: Session, error: ThsdkError) {
    if (s !== session) return;
    retire(s).child.kill("SIGKILL");
    lastErrorCode = error.code;
    rejectJobs(error);
    if (error.code === "cancelled") return;
    if (++consecutiveCrashes >= crashThreshold)
      circuitOpenUntil = Date.now() + cooldown;
    recordRuntimeError(
      "thsdk-worker",
      error.code === "timeout" ? { code: "ETIMEDOUT" } : error,
    );
  }

  function crash(s: Session) {
    const detail = sanitizeThsdkText(s.stderr).slice(0, 512);
    poison(
      s,
      new ThsdkError("worker_crashed", detail || "THSDK 子进程异常退出"),
    );
  }

  function exchange(s: Session, message: ThsdkWorkerMessage, job: Job) {
    const signal = job.controller.signal;
    signal.throwIfAborted();
    const epoch = generation;
    job.sent = true;
    job.watchdog ??= setTimeout(
      () => poison(s, new ThsdkError("timeout", "THSDK 子进程调用超时")),
      job.call.timeoutMs + grace,
    );
    return new Promise<Extract<ThsdkWorkerReply, { ok: true }>>(
      (done, reject) => {
        const cleanup = () => {
          signal.removeEventListener("abort", onAbort);
          s.child.off("message", onReply);
        };
        const onAbort = () => {
          cleanup();
          reject(signal.reason);
        };
        const onReply = (reply: ThsdkWorkerReply) => {
          if (!reply || reply.id !== message.id || epoch !== generation) return;
          cleanup();
          if (reply.ok === true) done(reply);
          else if (
            reply.ok === false &&
            thsdkErrorCodes.includes(reply.errorCode) &&
            typeof reply.safeMessage === "string"
          )
            reject(
              new ThsdkError(
                reply.errorCode,
                sanitizeThsdkText(reply.safeMessage).slice(0, 512),
                reply.retryAfterMs,
              ),
            );
          else
            reject(
              new ThsdkError("invalid_response", "THSDK 子进程回复格式错误"),
            );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        s.child.on("message", onReply);
        try {
          s.child.send(message, (error) => {
            if (error) crash(s);
          });
        } catch {
          crash(s);
        }
      },
    );
  }

  async function ensureSession(job: Job) {
    const { sessionDir, dllPath, expectedSha256 } = job.options;
    const key = JSON.stringify([sessionDir, dllPath, expectedSha256]);
    if (session?.key === key) return session;
    if (session) retire(session).child.kill("SIGKILL");
    await retiring;
    const signal = job.controller.signal;
    signal.throwIfAborted();
    const lease = await reserveSession(
      options.sessionRoot ?? thsdkSessionRoot(),
    );
    let child: ChildProcess;
    try {
      signal.throwIfAborted();
      mkdirSync(sessionDir, { recursive: true });
      child = fork(workerPath, [], {
        cwd: sessionDir,
        env: minimalEnv(),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        execArgv: [],
      });
    } catch (error) {
      lease.release();
      throw error;
    }
    let finish!: () => void;
    const s: Session = {
      child,
      key,
      stderr: "",
      closed: new Promise<void>((done) => {
        finish = done;
      }),
    };
    session = s;
    generation++;
    child.stdout?.resume();
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      // Retain the prefix so a split credential never loses its redaction key.
      s.stderr += chunk.slice(0, 4096 - s.stderr.length);
    });
    child.on("error", () => crash(s));
    child.once("disconnect", () => crash(s));
    function onExit() {
      child.off("exit", onExit);
      child.off("close", onExit);
      if (session === s) crash(s);
      try {
        lease.release();
      } catch (error) {
        // The dead PID is reclaimable even if unlink temporarily fails.
        recordRuntimeError("thsdk-worker", error);
      } finally {
        finish();
      }
    }
    child.once("exit", onExit);
    child.once("close", onExit); // A failed spawn can emit close without exit.
    try {
      if (!child.pid) {
        crash(s);
        signal.throwIfAborted();
      }
      lease.publish(child.pid!);
      await exchange(
        s,
        {
          type: "init",
          id: ++sequence,
          parentPid: process.pid,
          dllPath,
          expectedSha256,
        },
        job,
      );
      nextDispatch = performance.now() + interval;
      return s;
    } catch (error) {
      if (session === s) retire(s).child.kill("SIGKILL");
      throw error;
    }
  }

  async function run(job: Job) {
    const s = await ensureSession(job);
    const signal = job.controller.signal;
    for (let attempt = 0; ; attempt++) {
      while (performance.now() < nextDispatch)
        await sleep(Math.ceil(nextDispatch - performance.now()), undefined, {
          signal,
        });
      signal.throwIfAborted();
      nextDispatch = performance.now() + interval;
      try {
        const reply = await exchange(s, { ...job.call, id: ++sequence }, job);
        consecutiveCrashes = 0;
        circuitOpenUntil = 0;
        lastErrorCode = null;
        return reply.data;
      } catch (error) {
        if (error instanceof ThsdkError && error.code === "timeout")
          poison(s, error);
        if (
          !(error instanceof ThsdkError) ||
          error.code !== "rate_limited" ||
          attempt !== 0 ||
          error.retryAfterMs === undefined ||
          !Number.isSafeInteger(error.retryAfterMs) ||
          error.retryAfterMs < 0 ||
          error.retryAfterMs > 1000
        )
          throw error;
        nextDispatch = Math.max(
          nextDispatch,
          performance.now() + error.retryAfterMs,
        );
      }
    }
  }

  async function drain() {
    for (const job of queue) {
      queue.delete(job);
      current = job;
      try {
        job.resolve(await run(job));
      } catch (cause) {
        const error = job.controller.signal.aborted
          ? job.controller.signal.reason
          : cause;
        const failure = error instanceof ThsdkError ? error : unavailable();
        lastErrorCode = failure.code;
        job.reject(failure);
      } finally {
        clearTimeout(job.watchdog);
        current = undefined;
      }
    }
  }

  async function invoke<T>(
    kind: "read" | "control",
    method: string,
    params: unknown,
    input: ThsdkCallOptions,
  ): Promise<T> {
    if (stopped) throw unavailable();
    if (input.signal?.aborted) throw cancelled();
    if (Date.now() < circuitOpenUntil)
      throw new ThsdkError(
        "circuit_open",
        "THSDK 子进程正在冷却",
        circuitOpenUntil - Date.now(),
      );
    if (
      kind === "read"
        ? isMutatingMethod(method) || !isAllowedReadMethod(method)
        : !THSDK_CONTROL_METHODS.has(method)
    )
      throw new ThsdkError("method_forbidden", "此调用通道禁止该方法");
    const timeoutMs = input.timeoutMs ?? options.defaultTimeoutMs ?? 15_000;
    const snapshot = JSON.parse(
      validateThsdkRequestJson(method, params, timeoutMs),
    ) as { params?: unknown };
    return new Promise<T>((done, reject) => {
      const signal = input.signal;
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const job: Job = {
        call: {
          type: "call",
          kind,
          method,
          params: snapshot.params,
          timeoutMs,
        },
        options: {
          ...input,
          sessionDir: resolve(input.sessionDir),
          dllPath: resolve(input.dllPath),
          expectedSha256: input.expectedSha256.toLowerCase(),
        },
        controller: new AbortController(),
        sent: false,
        resolve: (value) => {
          cleanup();
          done(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const abort = () => {
        const error = cancelled();
        if (current === job && job.sent && session) poison(session, error);
        else {
          queue.delete(job);
          job.controller.abort(error);
          job.reject(error);
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      queue.add(job);
      if (!current) draining = drain();
    });
  }

  function shutdown(budgetMs = 1200) {
    if (closing) return closing;
    checkedInteger(budgetMs, 0, maxTimerMs);
    stopped = true;
    rejectJobs(cancelled());
    const s = session && retire(session);
    let killTimer: NodeJS.Timeout | undefined;
    if (s) {
      const kill = () => {
        s.child.kill("SIGKILL");
      };
      if (current || budgetMs <= 0) kill();
      else {
        killTimer = setTimeout(kill, Math.max(0, budgetMs - 50));
        try {
          s.child.send({ type: "shutdown", id: ++sequence }, (error) => {
            if (error) kill();
          });
        } catch {
          kill();
        }
      }
    }
    const budget = new AbortController();
    closing = Promise.race([
      Promise.all([draining, retiring]).then(() => {}),
      sleep(Math.max(0, budgetMs), undefined, { signal: budget.signal }).then(
        () => {
          // Keep the lock until exit confirmation even if the OS misses the budget.
          throw new ThsdkError("timeout", "THSDK 子进程未在关闭时限内退出");
        },
      ),
    ]).finally(() => {
      budget.abort();
      clearTimeout(killTimer);
    });
    return closing;
  }

  return {
    invokeRead: (method, params, input) =>
      invoke("read", method, params, input),
    invokeControl: (method, params, input) =>
      invoke("control", method, params, input),
    shutdown,
    getState: () => ({
      running: !!session,
      generation,
      consecutiveCrashes,
      circuitOpenUntil: circuitOpenUntil > Date.now() ? circuitOpenUntil : null,
      lastErrorCode,
    }),
  };
}

const scope = globalThis as typeof globalThis & { thsdkClient?: ThsdkClient };
export function getThsdkClient(): ThsdkClient {
  return (scope.thsdkClient ??= createThsdkClient());
}
export async function thsdkShutdown(budgetMs?: number): Promise<void> {
  await scope.thsdkClient?.shutdown(budgetMs);
}
