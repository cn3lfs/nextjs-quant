import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTRPCClient, httpLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../src/server/api/root";

export function desktopPreferences(
  data: string,
  origin: string,
  token: string,
) {
  const path = join(data, "desktop-prefs.json");
  let closeToTray = false;
  try {
    closeToTray = JSON.parse(readFileSync(path, "utf8")).closeToTray === true;
  } catch {
    // On first launch or after a damaged cache, the workspace supplies the value.
  }
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: origin + "/api/trpc",
        transformer: superjson,
        headers: {
          cookie: `quant-session=${token}`,
          "x-quant-client": "workbench",
        },
        fetch: (url, options) =>
          fetch(url, {
            ...options,
            redirect: "error",
            signal: AbortSignal.timeout(3000),
          }),
      }),
    ],
  });
  let queue = Promise.resolve();
  function synchronize(traySelection?: boolean) {
    const next = queue.then(async () => {
      let prefs = await client.workspacePreferences.query();
      if (traySelection !== undefined && prefs.closeToTray !== traySelection)
        prefs = await client.saveWorkspacePreferences.mutate({
          closeToTray: traySelection,
        });
      if (typeof prefs.closeToTray !== "boolean")
        throw new Error("无效的桌面设置");
      closeToTray = prefs.closeToTray;
      writeFileSync(path + ".tmp", JSON.stringify({ closeToTray }), "utf8");
      renameSync(path + ".tmp", path);
    });
    queue = next.catch(() => {});
    return next;
  }
  return {
    get closeToTray() {
      return closeToTray;
    },
    synchronize,
  };
}
