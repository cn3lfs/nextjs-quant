import { expect, test, guardWorkbenchPage } from "./workbench-test";
import {
  budgets,
  metrics,
  sidebarPages,
  trpcCalls,
  visit,
  waitForIdleServer,
} from "./helpers";

const panelPaths = [
  "/scan?tab=formula",
  "/system/notifications",
  "/lab/backtest",
  "/system/tasks",
] as const;
function readyPanel(
  page: import("@playwright/test").Page,
  path: (typeof panelPaths)[number],
) {
  switch (path) {
    case "/scan?tab=formula":
      return page.getByLabel("公式源码", { exact: true });
    case "/system/notifications":
      return page.getByRole("tablist", { name: "监控工作区" });
    case "/lab/backtest":
      return page.getByRole("region", { name: "策略回测实验室" });
    case "/system/tasks":
      return page.getByRole("combobox", { name: "任务类型" });
  }
}

test("first load ships a small bundle and panels load on first visit", async ({
  page,
  browser,
}, testInfo) => {
  // Warm the server (first queries of a fresh process) in a throwaway
  // context; what is measured is a new session's first visit to each panel.
  const warm = await browser.newPage();
  const warmApi = await guardWorkbenchPage(warm);
  await waitForIdleServer(warm);
  await warm.goto("/", { waitUntil: "networkidle" });
  for (const path of panelPaths) await visit(warm, path);
  expect([...warmApi.unknown]).toEqual([]);
  await warm.close();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto("/", { waitUntil: "networkidle" });
  // User-facing cost: main-thread script time of the first load. Bytes include
  // Next's prefetch of every sidebar route and only guard against a heavy
  // dependency (e.g. the chart library) leaking into the shell.
  const { metrics: list } = await cdp.send("Performance.getMetrics");
  const scriptDuration = list.find((m) => m.name === "ScriptDuration")?.value;
  expect(typeof scriptDuration, "Chrome must report ScriptDuration").toBe(
    "number",
  );
  const scriptMs = scriptDuration! * 1000;
  const scripts = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) => e.name.endsWith(".js"))
      .map((e) => ({
        kb: (e as PerformanceResourceTiming).decodedBodySize / 1024,
        name: e.name,
      })),
  );
  expect(scripts.length, "Loaded scripts must be measurable").toBeGreaterThan(
    0,
  );
  const scriptKb = scripts.reduce((s, x) => s + x.kb, 0);
  await testInfo.attach("initial-load", {
    body: JSON.stringify({ scriptMs, scriptKb, scripts }, null, 2),
    contentType: "application/json",
  });
  expect.soft(scriptMs).toBeLessThanOrEqual(budgets.firstLoadScriptMs);
  expect
    .soft(scriptKb)
    .toBeLessThanOrEqual(budgets.firstLoadScriptKbIncludingPrefetch);
  // First visit of each panel, in five fresh sessions; the median is judged
  // (a single sample swings with background work on the machine).
  // Keep the established landing-page idle period so comparisons use the
  // same navigation workload. Cached panels use usePanelPrefetch; /tasks is
  // a regular request-rendered route and is not in that prefetch list.
  const firstVisit = async (session: typeof page) => {
    await session.goto("/", { waitUntil: "networkidle" });
    await session.waitForTimeout(2000);
    const times: Record<string, number> = {};
    for (const path of panelPaths) {
      const started = await session.evaluate(() => performance.now());
      await session.locator(`a[href="${path}"]`).first().click();
      await expect(session).toHaveURL((url) => url.pathname === path);
      await readyPanel(session, path).waitFor({ state: "visible" });
      times[path] = (await session.evaluate(() => performance.now())) - started;
      // Let this panel finish its own loads and renders so the next timing is
      // that panel's first visit, not this one's trailing work.
      await session.waitForLoadState("networkidle");
      await session.waitForTimeout(500);
    }
    return times;
  };
  const runs = [await firstVisit(page)];
  for (let i = 0; i < 4; i++) {
    const session = await browser.newPage();
    const api = await guardWorkbenchPage(session);
    session.on("pageerror", (error) => errors.push(error.message));
    runs.push(await firstVisit(session));
    expect([...api.unknown]).toEqual([]);
    await session.close();
  }
  await testInfo.attach("first-visit", {
    body: JSON.stringify(runs, null, 2),
    contentType: "application/json",
  });
  for (const path of panelPaths) {
    const median = runs.map((r) => r[path]!).sort((x, y) => x - y)[2]!;
    expect
      .soft(median, path)
      .toBeLessThanOrEqual(
        path === "/system/notifications"
          ? budgets.panelFirstSwitchMsSignals
          : budgets.panelFirstSwitchMs,
      );
  }
  await cdp.detach();
  expect(errors).toEqual([]);
});

test("after touring every page, hidden panels stay quiet", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await waitForIdleServer(page);
  await page.goto("/", { waitUntil: "networkidle" });
  for (const path of sidebarPages) await visit(page, path);
  // Loads started on a page can finish after leaving it; wait for a quiet
  // 3-second window (at most 30 s) before observing.
  for (let i = 0; i < 10; i++)
    if (!(await trpcCalls(page, () => page.waitForTimeout(3000))).length) break;
  // Only activity summaries poll for sidebar badges. The tour ends on /tasks;
  // status belongs to other pages and must now be counted as a hidden request.
  const shell = new Set(["taskOverview", "monitorWorkspaceSummary"]);
  const cdp = await page.context().newCDPSession(page);
  const observe = async () => {
    const start = await metrics(page, cdp);
    const names = (
      await trpcCalls(page, () => page.waitForTimeout(10000))
    ).filter((name) => !shell.has(name));
    return { names, start, end: await metrics(page, cdp) };
  };
  // A late one-shot load (e.g. the pinned chart finishing after the tour) may
  // land in the first window; a hidden panel that polls repeats in the next.
  let window = await observe();
  if (window.names.length) window = await observe();
  const { names: calls, start: before, end: after } = window;
  await testInfo.attach("hidden-panel-window", {
    body: JSON.stringify(window, null, 2),
    contentType: "application/json",
  });
  expect(typeof before.TaskDuration).toBe("number");
  expect(typeof after.TaskDuration).toBe("number");
  expect(calls, "requests from hidden panels").toHaveLength(
    budgets.hiddenPanelRequestsIn10s,
  );
  expect(
    (after.TaskDuration! - before.TaskDuration!) * 1000,
  ).toBeLessThanOrEqual(budgets.idleMainThreadMsIn10s);
  // The tour ends on /tasks, an ordinary route outside the panel cache.
  // Its visible content must not be counted as a seventh cached panel.
  await expect(page).toHaveURL((url) => url.pathname === "/system/tasks");
  await expect(page.locator(".page > div:not([hidden])")).toHaveCount(1);
  expect(await page.locator(".page > div[hidden]").count()).toBeLessThanOrEqual(
    6,
  );
  await cdp.detach();
  expect(errors).toEqual([]);
});
