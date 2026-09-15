// Run after r2c-seed-review.ts and an isolated server on port 3217.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const require = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
);
const { chromium } = require("playwright");
assert.equal(
  resolve(process.env.QUANT_DATA_DIR ?? ""),
  resolve(".test-data/r2c/browser"),
);
const root = resolve("docs/review/r2c-review");
await mkdir(root, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const result = { interactions: [], externalRequests: [], errors: [] };
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1100 },
    timezoneId: "Asia/Shanghai",
  });
  page.on("pageerror", (e) => result.errors.push(e.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") {
      result.externalRequests.push(url.hostname);
      return route.abort();
    }
    assert.ok(
      !/testChannel|retryDelivery|mcpQuery|analyze|mock.*(order|account)/i.test(
        url.pathname,
      ),
      "No external actions during review",
    );
    // Keep this review in the no-snapshot state; startup otherwise loads local quotes.
    if (/\/snapshot(?:\?|$)/.test(url.pathname + url.search))
      return route.abort();
    return route.continue();
  });
  const capture = (name) =>
    page.screenshot({ path: join(root, `${name}.png`), fullPage: true });
  await page.goto("http://127.0.0.1:3217");
  await page.getByRole("button", { name: "数据与连接", exact: true }).click();
  await page
    .getByLabel("财联社新闻数据库路径", { exact: true })
    .fill("D:\\r2c-fixture.db");
  await page.getByLabel("自动新闻每日AI批次上限（北京时间）").fill("7");
  await page.getByLabel("模型提供方", { exact: true }).click();
  await page
    .getByRole("option", { name: "DeepSeek（API）", exact: true })
    .click();
  await page.getByLabel("轻量模型", { exact: true }).fill("r2c-fast");
  await page.getByLabel("深度模型", { exact: true }).fill("r2c-deep");
  await page.getByLabel("自动分析候选数（1–10）", { exact: true }).fill("3");
  for (const label of ["新闻自动研究", "选股和回测完成后自动分析"]) {
    const checkbox = page.getByRole("checkbox", { name: new RegExp(label) });
    await checkbox.check();
    await checkbox.uncheck();
  }
  // Switch back before saving: no provider or automatic research is invoked.
  await page.getByLabel("模型提供方", { exact: true }).click();
  await page
    .getByRole("option", { name: "Codex（默认 · 本机订阅）", exact: true })
    .click();
  await page
    .getByLabel("CLI 模型（留空使用默认模型）", { exact: true })
    .fill("r2c-cli");
  const saved = page.waitForRequest(
    (r) => r.url().includes("/saveSettings") && r.method() === "POST",
  );
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  const payload = (await saved).postDataJSON()["0"].json;
  assert.equal(payload.autoNewsDailyBatches, 7);
  assert.equal(payload.analysisLimit, 3);
  assert.equal(payload.fastModel, "r2c-fast");
  assert.equal(payload.deepModel, "r2c-deep");
  assert.equal(payload.codexModel, "r2c-cli");
  assert.equal(payload.autoAnalysis, false);
  assert.equal(payload.autoNewsAnalysis, false);
  await page.getByText("设置已保存", { exact: true }).waitFor();
  await capture("connections");
  result.interactions.push(
    "connection text/number fields, provider branches, two checkboxes and actual isolated settings submission",
  );
  await page.getByRole("button", { name: "条件选股", exact: true }).click();
  for (const [label, value] of [
    ["短均线", "6"],
    ["长均线", "21"],
    ["最低涨幅 %", "1"],
    ["最高涨幅 %", "8"],
    ["最低量比", "1.3"],
  ]) {
    const field = page.getByLabel(label, { exact: true });
    await field.fill(value);
    assert.equal(await field.inputValue(), value);
  }
  await capture("strategy-fields");
  result.interactions.push(
    "all five controlled strategy numeric fields update",
  );
  await page
    .locator("summary")
    .filter({ hasText: /^研究$/ })
    .click();
  await page.getByRole("button", { name: "证据分析", exact: true }).click();
  await page
    .getByRole("textbox", { name: /^研究问题/ })
    .fill("第一行证据\n第二行风险");
  await page.getByLabel("研究方法", { exact: true }).click();
  await page
    .getByRole("option", { name: "SEPA 分阶段研究", exact: true })
    .click();
  assert.equal(
    await page.getByRole("textbox", { name: /^研究问题/ }).inputValue(),
    "第一行证据\n第二行风险",
  );
  assert.ok(
    await page
      .getByRole("button", { name: "开始研究", exact: true })
      .isDisabled(),
  );
  // Capture only the active form; frozen panels are outside this review.
  await page
    .locator(".research-intro")
    .locator("..")
    .screenshot({ path: join(root, "evidence-analysis.png") });
  result.interactions.push(
    "evidence multiline input and method selection; missing snapshot still disables submit",
  );
  const table = page.locator('[aria-label="任务列表"]');
  await table.locator('[id="task-trigger-task-021"]').waitFor();
  assert.equal(await table.locator("article").count(), 20);
  assert.ok(
    (await table.locator("article").first().textContent()).includes("task-021"),
  );
  assert.equal(await table.locator('[data-slot="data-table-sort"]').count(), 0);
  await page.getByRole("button", { name: "下一页任务", exact: true }).click();
  await table.locator('[id="task-trigger-task-001"]').waitFor();
  assert.equal(await table.locator("article").count(), 2);
  assert.ok(
    await page
      .getByRole("button", { name: "下一页任务", exact: true })
      .isDisabled(),
  );
  await page.getByRole("button", { name: "上一页任务", exact: true }).click();
  await table.locator('[id="task-trigger-task-021"]').waitFor();
  await page.getByLabel("历史任务状态", { exact: true }).click();
  await page.getByRole("option", { name: "失败", exact: true }).click();
  await page.getByText("共 11 条 · 第 1 页", { exact: true }).waitFor();
  assert.equal(await table.locator("article").count(), 11);
  await table.locator('[id="task-trigger-task-021"]').click();
  await page
    .locator('[id="task-detail-task-021"]')
    .getByText("合成失败详情", { exact: true })
    .waitFor();
  await page.getByLabel("历史任务状态", { exact: true }).click();
  await page.getByRole("option", { name: "全部", exact: true }).click();
  await page.getByText("共 22 条 · 第 1 页", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("历史任务状态", { exact: true }).innerText(),
    "全部",
  );
  await page
    .locator(".task-bar")
    .screenshot({ path: join(root, "task-history.png") });
  result.interactions.push(
    "server creation-time descending order, 20+2 cursor pages, previous page, failed filter, details and All reset",
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.externalRequests, []);
  await writeFile(
    join(root, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
