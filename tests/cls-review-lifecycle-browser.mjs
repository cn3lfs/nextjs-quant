import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const logs = join(tmpdir(), "logs", "quant-cls-review");
const checks = [],
  errors = [],
  requests = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/api/trpc/"))
      requests.push(
        ...new URL(request.url()).pathname
          .split("/api/trpc/")[1]
          .split(",")
          .filter((name) => name.startsWith("clsReview")),
      );
  });
  await page.goto("http://127.0.0.1:3224/cls-review");
  const list = page.getByLabel("报告列表", { exact: true });
  const quote = page.getByRole("textbox", { name: /^事实原文摘录/ });
  await list.getByRole("button", { name: /合成报告 997/ }).click();
  await page.getByRole("combobox", { name: "原文章节", exact: true }).click();
  await page.getByRole("option", { name: "行业观点", exact: true }).click();
  await quote.fill("合成证据");
  await page.getByRole("textbox", { name: /^核对依据/ }).fill("隔离竞态保存A");
  let release, received;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const responseReceived = new Promise((resolve) => {
    received = resolve;
  });
  await page.route("**/api/trpc/clsReviewSaveFact*", async (route) => {
    const response = await route.fetch();
    received();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "保存事实核对", exact: true }).click();
  await responseReceived;
  await quote.fill("保存后继续编辑");
  await list.getByRole("button", { name: /合成报告 996/ }).click();
  await quote.fill("报告B自己的草稿");
  release();
  await page.waitForTimeout(300);
  assert.equal(await quote.inputValue(), "报告B自己的草稿");
  await list.getByRole("button", { name: /合成报告 997/ }).click();
  assert.equal(await quote.inputValue(), "保存后继续编辑");
  await page.unroute("**/api/trpc/clsReviewSaveFact*");
  checks.push("delayed A save does not clear B or new A revision");
  await page.route("**/api/trpc/clsReviewSaveFact*", (route) => route.abort());
  await page.getByRole("button", { name: "保存事实核对", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /fetch|Failed|网络|请求/i })
    .waitFor();
  assert.equal(await quote.inputValue(), "保存后继续编辑");
  await page.unroute("**/api/trpc/clsReviewSaveFact*");
  checks.push("failed save retains draft");
  await page.getByRole("button", { name: "调度设置", exact: true }).click();
  await page
    .getByRole("button", { name: "保存调度设置", exact: true })
    .waitFor();
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(300);
  const hiddenStart = requests.length;
  await page.waitForTimeout(60000);
  assert.equal(requests.length, hiddenStart, "hidden page issues no CLS reads");
  checks.push("controlled hidden 60 seconds: zero automatic CLS reads");
  console.log("Hidden lifecycle passed");
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.locator('a[href="/reports"]').first().click();
  await page.waitForTimeout(500);
  const leftStart = requests.length;
  await page.waitForTimeout(60000);
  assert.equal(requests.length, leftStart, "leaving route issues no CLS reads");
  checks.push("actual route leave 60 seconds: zero automatic CLS reads");
  await page.locator('a[href="/cls-review"]').first().click();
  assert.equal(await quote.inputValue(), "保存后继续编辑");
  checks.push("route return preserves draft");
  const warningPromise=page.waitForEvent("dialog");
  const reload=page.reload({timeout:5000}).catch(()=>null);
  const warning=await warningPromise;
  assert.equal(warning.type(),"beforeunload");
  await warning.dismiss();await reload;
  assert.equal(await quote.inputValue(),"保存后继续编辑");
  checks.push("refresh warns about unsaved drafts; dismiss preserves edits");
  assert.deepEqual(errors, []);
  writeFileSync(
    join(logs, "lifecycle.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  writeFileSync(
    join(logs, "lifecycle-failure.json"),
    JSON.stringify({ checks, errors, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
