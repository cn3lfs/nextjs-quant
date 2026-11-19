import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  session,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import {
  SERVICE_STOPPED_MARKUP,
  exitedResult,
  spawnErrorResult,
  startupFailureMarkup,
  startupNavigationDecision,
  waitForStartupHealth,
  type StartupHealthResult,
} from "./startup-health";
import {
  createDesktopStartupRecorder,
  safeAppend,
  type DesktopStartupRecorder,
} from "./startup-log";

import { desktopPreferences } from "./desktop-prefs";
import { stopDesktopService } from "./stop-service";

let window: BrowserWindow | undefined,
  tray: Tray | undefined,
  service: ChildProcess | undefined,
  quitting = false,
  phase: "starting" | "running" | "failed" | "restarting" = "starting",
  startup: AbortController | undefined,
  startupFailure: StartupHealthResult | undefined,
  failurePage: string | undefined,
  serviceOrigin = "",
  stopping: Promise<void> | undefined,
  startupLog: DesktopStartupRecorder | undefined;
const token = randomBytes(32).toString("hex");
function page(markup: string) {
  return "data:text/html;charset=utf-8," + encodeURIComponent(markup);
}
function stopService() {
  const child = service;
  if (!child) return Promise.resolve();
  stopping ??= stopDesktopService(child, serviceOrigin, token)
    .then(() => {
      if (service === child) service = undefined;
    })
    .finally(() => {
      stopping = undefined;
    });
  return stopping;
}
function serviceStopped() {
  return (
    !!service && (service.exitCode !== null || service.signalCode !== null)
  );
}
function failStartup() {
  // A normal quit that starts first always wins over the failure exit code.
  if (quitting) return;
  quitting = true;
  void stopService().then(() => app.exit(1), reportStopFailure);
}
// Startup keeps only the first cause and never renders from an event handler;
// the navigation path below owns the single failure page.
function abortStartup(result: StartupHealthResult) {
  if (phase !== "starting" || startupFailure) return;
  startupFailure = result;
  startupLog?.record(result);
  startup?.abort(result);
}
async function showFailure(win: BrowserWindow, markup: string) {
  if (quitting || failurePage || win.isDestroyed()) return;
  failurePage = page(markup);
  try {
    await win.loadURL(failurePage);
  } catch {}
}
function showWindow(win: BrowserWindow) {
  if (!win.isDestroyed()) win.show();
}
// Fixed copy only: the original error and the data path must not leak here.
async function showOpenDataFailure(win: BrowserWindow) {
  // A quit or teardown that started while opening was pending wins silently.
  if (quitting || win.isDestroyed()) return;
  try {
    await dialog.showMessageBox(win, {
      type: "warning",
      message: "无法打开数据与日志目录",
      detail: "请稍后从托盘菜单重试。",
      buttons: ["确定"],
    });
  } catch {}
}
// The tray action is the only caller: it opens the exact absolute data root
// already used for mkdir, server.log and the child environment. No IPC and no
// path is ever handed to the renderer.
async function openDataDirectory(target: string, win: BrowserWindow) {
  // A quit that started before or during the stat must never reach the shell.
  if (quitting || win.isDestroyed()) return;
  let isDirectory = false;
  try {
    isDirectory = (await stat(target)).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (quitting || win.isDestroyed()) return;
  if (!isDirectory) {
    await showOpenDataFailure(win);
    return;
  }
  let failed = false;
  try {
    failed = (await shell.openPath(target)) !== "";
  } catch {
    failed = true;
  }
  // Re-check after every await: a quit during the call must stay silent.
  if (failed) await showOpenDataFailure(win);
}
async function finishStartupFailure(
  win: BrowserWindow,
  result: StartupHealthResult,
) {
  if (quitting || win.isDestroyed()) return;
  // The gate can confirm a failure from a reported exit code or signal even
  // when no JavaScript exit event arrives. An earlier exit or timeout record
  // keeps its place.
  startupLog?.record(result);
  phase = "failed";
  const markup = startupFailureMarkup(result);
  if (markup) await showFailure(win, markup);
  // Rendering can take a turn; do not let a late failure exit override a
  // normal quit that started meanwhile.
  if (quitting || win.isDestroyed()) return;
  if (process.env.QUANT_DESKTOP_SMOKE === "1") return failStartup();
  showWindow(win);
}
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
async function main() {
  await app.whenReady();
  if (quitting) return;
  const port = await freePort();
  if (quitting) return;
  const origin = `http://127.0.0.1:${port}`,
    root = app.isPackaged
      ? join(process.resourcesPath, "server")
      : join(__dirname, "..", ".next", "standalone");
  // A relative value is resolved once against the bundled service root: that
  // is the child's cwd and the standalone server.js __dirname, so an existing
  // relative database keeps the location older builds actually used. Never
  // resolve against the caller cwd. An explicit empty value stays invalid
  // (mkdir below fails) instead of silently becoming that root.
  const configuredData = process.env.QUANT_DATA_DIR;
  const data =
    configuredData === undefined
      ? resolve(
          join(
            process.env.LOCALAPPDATA ?? app.getPath("userData"),
            "QuantWorkbench",
          ),
        )
      : configuredData === ""
        ? configuredData
        : resolve(root, configuredData);
  mkdirSync(data, { recursive: true });
  const logPath = join(data, "server.log");
  serviceOrigin = origin;
  const prefs = desktopPreferences(data, origin, token);
  let restartPending: Promise<void> | undefined;
  let attempt: Promise<void>;
  let hiddenByClose = false;

  async function syncPreferences(selection?: boolean) {
    try {
      await prefs.synchronize(selection);
    } finally {
      refreshTray();
    }
  }

  function restart() {
    if (quitting || process.env.QUANT_DESKTOP_SMOKE === "1") return;
    if (restartPending) return restartPending;
    if (phase === "starting") return;
    phase = "restarting";
    refreshTray();
    restartPending = (async () => {
      // A prior failed navigation must not poison the next recovery attempt.
      await attempt.catch(() => {});
      await stopService();
      if (quitting) return;
      phase = "starting";
      startupFailure = undefined;
      failurePage = undefined;
      attempt = launch();
      await attempt;
    })()
      .catch(() => {
        if (quitting) return;
        phase = "failed";
        failurePage = undefined;
        if (window) return showFailure(window, SERVICE_STOPPED_MARKUP);
      })
      .finally(() => {
        restartPending = undefined;
        refreshTray();
      });
    return restartPending;
  }

  function openRoute(path: string) {
    if (!window || quitting) return;
    hiddenByClose = false;
    showWindow(window);
    window.focus();
    if (phase === "running") void window.loadURL(origin + path).catch(() => {});
  }

  function refreshTray() {
    if (!tray || !window || window.isDestroyed() || quitting) return;
    const owner = window;
    tray.setToolTip(
      phase === "running"
        ? "观澜量化 · 后台监控运行中"
        : "观澜量化 · 后台服务尚未就绪",
    );
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开今日计划", click: () => openRoute("/") },
        { label: "打开行情看盘", click: () => openRoute("/scan") },
        { label: "打开后台任务", click: () => openRoute("/system/tasks") },
        { type: "separator" },
        {
          label: "关闭窗口时最小化到托盘",
          type: "checkbox",
          checked: prefs.closeToTray,
          enabled: phase === "running",
          click: (item) =>
            syncPreferences(item.checked).catch(() => {
              if (!quitting)
                void dialog.showMessageBox(owner, {
                  message: "桌面设置未能同步，请重试。",
                });
            }),
        },
        {
          label: "重启后台服务",
          enabled: phase === "running" || phase === "failed",
          click: restart,
        },
        {
          label: "打开数据与日志目录",
          click: () => openDataDirectory(data, owner),
        },
        { label: "彻底退出并停止监控", click: () => app.quit() },
      ]),
    );
  }

  function createWindow() {
    const appWindow = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 850,
      minHeight: 650,
      title: "观澜 · 量化研究工作台",
      backgroundColor: "#f3f6fa",
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: join(__dirname, "preload.cjs"),
      },
    });
    window = appWindow;
    function authorize(event: IpcMainInvokeEvent, allowRecovery = false) {
      const frame = event.senderFrame;
      if (
        quitting ||
        appWindow.isDestroyed() ||
        !frame ||
        event.sender !== appWindow.webContents ||
        frame !== appWindow.webContents.mainFrame
      )
        throw new Error("无权操作桌面宿主");
      const url = new URL(frame.url);
      if (
        frame.origin === origin &&
        url.origin === origin &&
        url.protocol === "http:"
      )
        return;
      // The stopped server cannot host recovery UI. Only the exact fixed document
      // loaded by this host can request a restart from its opaque data origin.
      if (
        allowRecovery &&
        phase === "failed" &&
        url.protocol === "data:" &&
        frame.origin === "null" &&
        frame.url === failurePage
      )
        return;
      throw new Error("无权操作桌面宿主");
    }
    ipcMain.handle("quant:select-directory", async (event) => {
      authorize(event);
      const result = await dialog.showOpenDialog(appWindow, {
        properties: ["openDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    });
    ipcMain.handle("quant:get-desktop-prefs", (event) => {
      authorize(event);
      return { closeToTray: prefs.closeToTray };
    });
    ipcMain.handle("quant:set-close-to-tray", (event, value: unknown) => {
      authorize(event);
      if (typeof value !== "boolean") throw new Error("无效的桌面设置");
      return syncPreferences(value);
    });
    ipcMain.handle("quant:restart-service", (event) => {
      authorize(event, true);
      return restart();
    });
    appWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    appWindow.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(origin + "/")) event.preventDefault();
    });
    appWindow.on("close", (event) => {
      if (
        prefs.closeToTray &&
        !quitting &&
        process.env.QUANT_DESKTOP_SMOKE !== "1"
      ) {
        event.preventDefault();
        hiddenByClose = true;
        appWindow.hide();
      }
    });
    tray = new Tray(
      nativeImage
        .createFromPath(join(__dirname, "icon.png"))
        .resize({ width: 24, height: 24 }),
    );
    tray.on("double-click", () => {
      hiddenByClose = false;
      showWindow(appWindow);
    });
    refreshTray();
    return appWindow;
  }

  async function launch() {
    // One record per attempt is prepared only after the data root exists and
    // before the child can report anything.
    startupLog = createDesktopStartupRecorder(logPath);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      QUANT_DATA_DIR: data,
      QUANT_SESSION_TOKEN: token,
      QUANT_WORKER_DIR: join(root, "runtime"),
    };
    // Ship the same Node ABI as the backend build: Electron remains a thin shell,
    // and native SQLite never depends on Electron's independently changing ABI.
    const node = join(root, "node-runtime", "node.exe");
    startup = new AbortController();
    try {
      service = spawn(node, [join(root, "server.js")], {
        cwd: root,
        env,
        stdio: "pipe",
        windowsHide: true,
      });
    } catch (error) {
      // A synchronous spawn throw has the same fixed failure landing as an
      // asynchronous error event; no health request is attempted.
      abortStartup(spawnErrorResult(error));
    }
    const child = service;
    if (child) {
      child.on("error", (error) => {
        if (service !== child || quitting || phase === "restarting") return;
        safeAppend(logPath, "Backend process could not start.\n");
        abortStartup(spawnErrorResult(error));
      });
      child.on("exit", (code, signal) => {
        if (service !== child || quitting || phase === "restarting") return;
        if (phase === "starting") {
          // Includes code 0 and signal termination: startup never continues.
          abortStartup(exitedResult(code, signal));
          return;
        }
        if (phase === "running" && !quitting && code !== 0) {
          phase = "failed";
          if (window) void showFailure(window, SERVICE_STOPPED_MARKUP);
          refreshTray();
        }
      });
      child.stderr?.on("data", (chunk) =>
        safeAppend(
          logPath,
          String(chunk).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]"),
        ),
      );
    }
    // The 45 s budget starts as soon as exit/error are observable, before window
    // creation can consume any of it.
    const healthPromise: Promise<StartupHealthResult> = startupFailure
      ? Promise.resolve(startupFailure)
      : waitForStartupHealth({
          url: `${origin}/api/health`,
          signal: startup.signal,
        });
    // A settled non-ready cause owns the record immediately. A later exit, an
    // unfinished cookie write or a user quit must not replace it.
    void healthPromise.then((result) => {
      if (result.status === "cancelled") startupLog?.record(result);
      else if (result.status !== "ready") abortStartup(result);
    });
    await session.defaultSession.cookies.set({
      url: origin,
      name: "quant-session",
      value: token,
      httpOnly: true,
      sameSite: "strict",
    });
    if (quitting) return;
    const appWindow = window ?? createWindow();
    const health = await healthPromise;
    if (health.status !== "ready" && health.status !== "cancelled")
      startupFailure ??= health;
    const gate = () => ({
      quitting,
      windowAlive: !appWindow.isDestroyed(),
      exitCode: service?.exitCode ?? null,
      signalCode: service?.signalCode ?? null,
      failure: startupFailure,
    });
    let decision = startupNavigationDecision(gate());
    if (decision.action === "quiet") return;
    if (decision.action === "failure") {
      await finishStartupFailure(appWindow, decision.result);
      refreshTray();
      return;
    }
    let navigationFailed = false;
    try {
      await appWindow.loadURL(origin);
    } catch {
      navigationFailed = true;
    }
    // The service may have exited between the ready result and loadURL settling.
    decision = startupNavigationDecision(gate());
    if (decision.action === "quiet") return;
    if (decision.action === "failure") {
      await finishStartupFailure(appWindow, decision.result);
      refreshTray();
      return;
    }
    if (navigationFailed) {
      if (quitting || appWindow.isDestroyed()) return;
      // No known service exit: keep the original main().catch failure behavior.
      throw new Error("Desktop page failed to load");
    }
    phase = "running";
    // Identity, the first page load and the post-load re-check all succeeded.
    // This lands before the independent smoke step.
    startupLog?.record({ status: "ready" });
    if (process.env.QUANT_DESKTOP_SMOKE === "1") {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (quitting || appWindow.isDestroyed()) return;
      if (serviceStopped()) return failStartup();
      const text = await appWindow.webContents.executeJavaScript(
        "document.body.innerText",
      );
      if (quitting || appWindow.isDestroyed()) return;
      // A code 0 or signal exit during the wait/read is still a failed smoke and
      // must not leave a smoke.txt behind.
      if (serviceStopped()) return failStartup();
      appendFileSync(join(data, "smoke.txt"), String(text));
      quitting = true;
      app.quit();
    } else {
      await syncPreferences().catch(() =>
        safeAppend(logPath, "Desktop preferences unavailable.\n"),
      );
      if (!quitting && !hiddenByClose) showWindow(appWindow);
    }
  }
  attempt = launch();
  await attempt;
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  let exitReleased = false;
  let exitPending = false;
  app.on("before-quit", (event) => {
    quitting = true;
    startupLog?.record({ status: "cancelled" });
    startup?.abort({ status: "cancelled" });
    if (exitReleased || !service) return;
    event.preventDefault();
    if (exitPending) return;
    exitPending = true;
    void stopService()
      .then(() => {
        exitReleased = true;
        app.quit();
      })
      .catch(() => {
        exitPending = false;
        reportStopFailure();
      });
  });
  app.on("window-all-closed", () => app.quit());
  void main().catch(() => {
    if (quitting) return;
    startupLog?.record({ status: "host-error" });
    failStartup();
  });
}

function reportStopFailure() {
  quitting = false;
  dialog.showErrorBox("后台服务未能停止", "请从托盘菜单重试退出并查看日志。");
}
