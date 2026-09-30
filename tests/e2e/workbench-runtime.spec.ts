import { expect, test } from "@playwright/test";
import {
  budgets,
  metrics,
  sidebarPages,
  trpcCalls,
  visit,
  waitForIdleServer,
} from "./helpers";

test("first load ships a small bundle and panels load on first visit", async ({
  page,
  browser,
}) => {
  // Warm the server (first queries of a fresh process) in a throwaway
  // context; what is measured is a new session's first visit to each panel.
  const warm = await browser.newPage();
  await waitForIdleServer(warm);
  await warm.goto("/", { waitUntil: "networkidle" });
  for (const path of ["/screen", "/signals", "/backtest", "/tasks"])
    await visit(warm, path);
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
  const scriptMs =
    (list.find((m) => m.name === "ScriptDuration")?.value ?? 0) * 1000;
  expect(scriptMs).toBeLessThanOrEqual(budgets.firstLoadScriptMs);
  const scripts = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) => e.name.endsWith(".js"))
      .map((e) => ({
        kb: (e as PerformanceResourceTiming).decodedBodySize / 1024,
        name: e.name,
      })),
  );
  expect(scripts.reduce((s, x) => s + x.kb, 0)).toBeLessThanOrEqual(
    budgets.firstLoadScriptKbIncludingPrefetch,
  );
  // First visit of each panel, in five fresh sessions; the median is judged
  // (a single sample swings with background work on the machine).
  // A user reads the landing page for a moment: that idle time lets the panel
  // chunks prefetch (Workbench usePanelPrefetch). Clicking with no idle time
  // at all costs 60-500 ms on /tasks (decisions 2026-09-30).
  const firstVisit = async (session: typeof page) => {
    await session.goto("/", { waitUntil: "networkidle" });
    await session.waitForTimeout(2000);
    const times: Record<string, number> = {};
    for (const path of ["/screen", "/signals", "/backtest", "/tasks"]) {
      const started = await session.evaluate(() => performance.now());
      await session.locator(`a[href="${path}"]`).first().click();
      await session.waitForFunction(() => {
        const shown = [...document.querySelectorAll(".page > div")].find(
          (d) => !(d as HTMLElement).hidden,
        ) as HTMLElement | undefined;
        return (shown?.innerText.trim().length ?? 0) > 20;
      });
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
    runs.push(await firstVisit(session));
    await session.close();
  }
  for (const path of ["/screen", "/signals", "/backtest", "/tasks"]) {
    const median = runs.map((r) => r[path]!).sort((x, y) => x - y)[2]!;
    expect(median, path).toBeLessThanOrEqual(
      path === "/signals"
        ? budgets.panelFirstSwitchMsSignals
        : budgets.panelFirstSwitchMs,
    );
  }
  expect(errors).toEqual([]);
});

test("after touring every page, hidden panels stay quiet", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await waitForIdleServer(page);
  await page.goto("/", { waitUntil: "networkidle" });
  for (const path of sidebarPages) await visit(page, path);
  // Loads started on a page can finish after leaving it; wait for a quiet
  // 3-second window (at most 30 s) before observing.
  for (let i = 0; i < 10; i++)
    if (!(await trpcCalls(page, () => page.waitForTimeout(3000))).length) break;
  // The workbench shell itself polls job/status/subscription summaries every
  // 30 s for sidebar badges; everything else here would be a hidden panel.
  const shell = new Set(["jobs", "status", "monitorWorkspaceSummary"]);
  const observe = async () => {
    const start = await metrics(page);
    const names = (
      await trpcCalls(page, () => page.waitForTimeout(10000))
    ).filter((name) => !shell.has(name));
    return { names, start, end: await metrics(page) };
  };
  // A late one-shot load (e.g. the pinned chart finishing after the tour) may
  // land in the first window; a hidden panel that polls repeats in the next.
  let window = await observe();
  if (window.names.length) window = await observe();
  const { names: calls, start: before, end: after } = window;
  expect(calls, "requests from hidden panels").toHaveLength(
    budgets.hiddenPanelRequestsIn10s,
  );
  expect(
    (after.TaskDuration! - before.TaskDuration!) * 1000,
  ).toBeLessThanOrEqual(budgets.idleMainThreadMsIn10s);
  // At most panelCacheLimit panels stay mounted.
  expect(await page.locator(".page > div").count()).toBeLessThanOrEqual(6);
  expect(errors).toEqual([]);
});
