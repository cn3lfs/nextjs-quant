/** Real local UI/API with persisted synthetic jobs; never launches a model task. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url),
  Database = require("better-sqlite3");
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(directory.startsWith(resolve(tmpdir()) + "\\quant-news-"));
const base = process.env.BASE ?? "http://127.0.0.1:3223";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const ownerPid = Number(process.env.NEWS_SERVER_PID);
assert.ok(ownerPid > 0);
const db = new Database(join(directory, "quant.sqlite"));
db.pragma("busy_timeout=5000");
const id = "news-ui-fixture-job";
assert.equal(db.prepare("SELECT 1 FROM records WHERE id=?").get(id), undefined);
const archive = db
  .prepare(
    "SELECT id FROM records WHERE kind='news-analysis' ORDER BY updated_at DESC LIMIT 1",
  )
  .get().id;
function job(status, extra = {}) {
  const now = Date.now();
  const value = {
    id,
    type: "research",
    status,
    progress: status === "completed" ? 100 : 25,
    createdAt: now,
    updatedAt: now,
    ownerPid,
    input: { kind: "news-analysis" },
    phase: "合成验收任务",
    ...extra,
  };
  db.prepare("INSERT OR REPLACE INTO records VALUES(?,'job',?,?)").run(
    id,
    JSON.stringify(value),
    now,
  );
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
const checks = [],
  errors = [],
  requests = [];
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("/api/trpc/"))
      requests.push(
        new URL(r.url()).pathname.split("/api/trpc/")[1].split(","),
      );
  });
  const count = () =>
    requests
      .flat()
      .filter((p) =>
        /^(newsWorkspace|newsOriginal|newsArchiveHistory|newsAnalysis|newsResumePreflight|newsAnalysisContext|newsTaskState|newsSectorReports|newsThemes|latestThemePrices|job)$/.test(
          p,
        ),
      ).length;
  const filter = {
    cutoff: Date.parse("2025-01-07T16:00:00+08:00"),
    query: "",
    historical: true,
  };
  const url =
    base +
    "/news?newsQuery=" +
    encodeURIComponent(JSON.stringify(filter)) +
    "&newsJob=" +
    id;
  job("queued");
  await page.goto(url);
  await page
    .getByLabel("新闻分析任务")
    .getByText(/排队中/)
    .waitFor();
  job("running");
  await page
    .getByLabel("新闻分析任务")
    .getByText(/运行中/)
    .waitFor();
  await page.getByRole("button", { name: "取消分析", exact: true }).click();
  await page
    .getByLabel("新闻分析任务")
    .getByText(/已取消/)
    .waitFor();
  await page
    .getByText("取消已请求，请等待任务状态确认。", { exact: true })
    .waitFor();
  checks.push(
    "queued/running/cancel request/terminal state via real local API",
  );
  for (const [terminal, message] of [
    ["completed", "任务已经结束，无需取消。"],
    ["cancelled", "任务已取消。"],
    ["missing", "任务已不存在。"],
  ]) {
    job("running");
    await page.reload();
    await page.getByRole("button", { name: "取消分析", exact: true }).waitFor();
    if (terminal === "missing")
      db.prepare("DELETE FROM records WHERE id=?").run(id);
    else job(terminal);
    await page.getByRole("button", { name: "取消分析", exact: true }).click();
    await page.getByText(message, { exact: true }).waitFor();
  }
  checks.push(
    "cancel races distinguish already-terminal/already-cancelled/not-found",
  );
  job("running");
  await page.reload();
  await page.getByRole("button", { name: "取消分析", exact: true }).waitFor();
  job("completed", { result: { id: archive } });
  await page
    .getByRole("button", { name: "下载新闻分析与原文", exact: true })
    .waitFor();
  assert.ok(page.url().includes("analysis="));
  assert.equal(
    requests
      .flat()
      .filter((p) => p === "newsSectorReports" || p === "newsThemes").length,
    0,
  );
  const extensionResponse = page.waitForResponse((r) =>
    r.url().includes("newsSectorReports"),
  );
  await page
    .getByRole("button", { name: "行业与主题扩展", exact: true })
    .click();
  await page.getByText("行业新闻研究", { exact: true }).waitFor();
  await extensionResponse;
  checks.push(
    "terminal opens actual result; extension reads only after explicit expansion",
  );
  // Failure and explicit retry on a fresh original query.
  await page.getByRole("button", { name: "返回新闻列表", exact: true }).click();
  await page.locator("[data-news-original]").first().waitFor();
  await page.route("**/api/trpc/**", (route) =>
    route.request().url().includes("newsOriginal")
      ? route.abort("failed")
      : route.continue(),
  );
  await page.locator("[data-news-original]").first().click();
  await page.getByRole("button", { name: "重试读取", exact: true }).waitFor();
  await page.unroute("**/api/trpc/**");
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page
    .getByRole("button", { name: "下载完整新闻原文", exact: true })
    .waitFor();
  checks.push("original network failure and explicit retry");
  // A running job proves polling really stops rather than testing an idle page.
  job("running");
  await page.goto(url);
  await page.getByRole("button", { name: "取消分析", exact: true }).waitFor();
  await page.waitForTimeout(2300);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(500);
  const hiddenStart = count();
  await page.waitForTimeout(60000);
  assert.equal(count() - hiddenStart, 0);
  const restoreStart = requests.length;
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(700);
  const restored = requests.slice(restoreStart).flat();
  for (const p of new Set(restored))
    assert.ok(
      restored.filter((x) => x === p).length <= 1,
      `duplicate restore ${p}`,
    );
  checks.push(
    "controlled visibility hidden60s zero reads; restore at most once per query",
  );
  await page.locator('a[href="/settings"]').first().click();
  await page.waitForURL("**/settings");
  await page.waitForTimeout(600);
  const awayStart = count();
  await page.waitForTimeout(60000);
  assert.equal(count() - awayStart, 0);
  checks.push("real route navigation away60s zero news reads");
  job("failed", { error: "合成任务失败，成功批次已保存" });
  await page.goto(url);
  await page
    .getByText("合成任务失败，成功批次已保存", { exact: true })
    .waitFor();
  await page.waitForTimeout(600);
  const idleStart = count();
  await page.waitForTimeout(60000);
  assert.equal(count() - idleStart, 0);
  checks.push("failure visible; idle terminal60s no periodic reads");
  assert.deepEqual(errors, []);
  writeFileSync(
    join(tmpdir(), "logs", "quant-news", "browser-lifecycle.json"),
    JSON.stringify(
      {
        checks,
        restored,
        errors,
        note: "Synthetic persisted jobs; no model invocation; hidden visibility injected, route navigation actual",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  db.prepare("DELETE FROM records WHERE id=? AND kind='job'").run(id);
  db.close();
}
