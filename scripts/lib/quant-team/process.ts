import { spawn, type ChildProcess } from "node:child_process";
import { MAX_OUTPUT_BYTES } from "./types";

export type ChildProcessRequest = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBytesPerStream?: number;
  onSpawn?: (pid: number) => void;
};

export type ChildProcessResult = {
  pid: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  outputExceeded: boolean;
  spawnError: string | null;
};

type Collector = {
  push: (chunk: Buffer) => void;
  text: () => string;
};

// Once the owned child exits, descendants may still hold the inherited
// stdout/stderr pipe handles. Wait briefly for trailing bytes, then release
// our own stream ends instead of waiting for the unrelated holders to exit.
const OUTPUT_DRAIN_MS = 250;

function createCollector(limit: number, onExceed: () => void): Collector {
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  return {
    push(chunk) {
      if (exceeded) return;
      const remaining = limit - size;
      if (remaining <= 0) {
        exceeded = true;
        onExceed();
        return;
      }
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        size = limit;
        exceeded = true;
        onExceed();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    },
    text() {
      return Buffer.concat(chunks, size).toString("utf8");
    },
  };
}

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The child may have exited between the timeout/cancel and this call.
    }
  }
}

/**
 * Runs one owned child process with a bounded output buffer and explicit
 * timeout/cancel distinction. The child is never started through a shell.
 */
export async function runChildProcess(
  request: ChildProcessRequest,
): Promise<ChildProcessResult> {
  if (request.signal?.aborted)
    return {
      pid: null,
      exitCode: null,
      exitSignal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: true,
      outputExceeded: false,
      spawnError: null,
    };

  let child: ChildProcess | null = null;
  let settled = false;
  let exited = false;
  let timedOut = false;
  let cancelled = false;
  let outputExceeded = false;
  let spawnError: string | null = null;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let hardKillTimer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let termination: Promise<void> | null = null;
  let resolveResult: (result: ChildProcessResult) => void = () => undefined;

  const resultPromise = new Promise<ChildProcessResult>((resolve) => {
    resolveResult = resolve;
  });

  const cleanup = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    if (hardKillTimer) {
      clearTimeout(hardKillTimer);
      hardKillTimer = undefined;
    }
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
    request.signal?.removeEventListener("abort", onAbort);
  };

  const finish = async () => {
    if (settled) return;
    settled = true;
    cleanup();
    // A timeout/cancel/output stop must not release the slot before the
    // owned tree has actually been terminated.
    if (termination) {
      try {
        await termination;
      } catch {
        // Termination is best effort; the exit event still carries the result.
      }
    }
    resolveResult({
      pid: child?.pid ?? null,
      exitCode,
      exitSignal,
      stdout: stdout.text(),
      stderr: stderr.text(),
      timedOut,
      cancelled,
      outputExceeded,
      spawnError,
    });
  };

  // The owned child exited; its descendants may still keep the inherited
  // pipe handles open. Prefer the normal close event, but never let an
  // unrelated handle holder delay this run indefinitely.
  const releaseOwnStreams = () => {
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    child?.stdin?.destroy();
  };

  const stop = (reason: "timeout" | "cancel" | "output") => {
    if (settled) return;
    if (reason === "timeout" && timedOut) return;
    if (reason === "cancel" && cancelled) return;
    if (reason === "output" && outputExceeded) return;
    // Timeout and cancellation target a running child. Once it has exited,
    // there is nothing left to abort; only late output can still trip the cap.
    if (exited && reason !== "output") return;
    if (reason === "timeout") timedOut = true;
    else if (reason === "cancel") cancelled = true;
    else outputExceeded = true;
    if (!child?.pid) return;
    if (!termination) termination = killProcessTree(child.pid);
    if (!hardKillTimer)
      hardKillTimer = setTimeout(() => {
        try {
          const pid = child?.pid;
          if (process.platform === "win32") child?.kill("SIGKILL");
          else if (pid) process.kill(-pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }, 5_000);
  };

  function onAbort() {
    stop("cancel");
  }

  const stdout = createCollector(
    request.maxBytesPerStream ?? MAX_OUTPUT_BYTES,
    () => stop("output"),
  );
  const stderr = createCollector(
    request.maxBytesPerStream ?? MAX_OUTPUT_BYTES,
    () => stop("output"),
  );

  try {
    child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error);
    void finish();
    return resultPromise;
  }

  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.once("error", (error) => {
    spawnError = error.message;
    void finish();
  });
  child.once("exit", (code, signal) => {
    if (exited) return;
    exited = true;
    exitCode = code;
    exitSignal = signal;
    // The run is over; a timer firing during drainage must not relabel it.
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    if (settled) return;
    drainTimer = setTimeout(() => {
      drainTimer = undefined;
      if (settled) return;
      releaseOwnStreams();
      void finish();
    }, OUTPUT_DRAIN_MS);
  });
  child.once("close", (code, signal) => {
    exited = true;
    // `close` may be the only exit notification on some error paths.
    if (exitCode === null) exitCode = code;
    if (exitSignal === null) exitSignal = signal;
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
    void finish();
  });
  if (request.onSpawn && child.pid) {
    try {
      request.onSpawn(child.pid);
    } catch (error) {
      spawnError = error instanceof Error ? error.message : String(error);
      void killProcessTree(child.pid);
    }
  }

  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) stop("cancel");
  timeoutTimer = setTimeout(() => stop("timeout"), request.timeoutMs);

  try {
    child.stdin?.on("error", () => {
      // EPIPE means the child exited or closed stdin; the exit code still wins.
    });
    child.stdin?.end(request.stdin ?? "", "utf8");
  } catch {
    // The child may have exited before stdin was written.
  }

  return resultPromise;
}
