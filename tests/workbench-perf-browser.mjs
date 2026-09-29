/** Workbench shell baseline against a running production server with an
 * isolated database. Start it first, e.g.
 *   QUANT_DATA_DIR=$PWD/.test-data/wb-baseline PORT=3217 node scripts/start.mjs
 * Usage: BASE=http://127.0.0.1:3217 node tests/workbench-perf-browser.mjs
 * Reports cold-load JS weight and timing, sidebar navigation time, and the
 * idle main-thread cost (CDP TaskDuration) with several panels mounted.
 */
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = process.env.BASE ?? "http://127.0.0.1:3217";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    timezoneId: "Asia/Shanghai",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let jsBytes = 0,
    jsFiles = 0;
  page.on("response", async (response) => {
    if (!response.url().endsWith(".js")) return;
    jsFiles++;
    jsBytes += (await response.body().catch(() => Buffer.alloc(0))).length;
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const busy = async () =>
    (await cdp.send("Performance.getMetrics")).metrics.find(
      (m) => m.name === "TaskDuration",
    ).value * 1000;
  const started = Date.now();
  await page.goto(`${base}/`, { waitUntil: "load" });
  const timing = await page.evaluate(() => {
    const [nav] = performance.getEntriesByType("navigation");
    const paint = performance
      .getEntriesByType("paint")
      .find((p) => p.name === "first-contentful-paint");
    return {
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
      load: Math.round(nav.loadEventEnd),
      firstContentfulPaint: Math.round(paint?.startTime ?? -1),
    };
  });
  await page.waitForLoadState("networkidle").catch(() => {});
  const cold = {
    ...timing,
    wallMs: Date.now() - started,
    jsFiles,
    jsKB: Math.round(jsBytes / 1024),
  };
  // Sidebar navigation: click → the target panel's heading is visible.
  const nav = [];
  for (const [label, path] of [
    ["行情图表", "/market"],
    ["条件选股", "/screen"],
    ["策略研究", "/research"],
    ["信号与通知", "/signals"],
    ["今日总览", "/"],
  ]) {
    const link = page.locator(`a[href="${path}"]`).first();
    if (!(await link.count())) {
      nav.push({ label, missing: true });
      continue;
    }
    const t0 = Date.now(),
      b0 = await busy();
    await link.click();
    await page.waitForURL(`${base}${path}`);
    await page.waitForTimeout(50);
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    nav.push({
      label,
      ms: Date.now() - t0,
      taskMs: Math.round((await busy()) - b0),
    });
  }
  // Idle with those panels mounted: polling and background rerenders.
  await page.waitForTimeout(2000);
  if (process.env.PROFILE)
    await cdp.send("Profiler.enable").then(() => cdp.send("Profiler.start"));
  const i0 = await busy();
  await page.waitForTimeout(20000);
  const idleTaskMsPer10s = Math.round(((await busy()) - i0) / 2);
  if (process.env.PROFILE) {
    // Top self-time and inclusive-time functions while idle.
    const { profile } = await cdp.send("Profiler.stop");
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of profile.nodes)
      for (const c of n.children ?? []) parent.set(c, n.id);
    const self = new Map(),
      total = new Map();
    const name = (n) =>
      `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`;
    profile.samples.forEach((id, i) => {
      const dt = (profile.timeDeltas[i] ?? 0) / 1000;
      const n = byId.get(id);
      self.set(name(n), (self.get(name(n)) ?? 0) + dt);
      const seen = new Set();
      for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
        const key = name(byId.get(cur));
        if (seen.has(key)) continue;
        seen.add(key);
        total.set(key, (total.get(key) ?? 0) + dt);
      }
    });
    const top = (m) =>
      [...m]
        .filter(
          ([k]) =>
            !k.startsWith("(idle)") &&
            !k.startsWith("(root)") &&
            !k.startsWith("(program)"),
        )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([k, v]) => `${v.toFixed(0)}ms ${k}`);
    console.log(
      JSON.stringify({ self: top(self), total: top(total) }, null, 1),
    );
  }
  await page.screenshot({
    path: join(tmpdir(), "workbench-overview.png"),
    fullPage: true,
  });
  console.log(JSON.stringify({ cold, nav, idleTaskMsPer10s, errors }, null, 1));
} finally {
  await browser.close();
}
