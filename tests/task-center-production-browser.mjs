/** Real API/UI, synthetic persisted tasks, explicitly isolated local server only. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
assert.equal(process.env.TASK_ISOLATED, "1");
const data = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(data.startsWith(resolve(tmpdir()) + "\\quant-task-center-"));
const serverPid = Number(process.env.TASK_SERVER_PID);
assert.ok(serverPid > 0);
const base = process.env.BASE ?? "http://127.0.0.1:3219";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const db = new Database(join(data, "quant.sqlite"));
db.pragma("busy_timeout=5000");
function seed(id, status) {
  const now = Date.now();
  db.prepare(
    "INSERT OR REPLACE INTO records(id,kind,payload,updated_at) VALUES(?,'job',?,?)",
  ).run(
    id,
    JSON.stringify({
      id,
      type: "screen",
      status,
      progress: 40,
      createdAt: now,
      updatedAt: now,
      ownerPid: serverPid,
      input: { type: "formula-screen" },
      phase: "合成生产验收任务",
    }),
    now,
  );
}
function transition(id, status) {
  const row = db.prepare("SELECT payload FROM records WHERE id=?").get(id);
  const job = JSON.parse(row.payload);
  db.prepare("UPDATE records SET payload=?,updated_at=? WHERE id=?").run(
    JSON.stringify({
      ...job,
      status,
      updatedAt: Date.now(),
      progress: status === "completed" ? 100 : 40,
    }),
    Date.now(),
    id,
  );
}
seed("task-production-watch", "running");
seed("task-production-cancel", "queued");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  const requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("/api/trpc/"))
      requests.push({ path: new URL(r.url()).pathname, method: r.method() });
  });
  await page.goto(base + "/tasks");
  await page.locator("#task-trigger-task-production-watch").waitFor();
  await page.getByLabel("精确任务编号").fill("task-production-watch");
  await page.getByRole("button", { name: "查找", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[aria-label="任务列表"] article').length === 1,
  );
  const start = performance.now();
  transition("task-production-watch", "completed");
  await page
    .locator("#task-trigger-task-production-watch")
    .getByText("已完成", { exact: true })
    .waitFor();
  const convergeMs = performance.now() - start;
  assert.ok(convergeMs <= 3000, `Convergence ${convergeMs}ms`);
  await page.locator("#task-trigger-task-production-watch").click();
  await page
    .locator("#task-detail-task-production-watch")
    .getByText("已完成 · 100%", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "刷新任务", exact: true }).click();
  assert.equal(
    await page
      .locator("#task-trigger-task-production-watch")
      .getAttribute("aria-expanded"),
    "true",
  );
  await page.getByLabel("精确任务编号").fill("task-production-cancel");
  await page.getByRole("button", { name: "查找", exact: true }).click();
  await page.locator("#task-trigger-task-production-cancel").click();
  await page
    .locator("#task-detail-task-production-cancel")
    .getByRole("button", { name: "取消任务", exact: true })
    .click();
  await page
    .locator("#task-detail-task-production-cancel")
    .getByText("已取消 · 40%", { exact: true })
    .waitFor();
  assert.equal(
    JSON.parse(
      db
        .prepare(
          "SELECT payload FROM records WHERE id='task-production-cancel'",
        )
        .get().payload,
    ).status,
    "cancelled",
  );
  assert.equal(
    await page
      .locator("#task-detail-task-production-cancel")
      .getByRole("link", { name: "前往来源页重新配置" })
      .getAttribute("href"),
    "/screen",
  );
  const read = await page.request.get(
    base +
      "/api/trpc/taskState?input=" +
      encodeURIComponent(
        JSON.stringify({ json: { id: "task-production-cancel" } }),
      ),
    { headers: { "x-quant-client": "workbench", origin: base } },
  );
  assert.ok(read.ok(), `${read.status()}: ${await read.text()}`);
  const content = JSON.stringify(await read.json());
  assert.ok(!content.includes('"input"'));
  assert.ok(!content.includes('"result":{ "large"'));
  const outcomes = [];
  for (const id of [
    "missing-production",
    "task-production-cancel",
    "task-production-watch",
  ]) {
    const response = await page.request.post(base + "/api/trpc/cancel", {
      data: { json: id },
      headers: { "x-quant-client": "workbench", origin: base },
    });
    assert.ok(response.ok());
    const body = await response.json();
    outcomes.push(body.result.data.json.outcome);
  }
  assert.deepEqual(outcomes, [
    "not-found",
    "already-cancelled",
    "already-terminal",
  ]);
  await page
    .locator("#task-detail-task-production-cancel")
    .getByRole("link", { name: "前往来源页重新配置" })
    .click();
  await page.waitForURL(base + "/screen");
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM records WHERE kind='job' AND id NOT LIKE 'task-perf-%'",
      )
      .get().n,
    2,
  );
  for (const width of [900, 640]) {
    await page.goto(base + "/tasks");
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('[aria-label="任务列表"] article').first().waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
  }
  assert.deepEqual(errors, []);
  assert.ok(
    !requests.some(
      (r) => r.method === "POST" && /analyze|research|testChannel/.test(r.path),
    ),
  );
  writeFileSync(
    join(tmpdir(), "logs", "quant-task-center", "production-functional.json"),
    JSON.stringify(
      { passed: true, convergeMs, outcomes, errors, requests },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, convergeMs, outcomes }));
} finally {
  await browser.close();
  // Only the two named synthetic records owned by this script; source data is untouched.
  db.prepare(
    "DELETE FROM records WHERE kind='job' AND id IN ('task-production-watch','task-production-cancel')",
  ).run();
  db.close();
}
