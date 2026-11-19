import { spawnSync, type ChildProcess } from "node:child_process";

export async function stopDesktopService(
  child: ChildProcess,
  origin: string,
  token: string,
) {
  const alive = () =>
    child.pid && child.exitCode === null && child.signalCode === null;
  if (!alive()) return;
  const request = new AbortController();
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => {
    finish = resolve;
  });
  child.once("exit", finish);
  const deadline = setTimeout(finish, 3500);
  try {
    void fetch(`${origin}/api/shutdown`, {
      method: "POST",
      headers: { "x-quant-session": token },
      redirect: "error",
      signal: request.signal,
    })
      .then((response) => response.body?.cancel())
      .catch(() => {});
    await exited;
    if (!alive()) return;
    const result = spawnSync(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      {
        windowsHide: true,
        timeout: 10000,
        stdio: "ignore",
      },
    );
    if (result.status !== 0 && alive()) {
      // Node's kill uses the existing process handle, avoiding a recycled PID.
      if (!child.kill()) throw new Error("本地服务未能停止");
      await new Promise<void>((resolve) => child.once("exit", resolve));
    }
  } finally {
    clearTimeout(deadline);
    child.off("exit", finish);
    request.abort();
  }
}
