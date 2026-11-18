import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  session,
  dialog,
  ipcMain,
} from "electron";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  SERVICE_STOPPED_MARKUP,
  exitedResult,
  spawnErrorResult,
  startupFailureMarkup,
  startupNavigationDecision,
  waitForStartupHealth,
  type StartupHealthResult,
} from "./startup-health";

let window: BrowserWindow | undefined,
  tray: Tray | undefined,
  service: ChildProcess | undefined,
  quitting = false,
  phase: "starting" | "running" | "failed" = "starting",
  startup: AbortController | undefined,
  startupFailure: StartupHealthResult | undefined,
  failureShown = false;
const token = randomBytes(32).toString("hex");
function page(markup: string) {
  return "data:text/html;charset=utf-8," + encodeURIComponent(markup);
}
function stopService() {
  if (
    service?.pid &&
    service.exitCode === null &&
    service.signalCode === null
  ) {
    spawnSync("taskkill.exe", ["/PID", String(service.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 10000,
      stdio: "ignore",
    });
    service.kill();
  }
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
  stopService();
  app.exit(1);
}
// Startup keeps only the first cause and never renders from an event handler;
// the navigation path below owns the single failure page.
function abortStartup(result: StartupHealthResult) {
  if (phase !== "starting" || startupFailure) return;
  startupFailure = result;
  startup?.abort(result);
}
async function showFailure(win: BrowserWindow, markup: string) {
  if (quitting || failureShown || win.isDestroyed()) return;
  failureShown = true;
  try {
    await win.loadURL(page(markup));
  } catch {}
}
function showWindow(win: BrowserWindow) {
  if (!win.isDestroyed()) win.show();
}
async function finishStartupFailure(
  win: BrowserWindow,
  result: StartupHealthResult,
) {
  if (quitting || win.isDestroyed()) return;
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
  const data =
    process.env.QUANT_DATA_DIR ??
    join(process.env.LOCALAPPDATA ?? app.getPath("userData"), "QuantWorkbench");
  mkdirSync(data, { recursive: true });
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
  if (service) {
    service.on("error", (error) => {
      appendFileSync(
        join(data, "server.log"),
        "Backend process could not start.\n",
      );
      abortStartup(spawnErrorResult(error));
    });
    service.on("exit", (code, signal) => {
      if (phase === "starting") {
        // Includes code 0 and signal termination: startup never continues.
        abortStartup(exitedResult(code, signal));
        return;
      }
      if (phase === "running" && !quitting && code !== 0) {
        phase = "failed";
        if (window) void showFailure(window, SERVICE_STOPPED_MARKUP);
      }
    });
    service.stderr?.on("data", (chunk) =>
      appendFileSync(
        join(data, "server.log"),
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
  await session.defaultSession.cookies.set({
    url: origin,
    name: "quant-session",
    value: token,
    httpOnly: true,
    sameSite: "strict",
  });
  if (quitting) return;
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
  ipcMain.handle("quant:select-directory", async (event) => {
    if (
      event.sender !== appWindow.webContents ||
      event.senderFrame !== appWindow.webContents.mainFrame ||
      !event.senderFrame.url.startsWith(origin + "/")
    )
      throw new Error("无权选择目录");
    const result = await dialog.showOpenDialog(appWindow, {
      properties: ["openDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  appWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  appWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(origin + "/")) event.preventDefault();
  });
  tray = new Tray(
    nativeImage
      .createFromPath(join(__dirname, "icon.png"))
      .resize({ width: 24, height: 24 }),
  );
  tray.setToolTip("观澜量化 · 后台监控运行中");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开研究工作台", click: () => window?.show() },
      {
        label: "退出并停止监控",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", () => window?.show());
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
    return;
  }
  if (navigationFailed) {
    if (quitting || appWindow.isDestroyed()) return;
    // No known service exit: keep the original main().catch failure behavior.
    throw new Error("Desktop page failed to load");
  }
  phase = "running";
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
  } else showWindow(appWindow);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.on("before-quit", () => {
    quitting = true;
    startup?.abort({ status: "cancelled" });
    stopService();
  });
  app.on("window-all-closed", () => app.quit());
  void main().catch(() => {
    // A quit that interrupts startup is normal and stays silent.
    if (quitting) return;
    quitting = true;
    stopService();
    app.exit(1);
  });
}
