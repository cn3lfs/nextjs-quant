/** Production UI baseline, isolated server only; does not create or cancel jobs. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
assert.equal(process.env.TASK_ISOLATED, "1");
const base = process.env.BASE ?? "http://127.0.0.1:3219";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const phase = process.env.TASK_PHASE ?? "before";
const dir = join(tmpdir(), "logs", "quant-task-center");
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const report = { phase, cold: [], expand: [], requests: [], errors: [] };
try {
  for (let i = 0; i < 5; i++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(e.message));
    page.on("request", (r) => {
      if (i === 4 && r.url().includes("/api/trpc/"))
        report.requests.push({
          path: new URL(r.url()).pathname,
          at: Date.now(),
        });
    });
    const at = performance.now();
    await page.goto(base + "/tasks");
    const first = page.locator('[id^="task-trigger-task-perf-"]').first();
    await first.waitFor();
    report.cold.push(performance.now() - at);
    if (i === 4) {
      await page.evaluate(() => {
        window.taskPaint = { expand: [], input: [] };
        const observe = (event) => {
          const kind =
            event.type === "input" &&
            event.target.getAttribute("aria-label") === "精确任务编号"
              ? "input"
              : event.type === "click" &&
                  event.target.closest('[id^="task-trigger-task-perf-"]')
                ? "expand"
                : null;
          if (!kind) return;
          const at = performance.now();
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              window.taskPaint[kind].push(performance.now() - at),
            ),
          );
        };
        document.addEventListener("click", observe, true);
        document.addEventListener("input", observe, true);
      });
      for (let n = 0; n < 33; n++) {
        const start = performance.now();
        await first.click();
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        if (n >= 3) report.expand.push(performance.now() - start);
      }
      report.resources = await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .filter((e) => e.name.includes("/api/trpc/"))
          .map((e) => ({
            path: new URL(e.name).pathname,
            bytes: e.encodedBodySize,
            ms: e.duration,
          })),
      );
      await page.screenshot({
        path: join(dir, `production-${phase}.png`),
        fullPage: true,
      });
      if (phase === "after") {
        report.input = [];
        const input = page.getByLabel("精确任务编号");
        const before = report.requests.filter((r) =>
          r.path.includes("taskHistory"),
        ).length;
        for (let n = 0; n < 33; n++) {
          const at = performance.now();
          await input.fill(`task-perf-${String(n).padStart(5, "0")}`);
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          if (n >= 3) report.input.push(performance.now() - at);
        }
        assert.equal(
          report.requests.filter((r) => r.path.includes("taskHistory")).length,
          before,
          "Typing must not query history",
        );
        await input.fill("");
      }
      report.eventToTwoFrames = await page.evaluate(() => ({
        expand: window.taskPaint.expand.slice(3),
        input: window.taskPaint.input.slice(3, 33),
      }));
      await page.locator('a[href="/settings"]').first().click();
      await page.waitForURL(base + "/settings");
      const hideAt = Date.now();
      console.log("hidden-watch-started");
      await page.waitForTimeout(65000);
      report.hidden = report.requests.filter(
        (r) =>
          r.at > hideAt &&
          r.path
            .split(/[\/,]/)
            .some((p) =>
              ["taskHistory", "taskState", "taskOverview"].includes(p),
            ),
      );
    }
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  writeFileSync(
    join(dir, `production-${phase}.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      phase,
      cold: report.cold,
      expand: report.expand,
      hidden: report.hidden,
    }),
  );
} finally {
  await browser.close();
}
