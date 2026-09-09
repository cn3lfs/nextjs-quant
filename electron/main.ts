import { app, BrowserWindow, Tray, Menu, nativeImage, session } from "electron";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
let window: BrowserWindow | undefined,
  tray: Tray | undefined,
  service: ChildProcess | undefined,
  quitting = false;
const token = randomBytes(32).toString("hex");
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
  const port = await freePort(),
    origin = `http://127.0.0.1:${port}`,
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
  service = spawn(node, [join(root, "server.js")], {
    cwd: root,
    env,
    stdio: "pipe",
    windowsHide: true,
  });
  service.on("exit", (code) => {
    if (!quitting && code !== 0)
      window?.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(
            "<h2>本地服务已停止</h2><p>请退出应用后重新启动。日志位于应用用户目录。</p>",
          ),
      );
  });
  service.on("error", () =>
    appendFileSync(
      join(data, "server.log"),
      "Backend process could not start.\n",
    ),
  );
  service.stderr?.on("data", (chunk) =>
    appendFileSync(
      join(data, "server.log"),
      String(chunk).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]"),
    ),
  );
  await session.defaultSession.cookies.set({
    url: origin,
    name: "quant-session",
    value: token,
    httpOnly: true,
    sameSite: "strict",
  });
  window = new BrowserWindow({
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
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
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
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    await window.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          "<h2>启动超时</h2><p>本地服务未能启动，请查看用户目录 server.log。</p>",
        ),
    );
  } else await window.loadURL(origin);
  if (process.env.QUANT_DESKTOP_SMOKE === "1") {
    if (!ready) throw new Error("Desktop service failed");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const text = await window.webContents.executeJavaScript(
      "document.body.innerText",
    );
    appendFileSync(join(data, "smoke.txt"), String(text));
    quitting = true;
    app.quit();
  } else window.show();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.on("before-quit", () => {
    quitting = true;
    if (service?.pid && service.exitCode === null) {
      spawnSync("taskkill.exe", ["/PID", String(service.pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 10000,
        stdio: "ignore",
      });
      service.kill();
    }
  });
  app.on("window-all-closed", () => app.quit());
  void main().catch(() => {
    quitting = true;
    service?.kill();
    app.exit(1);
  });
}
