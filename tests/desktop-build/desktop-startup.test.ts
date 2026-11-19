import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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
import { desktopStartupLine } from "../../electron/startup-log";

const h = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    ipc: new Map<string, Listener>(),
    workspaceCloseToTray: false,
    windows: [] as any[],
    loadCalls: [] as string[],
    executeCalls: [] as string[],
    exitCalls: [] as number[],
    child: null as any,
    spawnSync: null as any,
    spawnCalls: [] as any[][],
    trayMenus: [] as any[],
    openPathCalls: [] as string[],
    messageBoxCalls: [] as any[][],
    openPathImpl: null as null | ((path: string) => Promise<string>),
    messageBoxImpl: null as null | ((...args: any[]) => Promise<any>),
    loadURL: null as null | ((url: string) => Promise<void>),
    executeJavaScript: null as null | ((code: string) => Promise<string>),
    cookiesSet: null as null | (() => Promise<void>),
    spawnImpl: null as null | ((...args: any[]) => any),
    dataDir: "",
    on(event: string, listener: Listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    emit(event: string, ...args: any[]) {
      if (event === "before-quit" && !args.length)
        args.push({ preventDefault: vi.fn() });
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
});

vi.mock("electron", async () => {
  const { EventEmitter: WindowEvents } = await import("node:events");
  class BrowserWindow extends WindowEvents {
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      mainFrame: { url: "", origin: "" },
      executeJavaScript: (code: string) => {
        h.executeCalls.push(code);
        return h.executeJavaScript
          ? h.executeJavaScript(code)
          : Promise.resolve("");
      },
    };
    destroyed = false;
    constructor() {
      super();
      h.windows.push(this);
    }
    loadURL(url: string) {
      this.webContents.mainFrame = { url, origin: new URL(url).origin };
      h.loadCalls.push(url);
      return h.loadURL ? h.loadURL(url) : Promise.resolve();
    }
    hide = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    isDestroyed() {
      return this.destroyed;
    }
  }
  class Tray {
    setToolTip = vi.fn();
    setContextMenu = (menu: unknown) => {
      h.trayMenus.push(menu);
    };
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
    session: {
      defaultSession: {
        cookies: {
          set: () => (h.cookiesSet ? h.cookiesSet() : Promise.resolve()),
        },
      },
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: (...args: any[]) => {
        h.messageBoxCalls.push(args);
        return h.messageBoxImpl
          ? h.messageBoxImpl(...args)
          : Promise.resolve({ response: 0 });
      },
    },
    shell: {
      openPath: (path: string) => {
        h.openPathCalls.push(path);
        return h.openPathImpl ? h.openPathImpl(path) : Promise.resolve("");
      },
    },
    ipcMain: {
      handle: (name: string, listener: (...args: any[]) => void) =>
        h.ipc.set(name, listener),
    },
  };
});
// Vitest injects __dirname as a module-wrapper parameter, so stubGlobal cannot
// change it. Pinning this one call gives main the same isolated service root
// it would derive from __dirname = join(h.dataDir, "desktop").
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    join: (...parts: string[]) =>
      parts.length === 4 &&
      parts[1] === ".." &&
      parts[2] === ".next" &&
      parts[3] === "standalone"
        ? actual.join(h.dataDir, "desktop", "..", ".next", "standalone")
        : actual.join(...parts),
  };
});
vi.mock("node:child_process", () => ({
  spawn: (...args: any[]) => {
    h.spawnCalls.push(args);
    return h.spawnImpl ? h.spawnImpl(...args) : h.child;
  },
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
  const stderrListeners: Array<(chunk: unknown) => void> = [];
  return Object.assign(new EventEmitter(), {
    pid: 4321,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stderr: {
      on: (_event: string, listener: (chunk: unknown) => void) => {
        stderrListeners.push(listener);
      },
    },
    emitStderr(chunk: unknown) {
      for (const listener of stderrListeners) listener(chunk);
    },
    kill: vi.fn(),
  });
}

beforeEach(async () => {
  vi.resetModules();
  h.listeners.clear();
  h.ipc.clear();
  h.workspaceCloseToTray = false;
  h.windows.length = 0;
  h.loadCalls.length = 0;
  h.executeCalls.length = 0;
  h.exitCalls.length = 0;
  h.spawnCalls.length = 0;
  h.trayMenus.length = 0;
  h.openPathCalls.length = 0;
  h.messageBoxCalls.length = 0;
  h.openPathImpl = null;
  h.messageBoxImpl = null;
  h.loadURL = null;
  h.executeJavaScript = null;
  h.cookiesSet = null;
  h.spawnImpl = null;
  h.child = makeChild();
  h.spawnSync = vi.fn(() => ({ status: 0 }));
  h.dataDir = await mkdtemp(join(tmpdir(), "quant-desktop-wiring-"));
  vi.stubEnv("QUANT_DATA_DIR", h.dataDir);
  vi.stubEnv("QUANT_DESKTOP_SMOKE", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (String(url).includes("/api/trpc/")) {
        if (String(url).includes("/saveWorkspacePreferences"))
          h.workspaceCloseToTray = JSON.parse(
            String(options?.body),
          ).json.closeToTray;
        return Response.json({
          result: { data: { json: { closeToTray: h.workspaceCloseToTray } } },
        });
      }
      return Response.json({ status: "ok", app: "quant-workbench" });
    }),
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

// Menu handlers return their action's promise (Electron ignores it), so tests
// await the real fs work instead of polling with timers.
function trayClick(label: string): Promise<void> {
  const template = h.trayMenus.at(-1) as
    Array<{ label?: string; click?: () => unknown }> | undefined;
  const item = template?.find((entry) => entry.label === label);
  if (!item?.click) throw new Error("tray item missing: " + label);
  return Promise.resolve(item.click()).then(() => {});
}

// The bundled server root the child runs in; a relative QUANT_DATA_DIR must
// resolve here, not against the caller's process.cwd().
const serviceRoot = (dataDir: string) =>
  resolve(dataDir, ".next", "standalone");

function spawnedEnv(): NodeJS.ProcessEnv {
  return h.spawnCalls[0]![2].env as NodeJS.ProcessEnv;
}

const STARTUP_LINE =
  /^\[desktop-startup\] (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (ready|timeout|exited|spawn-error|cancelled|host-error)(?: (.*))?$/;

async function startupLines(): Promise<string[]> {
  const text = await readFile(join(h.dataDir, "server.log"), "utf8").catch(
    () => "",
  );
  return text
    .split("\n")
    .filter((line) => line.startsWith("[desktop-startup]"));
}

function parseStartupLine(line: string) {
  const match = STARTUP_LINE.exec(line);
  if (!match) throw new Error("unexpected startup line " + line);
  return {
    at: Date.parse(match[1]!),
    status: match[2]!,
    detail: match[3] ?? "",
  };
}

async function expectSingleStartup(status: string) {
  const lines = await startupLines();
  expect(lines).toHaveLength(1);
  const record = parseStartupLine(lines[0]!);
  expect(record.status).toBe(status);
  expect(Number.isFinite(record.at)).toBe(true);
  expect(Math.abs(record.at - Date.now())).toBeLessThan(10_000);
  return record;
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

describe("desktop startup record", () => {
  const at = new Date("2026-11-19T01:02:03.456Z");

  it("writes only a bounded integer exit code or a known signal", () => {
    expect(desktopStartupLine(exitedResult(0, null), at)).toBe(
      "[desktop-startup] 2026-11-19T01:02:03.456Z exited code=0",
    );
    expect(desktopStartupLine(exitedResult(7, null), at)).toBe(
      "[desktop-startup] 2026-11-19T01:02:03.456Z exited code=7",
    );
    expect(desktopStartupLine(exitedResult(0xc0000005, null), at)).toBe(
      "[desktop-startup] 2026-11-19T01:02:03.456Z exited code=3221225477",
    );
    for (const code of [
      -1,
      1.5,
      0x1_0000_0000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])
      expect(desktopStartupLine(exitedResult(code, null), at)).toBe(
        "[desktop-startup] 2026-11-19T01:02:03.456Z exited",
      );
    expect(desktopStartupLine(exitedResult(null, "SIGTERM"), at)).toBe(
      "[desktop-startup] 2026-11-19T01:02:03.456Z exited signal=SIGTERM",
    );
    expect(
      desktopStartupLine(exitedResult(null, "SIGBOGUS" as NodeJS.Signals), at),
    ).toBe("[desktop-startup] 2026-11-19T01:02:03.456Z exited");
  });

  it("never carries process errors, paths, tokens or environment values", () => {
    const error = new Error("EACCES token=abc at C:\\secret\\node.exe");
    expect(desktopStartupLine(spawnErrorResult(error), at)).toBe(
      "[desktop-startup] 2026-11-19T01:02:03.456Z spawn-error",
    );
    expect(desktopStartupLine({ status: "host-error" }, at)).toBe(
      "[desktop-startup] 2026-11-19T01:02:03.456Z host-error",
    );
    for (const status of ["ready", "timeout", "cancelled"] as const)
      expect(desktopStartupLine({ status }, at)).toBe(
        `[desktop-startup] 2026-11-19T01:02:03.456Z ${status}`,
      );
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
        : new Promise<void>((_resolve, reject) => {
            // The confirmed exit must win over this navigation rejection.
            release = () =>
              reject(new Error("net::ERR_CONNECTION_REFUSED C:\\secret"));
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
    const record = await expectSingleStartup("exited");
    expect(record.detail).toBe("code=0");
    // A quit that follows the confirmed exit must not rewrite the first cause.
    h.emit("before-quit");
    await flush();
    const lines = await startupLines();
    expect(lines).toHaveLength(1);
    expect(parseStartupLine(lines[0]!).status).toBe("exited");
  });

  it("records a reported signal the gate sees after navigation", async () => {
    let release!: () => void;
    h.loadURL = (url) =>
      url.startsWith("data:")
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            release = resolve;
          });
    await import("../../electron/main");
    await flush();
    // No exit event: only the reported signal is visible to the gate.
    h.child.signalCode = "SIGTERM";
    release();
    await flush();
    const record = await expectSingleStartup("exited");
    expect(record.detail).toBe("signal=SIGTERM");
    expect(decodeURIComponent(h.loadCalls.at(-1)!)).toContain("本地服务已停止");
  });

  it("records one ready outcome with a UTC timestamp before smoke", async () => {
    await import("../../electron/main");
    await flush();
    expect(h.loadCalls).toEqual(["http://127.0.0.1:3911"]);
    const record = await expectSingleStartup("ready");
    expect(record.detail).toBe("");
    const text = await readFile(join(h.dataDir, "server.log"), "utf8");
    expect(text.startsWith("\n[desktop-startup] ")).toBe(true);
    // Quitting after ready appends nothing.
    h.emit("before-quit");
    await flush();
    expect(await startupLines()).toHaveLength(1);
  });

  it("records only cancelled when quit lands before the first page load", async () => {
    vi.stubEnv("QUANT_DESKTOP_SMOKE", "1");
    let release!: () => void;
    h.loadURL = (url) =>
      url.startsWith("data:")
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            release = resolve;
          });
    await import("../../electron/main");
    await flush();
    h.emit("before-quit");
    // Late error and exit must not append after the quit won.
    h.child.emit("error", new Error("late spawn error"));
    h.child.exitCode = 0;
    h.child.emit("exit", 0, null);
    release();
    await flush();
    const record = await expectSingleStartup("cancelled");
    expect(record.detail).toBe("");
    await expect(
      readFile(join(h.dataDir, "smoke.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.executeCalls).toHaveLength(0);
    expect(h.spawnSync).not.toHaveBeenCalled();
    expect(h.exitCalls).toEqual([]);
  });

  it("separates the exit record from stderr without a trailing newline", async () => {
    let release!: () => void;
    h.loadURL = (url) =>
      url.startsWith("data:")
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            release = resolve;
          });
    await import("../../electron/main");
    await flush();
    h.child.emitStderr("partial stderr");
    h.child.exitCode = 0;
    h.child.emit("exit", 0, null);
    release();
    await flush();
    const text = await readFile(join(h.dataDir, "server.log"), "utf8");
    expect(text.startsWith("partial stderr\n[desktop-startup] ")).toBe(true);
    const record = await expectSingleStartup("exited");
    expect(record.detail).toBe("code=0");
  });

  it("records one timeout and keeps it when the child exits later", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    await import("../../electron/main");
    await flush();
    await vi.advanceTimersByTimeAsync(STARTUP_BUDGET_MS);
    await flush();
    await expectSingleStartup("timeout");
    expect(decodeURIComponent(h.loadCalls.at(-1)!)).toContain("启动超时");
    h.child.exitCode = 1;
    h.child.emit("exit", 1, null);
    await flush();
    const lines = await startupLines();
    expect(lines).toHaveLength(1);
    expect(parseStartupLine(lines[0]!).status).toBe("timeout");
  });

  it("records host-error without copying the thrown text", async () => {
    h.cookiesSet = async () => {
      throw new Error("EACCES token=abc at C:\\secret\\node.exe " + h.dataDir);
    };
    await import("../../electron/main");
    await flush();
    await expectSingleStartup("host-error");
    const text = await readFile(join(h.dataDir, "server.log"), "utf8");
    expect(text).not.toContain("EACCES");
    expect(text).not.toContain("token=");
    expect(text).not.toContain("C:\\");
    expect(text).not.toContain(h.dataDir);
    await vi.advanceTimersByTimeAsync(3500);
    expect(h.exitCalls).toEqual([1]);
    expect(h.spawnSync).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/PID", "4321", "/T", "/F"],
      { windowsHide: true, timeout: 10000, stdio: "ignore" },
    );
  });

  it("records a synchronous spawn error without its message", async () => {
    h.spawnImpl = () => {
      throw new Error("spawn EACCES token=abc at C:\\secret\\node.exe");
    };
    await import("../../electron/main");
    await flush();
    const record = await expectSingleStartup("spawn-error");
    expect(record.detail).toBe("");
    const text = await readFile(join(h.dataDir, "server.log"), "utf8");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("token=");
    expect(text).not.toContain("C:\\");
    expect(decodeURIComponent(h.loadCalls.at(-1)!)).toContain("本地服务已停止");
  });

  it("keeps starting and closing when server.log cannot be written", async () => {
    await mkdir(join(h.dataDir, "server.log"));
    vi.stubGlobal("fetch", hangingFetch());
    await import("../../electron/main");
    await flush();
    h.child.emit("error", new Error("spawn EACCES C:\\secret"));
    await flush();
    expect(h.loadCalls).toHaveLength(1);
    expect(decodeURIComponent(h.loadCalls[0]!)).toContain("本地服务已停止");
    expect(h.exitCalls).toEqual([]);
    h.emit("before-quit");
    await vi.advanceTimersByTimeAsync(3500);
    expect(h.spawnSync).toHaveBeenCalledTimes(1);
  });

  it("leaves no smoke output when quit interrupts the smoke wait", async () => {
    vi.stubEnv("QUANT_DESKTOP_SMOKE", "1");
    await import("../../electron/main");
    await flush();
    expect(h.loadCalls).toHaveLength(1);
    expect(h.executeCalls).toHaveLength(0);
    h.emit("before-quit");
    await vi.advanceTimersByTimeAsync(3500);
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
      // Ready already owned the record: a later exit appends nothing.
      const lines = await startupLines();
      expect(lines).toHaveLength(1);
      expect(parseStartupLine(lines[0]!).status).toBe("ready");
    },
  );
});

describe("tray data directory action", () => {
  it("opens the resolved absolute data root only after the tray click", async () => {
    await import("../../electron/main");
    await flush();
    const data = spawnedEnv().QUANT_DATA_DIR;
    expect(typeof data).toBe("string");
    expect(isAbsolute(data!)).toBe(true);
    expect(h.openPathCalls).toHaveLength(0);
    await trayClick("打开数据与日志目录");
    expect(h.openPathCalls).toEqual([data]);
    expect(h.messageBoxCalls).toHaveLength(0);
  });

  it("resolves a relative QUANT_DATA_DIR against the backend service root", async () => {
    const root = serviceRoot(h.dataDir);
    const expected = join(h.dataDir, "relative-data");
    const relativeRoot = relative(root, expected);
    expect(isAbsolute(relativeRoot)).toBe(false);
    // The old backend saw this value relative to its spawn cwd (the service
    // root), never relative to the caller that launched the desktop app.
    expect(resolve(process.cwd(), relativeRoot)).not.toBe(expected);
    vi.stubEnv("QUANT_DATA_DIR", relativeRoot);
    await import("../../electron/main");
    await flush();
    const env = spawnedEnv();
    expect(env.QUANT_DATA_DIR).toBe(expected);
    expect(resolve(String(h.spawnCalls[0]![2].cwd), relativeRoot)).toBe(
      expected,
    );
    await trayClick("打开数据与日志目录");
    expect(h.openPathCalls).toEqual([expected]);
  });

  it("keeps an explicit empty QUANT_DATA_DIR invalid instead of using the cwd", async () => {
    vi.stubEnv("QUANT_DATA_DIR", "");
    await import("../../electron/main");
    await flush();
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.exitCalls).toEqual([1]);
    expect(h.openPathCalls).toHaveLength(0);
  });

  it("does not call the shell when the data root is no longer a directory", async () => {
    await import("../../electron/main");
    await flush();
    expect(spawnedEnv().QUANT_DATA_DIR).toBe(h.dataDir);
    await unlink(join(h.dataDir, "desktop-prefs.json"));
    await unlink(join(h.dataDir, "server.log"));
    await rmdir(h.dataDir);
    await writeFile(h.dataDir, "not a directory");
    await trayClick("打开数据与日志目录");
    expect(h.openPathCalls).toHaveLength(0);
  });

  it("reports fixed copy for a non-empty result and a rejection", async () => {
    await import("../../electron/main");
    await flush();
    h.openPathImpl = async () => "Access is denied.";
    await trayClick("打开数据与日志目录");
    expect(h.messageBoxCalls).toHaveLength(1);
    h.openPathImpl = async () => {
      throw new Error(`openPath failed at ${h.dataDir}`);
    };
    await trayClick("打开数据与日志目录");
    expect(h.messageBoxCalls).toHaveLength(2);
    for (const call of h.messageBoxCalls) {
      const options = call[1] as { message: string; detail: string };
      expect(options.message).toBe("无法打开数据与日志目录");
      expect(options.detail).toBe("请稍后从托盘菜单重试。");
      expect(options.message).not.toContain("Access");
      expect(options.detail).not.toContain(h.dataDir);
    }
    // A rejected dialog message must also stay handled.
    h.messageBoxImpl = async () => {
      throw new Error("dialog owner is gone");
    };
    await trayClick("打开数据与日志目录");
    expect(h.messageBoxCalls).toHaveLength(3);
  });

  it("does not open or prompt when quit happens before stat settles", async () => {
    await import("../../electron/main");
    await flush();
    const click = trayClick("打开数据与日志目录");
    h.emit("before-quit");
    await click;
    expect(h.openPathCalls).toHaveLength(0);
    expect(h.messageBoxCalls).toHaveLength(0);
  });

  it("stays silent when the app quits while opening is pending", async () => {
    await import("../../electron/main");
    await flush();
    let started!: () => void;
    const openStarted = new Promise<void>((done) => {
      started = done;
    });
    let release!: (value: string) => void;
    h.openPathImpl = () => {
      started();
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    const click = trayClick("打开数据与日志目录");
    await openStarted;
    expect(h.openPathCalls).toHaveLength(1);
    h.emit("before-quit");
    release("failed");
    await click;
    expect(h.messageBoxCalls).toHaveLength(0);
  });

  it("keeps the same tray action available after the failure page is shown", async () => {
    let release!: () => void;
    h.loadURL = (url) =>
      url.startsWith("data:")
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            release = resolve;
          });
    await import("../../electron/main");
    await flush();
    h.child.exitCode = 0;
    h.child.emit("exit", 0, null);
    release();
    await flush();
    expect(h.loadCalls).toHaveLength(2);
    const markup = decodeURIComponent(h.loadCalls[1]!);
    expect(markup).toContain("本地服务已停止");
    expect(markup).toContain("托盘菜单");
    const data = spawnedEnv().QUANT_DATA_DIR;
    expect(h.openPathCalls).toHaveLength(0);
    await trayClick("打开数据与日志目录");
    expect(h.openPathCalls).toEqual([data]);
  });
});

describe("desktop background monitoring", () => {
  function invoke(channel: string, value?: unknown) {
    const sender = h.windows[0].webContents;
    return h.ipc.get(channel)!(
      { sender, senderFrame: sender.mainFrame },
      value,
    );
  }
  it("keeps smoke auto-exit and the ready record even with a saved tray preference", async () => {
    vi.stubEnv("QUANT_DESKTOP_SMOKE", "1");
    await writeFile(
      join(h.dataDir, "desktop-prefs.json"),
      '{"closeToTray":true}',
    );
    h.executeJavaScript = async () => "今日决策";
    await import("../../electron/main");
    await flush();
    const event = { preventDefault: vi.fn() };
    h.windows[0].emit("close", event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(h.windows[0].hide).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await readFile(join(h.dataDir, "smoke.txt"), "utf8")).toBe(
      "今日决策",
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/shutdown"),
      expect.anything(),
    );
    h.child.exitCode = 0;
    h.child.emit("exit", 0, null);
    await flush();
    await expectSingleStartup("ready");
    expect(h.spawnSync).not.toHaveBeenCalled();
  });

  it("uses the workspace preference on launch and hides a closed window without stopping the service", async () => {
    h.workspaceCloseToTray = true;
    await import("../../electron/main");
    await flush();
    const win = h.windows[0];
    const event = { preventDefault: vi.fn() };
    win.emit("close", event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(win.hide).toHaveBeenCalledOnce();
    expect(h.child.kill).not.toHaveBeenCalled();
    expect(h.spawnSync).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/shutdown"),
      expect.anything(),
    );
    expect(
      JSON.parse(await readFile(join(h.dataDir, "desktop-prefs.json"), "utf8")),
    ).toEqual({ closeToTray: true });
    await trayClick("打开行情看盘");
    expect(h.loadCalls.at(-1)).toBe("http://127.0.0.1:3911/scan");
    await invoke("quant:set-close-to-tray", false);
    expect(invoke("quant:get-desktop-prefs")).toEqual({ closeToTray: false });
    expect(h.workspaceCloseToTray).toBe(false);
    event.preventDefault.mockClear();
    win.emit("close", event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    await h.trayMenus
      .at(-1)
      .find((entry: { type?: string }) => entry.type === "checkbox")
      .click({ checked: true });
    expect(h.workspaceCloseToTray).toBe(true);
    expect(invoke("quant:get-desktop-prefs")).toEqual({ closeToTray: true });
  });

  it("posts one authenticated shutdown and force-stops only the surviving child after the deadline", async () => {
    await import("../../electron/main");
    await flush();
    await trayClick("彻底退出并停止监控");
    h.emit("before-quit");
    const shutdown = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith("/api/shutdown"));
    expect(shutdown).toHaveLength(1);
    expect(shutdown[0]).toEqual([
      "http://127.0.0.1:3911/api/shutdown",
      expect.objectContaining({
        method: "POST",
        headers: { "x-quant-session": spawnedEnv().QUANT_SESSION_TOKEN },
        redirect: "error",
      }),
    ]);
    await vi.advanceTimersByTimeAsync(3499);
    expect(h.spawnSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.spawnSync).toHaveBeenCalledExactlyOnceWith(
      "taskkill.exe",
      ["/PID", "4321", "/T", "/F"],
      expect.anything(),
    );
  });

  it("lets the service exit gracefully and cancels a racing tray restart on quit", async () => {
    await import("../../electron/main");
    await flush();
    const restarting = trayClick("重启后台服务");
    await flush();
    await trayClick("彻底退出并停止监控");
    h.child.exitCode = 0;
    h.child.emit("exit", 0, null);
    await restarting;
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.spawnSync).not.toHaveBeenCalled();
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.loadCalls).toHaveLength(1);
  });

  it("recovers from a runtime crash only through the trusted failure frame and probes the replacement service", async () => {
    await import("../../electron/main");
    await flush();
    const child = h.child;
    child.exitCode = 7;
    child.emit("exit", 7, null);
    await flush();
    const win = h.windows[0],
      frame = win.webContents.mainFrame;
    expect(decodeURIComponent(frame.url)).toContain(
      "window.quantDesktop.restartService()",
    );
    expect(decodeURIComponent(frame.url)).toContain("打开数据与日志目录");
    expect(() => invoke("quant:get-desktop-prefs")).toThrow();
    expect(() =>
      h.ipc.get("quant:restart-service")!({ sender: {}, senderFrame: frame }),
    ).toThrow();
    expect(() =>
      h.ipc.get("quant:restart-service")!({
        sender: win.webContents,
        senderFrame: { ...frame },
      }),
    ).toThrow();
    win.webContents.mainFrame = { url: "data:text/html,other", origin: "null" };
    expect(() => invoke("quant:restart-service")).toThrow();
    win.webContents.mainFrame = frame;
    h.child = makeChild();
    await invoke("quant:restart-service");
    expect(h.spawnCalls).toHaveLength(2);
    expect(h.windows).toHaveLength(1);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).endsWith("/api/health")),
    ).toHaveLength(2);
    expect(h.loadCalls.at(-1)).toBe("http://127.0.0.1:3911");
    expect(
      (await startupLines()).map((line) => parseStartupLine(line).status),
    ).toEqual(["ready", "ready"]);
    child.emit("exit", 7, null);
    expect(h.loadCalls).toHaveLength(3);
    expect(() => invoke("quant:set-close-to-tray", "true")).toThrow();
    win.webContents.mainFrame = {
      url: "http://127.0.0.1:3912/",
      origin: "http://127.0.0.1:3912",
    };
    expect(() => invoke("quant:set-close-to-tray", true)).toThrow();
  });
});
