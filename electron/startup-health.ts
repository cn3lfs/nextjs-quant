/**
 * Startup health gate for the bundled local service.
 *
 * The desktop shell may only navigate once this process answers with its own
 * identity. Liveness is judged against one monotonic absolute deadline, so a
 * retry or a blocked event loop can never extend startup beyond the budget.
 * Every probe and backoff timer is cleared on success, failure and
 * cancellation.
 */

export const STARTUP_BUDGET_MS = 45_000;
export const STARTUP_PROBE_TIMEOUT_MS = 1_000;
export const STARTUP_RETRY_MS = 100;

export type StartupHealthResult =
  | { status: "ready" }
  | { status: "timeout" }
  | { status: "exited"; code: number | null; signal: NodeJS.Signals | null }
  | { status: "spawn-error"; error: unknown }
  | { status: "cancelled" };

export interface StartupHealthOptions {
  url: string;
  /** Aborted by the shell with a result reason when the service exits or quits. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  budgetMs?: number;
  probeTimeoutMs?: number;
  retryDelayMs?: number;
  /** Monotonic clock; tests inject it to simulate a blocked event loop. */
  now?: () => number;
}

export function exitedResult(
  code: number | null,
  signal: NodeJS.Signals | null,
): StartupHealthResult {
  return { status: "exited", code, signal };
}

export function spawnErrorResult(error: unknown): StartupHealthResult {
  return { status: "spawn-error", error };
}

export function isHealthyPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const value = payload as { status?: unknown; app?: unknown };
  return value.status === "ok" && value.app === "quant-workbench";
}

function abortResult(reason: unknown): StartupHealthResult {
  if (typeof reason === "object" && reason !== null) {
    const value = reason as {
      status?: unknown;
      code?: unknown;
      signal?: unknown;
    };
    if (value.status === "exited")
      return exitedResult(
        typeof value.code === "number" || value.code === null
          ? (value.code as number | null)
          : null,
        typeof value.signal === "string" || value.signal === null
          ? (value.signal as NodeJS.Signals | null)
          : null,
      );
    if (value.status === "spawn-error")
      return spawnErrorResult((reason as { error?: unknown }).error);
  }
  return { status: "cancelled" };
}

function discard(response: Response): void {
  // Only non-consuming paths reach here. JSON bodies stay owned by fetch.
  try {
    void response.body?.cancel().catch(() => {});
  } catch {}
}

export function waitForStartupHealth(
  options: StartupHealthOptions,
): Promise<StartupHealthResult> {
  const {
    url,
    signal,
    fetchImpl = fetch,
    budgetMs = STARTUP_BUDGET_MS,
    probeTimeoutMs = STARTUP_PROBE_TIMEOUT_MS,
    retryDelayMs = STARTUP_RETRY_MS,
    now = () => performance.now(),
  } = options;

  return new Promise((resolve) => {
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let probeController: AbortController | undefined;
    let wakeRetry: (() => void) | undefined;
    const deadlineAt = now() + budgetMs;

    const onAbort = () => finish(abortResult(signal?.reason));

    function clearProbeTimer(): void {
      if (probeTimer !== undefined) clearTimeout(probeTimer);
      probeTimer = undefined;
    }

    function cleanup(): void {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      clearProbeTimer();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      deadlineTimer = retryTimer = undefined;
      probeController?.abort();
      probeController = undefined;
      signal?.removeEventListener("abort", onAbort);
      const wake = wakeRetry;
      wakeRetry = undefined;
      wake?.();
    }

    function finish(result: StartupHealthResult): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    if (signal?.aborted) {
      finish(abortResult(signal.reason));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    deadlineTimer = setTimeout(() => {
      deadlineTimer = undefined;
      finish({ status: "timeout" });
    }, budgetMs);
    void run();

    async function run(): Promise<void> {
      while (!settled) {
        const startedAt = now();
        if (startedAt >= deadlineAt) {
          finish({ status: "timeout" });
          return;
        }
        const probe = new AbortController();
        probeController = probe;
        const probeDeadlineAt = startedAt + probeTimeoutMs;
        probeTimer = setTimeout(
          () => {
            probeTimer = undefined;
            probe.abort();
          },
          Math.max(0, Math.min(probeTimeoutMs, deadlineAt - startedAt)),
        );
        const probeSignal = signal
          ? AbortSignal.any([signal, probe.signal])
          : probe.signal;
        try {
          const response = await fetchImpl(url, {
            redirect: "error",
            signal: probeSignal,
          });
          if (settled) {
            discard(response);
            return;
          }
          if (!response.ok) discard(response);
          else {
            const payload: unknown = await response
              .json()
              .catch(() => undefined);
            if (settled) return;
            if (now() >= deadlineAt) {
              finish({ status: "timeout" });
              return;
            }
            // A blocked event loop can deliver a valid body after this probe
            // or the whole budget expired; it is not evidence of readiness.
            if (!probe.signal.aborted && now() < probeDeadlineAt) {
              if (isHealthyPayload(payload)) {
                finish({ status: "ready" });
                return;
              }
            }
          }
        } catch {
          // Redirects, refused connections, timeouts and malformed bodies all
          // remain recoverable until the absolute deadline.
        } finally {
          clearProbeTimer();
        }
        if (settled) return;
        const remaining = deadlineAt - now();
        if (remaining <= 0) {
          finish({ status: "timeout" });
          return;
        }
        await new Promise<void>((wake) => {
          wakeRetry = wake;
          retryTimer = setTimeout(
            () => {
              retryTimer = undefined;
              wakeRetry = undefined;
              wake();
            },
            Math.min(retryDelayMs, remaining),
          );
        });
      }
    }
  });
}

export interface StartupGateState {
  quitting: boolean;
  windowAlive: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  failure?: StartupHealthResult | null;
}

export type StartupNavigationDecision =
  | { action: "proceed" }
  | { action: "quiet" }
  | { action: "failure"; result: StartupHealthResult };

/** Re-checked immediately before navigation and after loadURL settles. */
export function startupNavigationDecision(
  state: StartupGateState,
): StartupNavigationDecision {
  if (state.quitting || !state.windowAlive) return { action: "quiet" };
  if (state.failure?.status === "cancelled") return { action: "quiet" };
  if (state.failure && state.failure.status !== "ready")
    return { action: "failure", result: state.failure };
  if (state.exitCode !== null || state.signalCode !== null)
    return {
      action: "failure",
      result: exitedResult(state.exitCode, state.signalCode),
    };
  return { action: "proceed" };
}

export const STARTUP_TIMEOUT_MARKUP =
  "<h2>启动超时</h2><p>本地服务未能启动，请查看用户目录 server.log。</p>";
export const SERVICE_STOPPED_MARKUP =
  "<h2>本地服务已停止</h2><p>请退出应用后重新启动。日志位于应用用户目录。</p>";

/** Fixed copy only: never include process errors, paths or credentials. */
export function startupFailureMarkup(
  result: StartupHealthResult,
): string | null {
  if (result.status === "timeout") return STARTUP_TIMEOUT_MARKUP;
  if (result.status === "exited" || result.status === "spawn-error")
    return SERVICE_STOPPED_MARKUP;
  return null;
}
