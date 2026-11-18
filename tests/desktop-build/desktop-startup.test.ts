import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVICE_STOPPED_MARKUP,
  STARTUP_BUDGET_MS,
  STARTUP_PROBE_TIMEOUT_MS,
  STARTUP_RETRY_MS,
  STARTUP_TIMEOUT_MARKUP,
  exitedResult,
  isHealthyPayload,
  spawnErrorResult,
  startupFailureMarkup,
  startupNavigationDecision,
  waitForStartupHealth,
} from "../../electron/startup-health";

const h = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    windows: [] as any[],
    loadCalls: [] as string[],
    executeCalls: [] as string[],
    exitCalls: [] as number[],
    child: null as any,
    spawnSync: null as any,
    loadURL: null as null | ((url: string) => Promise<void>),
    executeJavaScript: null as null | ((code: string) => Promise<string>),
    dataDir: "",
    on(event: string, listener: Listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    emit(event: string, ...args: any[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
});

vi.mock("electron", () => {
  class BrowserWindow {
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      mainFrame: {},
      executeJavaScript: (code: string) => {
        h.executeCalls.push(code);
        return h.executeJavaScript
          ? h.executeJavaScript(code)
          : Promise.resolve("");
      },
    };
    destroyed = false;
    constructor() {
      h.windows.push(this);
    }
    loadURL(url: string) {
      h.loadCalls.push(url);
      return h.loadURL ? h.loadURL(url) : Promise.resolve();
    }
    show = vi.fn();
    focus = vi.fn();
    isDestroyed() {
      return this.destroyed;
    }
  }
  class Tray {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    on = vi.fn();
  }
  return {
    app: {
      whenReady: async () => {},
      isPackaged: false,
      getPath: () => h.dataDir,
      requestSingleInstanceLock: () => true,
      on: (event: string, listener: (...args: any[]) => void) =>
        h.on(event, listener),
      quit: () => h.emit("before-quit"),
      exit: (code: number) => h.exitCalls.push(code),
    },
    BrowserWindow,
    Tray,
    Menu: { buildFromTemplate: (template: unknown) => template },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    session: { defaultSession: { cookies: { set: async () => {} } } },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    ipcMain: { handle: vi.fn() },
  };
});
vi.mock("node:child_process", () => ({
  spawn: () => h.child,
  spawnSync: (...args: any[]) => h.spawnSync(...args),
}));
vi.mock("node:net", () => ({
  createServer: () => ({
    on: vi.fn(),
    listen: (_port: number, _host: string, callback: () => void) => callback(),
    address: () => ({ port: 3911 }),
    close: (callback: () => void) => callback(),
  }),
}));

function makeChild() {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  return {
    pid: 4321,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stderr: { on: vi.fn() },
    kill: vi.fn(),
    on(event: string, listener: (...args: any[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    emit(event: string, ...args: any[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  h.listeners.clear();
  h.windows.length = 0;
  h.loadCalls.length = 0;
  h.executeCalls.length = 0;
  h.exitCalls.length = 0;
  h.loadURL = null;
  h.executeJavaScript = null;
  h.child = makeChild();
  h.spawnSync = vi.fn(() => ({ status: 0 }));
  h.dataDir = await mkdtemp(join(tmpdir(), "quant-desktop-wiring-"));
  vi.stubEnv("QUANT_DATA_DIR", h.dataDir);
  vi.stubEnv("QUANT_DESKTOP_SMOKE", "");
  vi.stubGlobal("__dirname", process.cwd());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      body: null,
      json: async () => ({ status: "ok", app: "quant-workbench" }),
    })),
  );
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (h.dataDir) await rm(h.dataDir, { recursive: true, force: true });
});

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const healthUrl = "http://127.0.0.1:3911/api/health";
const healthyBody = { status: "ok", app: "quant-workbench" };

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    body: null,
    json: async () => payload,
  } as unknown as Response;
}
function htmlResponse(): Response {
  return {
    ok: true,
    status: 200,
    body: null,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  } as unknown as Response;
}
function failedResponse(cancel = vi.fn(async () => {})): Response {
  return {
    ok: false,
    status: 503,
    body: { cancel },
    json: async () => {
      throw new Error("not read");
    },
  } as unknown as Response;
}
function queueFetch(responses: Array<Response | (() => Promise<Response>)>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const queue = [...responses],
    calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra probe");
    return typeof next === "function" ? next() : next;
  });
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}
function hangingFetch() {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
}

describe("startup health", () => {
  it("is ready only for the service's own JSON identity", async () => {
    const { fetchImpl, calls } = queueFetch([jsonResponse(healthyBody)]);
    await expect(
      waitForStartupHealth({ url: healthUrl, fetchImpl }),
    ).resolves.toEqual({ status: "ready" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(healthUrl);
    expect(calls[0]!.init.redirect).toBe("error");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps retrying after HTML 200, wrong identity, HTTP errors and redirect rejection", async () => {
    const cancel = vi.fn(async () => {});
    const { fetchImpl, calls } = queueFetch([
      htmlResponse(),
      jsonResponse({ status: "ok", app: "another-app" }),
      jsonResponse({ status: "degraded", app: "quant-workbench" }),
      failedResponse(cancel),
      () => Promise.reject(new TypeError("unexpected redirect")),
      jsonResponse(healthyBody),
    ]);
    const pending = waitForStartupHealth({ url: healthUrl, fetchImpl });
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ status: "ready" });
    expect(calls).toHaveLength(6);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an unconsumed body without surfacing its rejection", async () => {
    const cancel = vi.fn(() => Promise.reject(new Error("cancel failed")));
    const { fetchImpl } = queueFetch([
      failedResponse(cancel),
      jsonResponse(healthyBody),
    ]);
    const pending = waitForStartupHealth({ url: healthUrl, fetchImpl });
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ status: "ready" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns exited for a service exit while a probe is in flight", async () => {
    const controller = new AbortController(),
      impl = hangingFetch();
    const pending = waitForStartupHealth({
      url: healthUrl,
      signal: controller.signal,
      fetchImpl: impl as unknown as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(exitedResult(0, null));
    await expect(pending).resolves.toEqual({
      status: "exited",
      code: 0,
      signal: null,
    });
    expect(impl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lands a synchronous spawn error without probing", async () => {
    const controller = new AbortController(),
      error = Object.assign(new Error("spawn EACCES C:\\secret\\node.exe"), {
        code: "EACCES",
      }),
      impl = vi.fn();
    controller.abort(spawnErrorResult(error));
    await expect(
      waitForStartupHealth({
        url: healthUrl,
        signal: controller.signal,
        fetchImpl: impl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ status: "spawn-error", error });
    expect(impl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns cancelled for a quit during a probe", async () => {
    const controller = new AbortController(),
      impl = hangingFetch();
    const pending = waitForStartupHealth({
      url: healthUrl,
      signal: controller.signal,
      fetchImpl: impl as unknown as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort({ status: "cancelled" });
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cuts a slow final probe at the absolute deadline and clears timers", async () => {
    const impl = hangingFetch();
    const pending = waitForStartupHealth({
      url: healthUrl,
      budgetMs: 250,
      probeTimeoutMs: 1000,
      fetchImpl: impl as unknown as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toEqual({ status: "timeout" });
    expect(impl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts each probe after one second and recovers on the next attempt", async () => {
    let attempt = 0;
    const impl = vi.fn((_url: string, init: RequestInit) => {
      attempt += 1;
      if (attempt === 1)
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      return Promise.resolve(jsonResponse(healthyBody));
    });
    const pending = waitForStartupHealth({
      url: healthUrl,
      budgetMs: 5000,
      fetchImpl: impl as unknown as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(impl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ status: "ready" });
    expect(impl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a valid identity that arrives after the total budget", async () => {
    let clock = 0;
    const impl = vi.fn(async () => {
      // A blocked event loop lets the body succeed before the deadline timer
      // runs; the real clock must still reject it.
      clock = 35;
      return jsonResponse(healthyBody);
    });
    await expect(
      waitForStartupHealth({
        url: healthUrl,
        budgetMs: 20,
        now: () => clock,
        fetchImpl: impl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ status: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a valid identity that arrives after the probe deadline and retries", async () => {
    let clock = 0,
      attempts = 0;
    const impl = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        clock = 1001;
        return jsonResponse(healthyBody);
      }
      return jsonResponse(healthyBody);
    });
    const pending = waitForStartupHealth({
      url: healthUrl,
      budgetMs: 5000,
      now: () => clock,
      fetchImpl: impl as unknown as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ status: "ready" });
    expect(attempts).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the documented total, probe and retry budgets", () => {
    expect(STARTUP_BUDGET_MS).toBe(45_000);
    expect(STARTUP_PROBE_TIMEOUT_MS).toBe(1_000);
    expect(STARTUP_RETRY_MS).toBe(100);
  });
});

describe("health payload shape", () => {
  it("accepts only the exact status and app fields", () => {
    expect(isHealthyPayload(healthyBody)).toBe(true);
    for (const payload of [
      null,
      "ok",
      {},
      { status: "ok" },
      { app: "quant-workbench" },
      { status: "OK", app: "quant-workbench" },
      { status: "ok", app: "quant-workbench " },
      [healthyBody],
    ])
      expect(isHealthyPayload(payload)).toBe(false);
  });
});

describe("main-process startup gate", () => {
  it("stays quiet for quit and a destroyed window", () => {
    expect(
      startupNavigationDecision({
        quitting: true,
        windowAlive: true,
        exitCode: null,
        signalCode: null,
      }),
    ).toEqual({ action: "quiet" });
    expect(
      startupNavigationDecision({
        quitting: false,
        windowAlive: false,
        exitCode: null,
        signalCode: null,
      }),
    ).toEqual({ action: "quiet" });
    expect(
      startupNavigationDecision({
        quitting: false,
        windowAlive: true,
        exitCode: null,
        signalCode: null,
        failure: { status: "cancelled" },
      }),
    ).toEqual({ action: "quiet" });
  });

  it("fails navigation for startup causes and exits after ready", () => {
    const spawn = spawnErrorResult(new Error("ENOENT"));
    expect(
      startupNavigationDecision({
        quitting: false,
        windowAlive: true,
        exitCode: null,
        signalCode: null,
        failure: spawn,
      }),
    ).toEqual({ action: "failure", result: spawn });
    expect(
      startupNavigationDecision({
        quitting: false,
        windowAlive: true,
        exitCode: null,
        signalCode: null,
        failure: { status: "timeout" },
      }),
    ).toEqual({ action: "failure", result: { status: "timeout" } });
    expect(
      startupNavigationDecision({
        quitting: false,
        windowAlive: true,
        exitCode: 0,
        signalCode: null,
      }),
    ).toEqual({
      action: "failure",
      result: { status: "exited", code: 0, signal: null },
    });
    expect(
      startupNavigationDecision({
        quitting: false,
        windowAlive: true,
        exitCode: null,
        signalCode: "SIGTERM",
      }),
    ).toEqual({
      action: "failure",
      result: { status: "exited", code: null, signal: "SIGTERM" },
    });
    expect(
      startupNavigationDecision({
        quitting: false,
        windowAlive: true,
        exitCode: null,
        signalCode: null,
        failure: { status: "ready" },
      }),
    ).toEqual({ action: "proceed" });
  });

  it("shows fixed copy that never leaks process errors, paths or tokens", () => {
    expect(startupFailureMarkup({ status: "timeout" })).toBe(
      STARTUP_TIMEOUT_MARKUP,
    );
    const exited = startupFailureMarkup(exitedResult(1, null));
    expect(exited).toBe(SERVICE_STOPPED_MARKUP);
    const spawn = startupFailureMarkup(
      spawnErrorResult(
        new Error("EACCES C:\\Users\\jm\\secret token=abc under D:\\quant"),
      ),
    );
    expect(spawn).toBe(SERVICE_STOPPED_MARKUP);
    for (const markup of [exited, spawn]) {
      expect(markup).not.toContain("EACCES");
      expect(markup).not.toContain("secret");
      expect(markup).not.toContain("token=");
      expect(markup).not.toContain("C:\\");
    }
    expect(startupFailureMarkup({ status: "ready" })).toBeNull();
    expect(startupFailureMarkup({ status: "cancelled" })).toBeNull();
  });
});

describe("mocked Electron startup wiring", () => {
  it("renders the fixed failure page when the child exits while loadURL is pending", async () => {
    let release!: () => void;
    h.loadURL = (url) =>
      url.startsWith("data:")
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            release = resolve;
          });
    await import("../../electron/main");
    await flush();
    expect(h.loadCalls).toEqual(["http://127.0.0.1:3911"]);
    h.child.exitCode = 0;
    h.child.emit("exit", 0, null);
    release();
    await flush();
    expect(h.loadCalls).toHaveLength(2);
    expect(decodeURIComponent(h.loadCalls[1]!)).toContain("本地服务已停止");
    expect(h.exitCalls).toEqual([]);
    expect(h.windows[0]!.show).toHaveBeenCalledTimes(1);
  });

  it("leaves no smoke output when quit interrupts the smoke wait", async () => {
    vi.stubEnv("QUANT_DESKTOP_SMOKE", "1");
    await import("../../electron/main");
    await flush();
    expect(h.loadCalls).toHaveLength(1);
    expect(h.executeCalls).toHaveLength(0);
    h.emit("before-quit");
    expect(h.spawnSync).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/PID", "4321", "/T", "/F"],
      { windowsHide: true, timeout: 10000, stdio: "ignore" },
    );
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    await expect(
      readFile(join(h.dataDir, "smoke.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.exitCalls).toEqual([]);
  });

  it("leaves no smoke output when quit interrupts executeJavaScript", async () => {
    vi.stubEnv("QUANT_DESKTOP_SMOKE", "1");
    let releaseText!: (value: string) => void;
    h.executeJavaScript = () =>
      new Promise<string>((resolve) => {
        releaseText = resolve;
      });
    await import("../../electron/main");
    await flush();
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(h.executeCalls).toHaveLength(1);
    h.emit("before-quit");
    releaseText("今日 今日决策");
    await flush();
    await expect(
      readFile(join(h.dataDir, "smoke.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.exitCalls).toEqual([]);
  });

  it.each([
    { label: "code 0", code: 0, signal: null },
    { label: "signal", code: null, signal: "SIGTERM" as NodeJS.Signals },
  ])(
    "fails the smoke run without writing or taskkill when the service exits during the wait ($label)",
    async ({ code, signal }) => {
      vi.stubEnv("QUANT_DESKTOP_SMOKE", "1");
      await import("../../electron/main");
      await flush();
      h.child.exitCode = code;
      h.child.signalCode = signal;
      h.child.emit("exit", code, signal);
      await vi.advanceTimersByTimeAsync(3000);
      await flush();
      await expect(
        readFile(join(h.dataDir, "smoke.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(h.exitCalls).toEqual([1]);
      expect(h.spawnSync).not.toHaveBeenCalled();
    },
  );
});
