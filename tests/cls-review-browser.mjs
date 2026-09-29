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
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:3224/cls-review");
  const list = page.getByLabel("报告列表", { exact: true });
  await list.getByRole("button", { name: /合成报告 999/ }).click();
  await page.getByRole("combobox", { name: "原文章节", exact: true }).click();
  await page.getByRole("option", { name: "行业观点", exact: true }).click();
  await page.getByRole("textbox", { name: /^事实原文摘录/ }).fill("合成证据");
  await page.getByLabel("核对依据", { exact: true }).fill("隔离浏览器核对依据");
  await page.getByRole("combobox", { name: "核对结果", exact: true }).click();
  await page.getByRole("option", { name: "有依据支持", exact: true }).click();
  await list.getByRole("button", { name: /合成报告 998/ }).click();
  assert.equal(
    await page.getByRole("textbox", { name: /^事实原文摘录/ }).inputValue(),
    "",
  );
  await list.getByRole("button", { name: /合成报告 999/ }).click();
  assert.equal(
    await page.getByRole("textbox", { name: /^事实原文摘录/ }).inputValue(),
    "合成证据",
  );
  assert.match(
    await page
      .getByRole("combobox", { name: "核对结果", exact: true })
      .innerText(),
    /有依据支持/,
  );
  await page.getByRole("button", { name: "保存事实核对", exact: true }).click();
  await page
    .getByText("事实核对已保存，历史记录已保留", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: /^事实原文摘录/ }).inputValue(),
    "",
  );
  await page
    .getByRole("button", { name: "固定样本与价格观察", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "价格核对版本", exact: true })
    .filter({ hasText: "最新" })
    .waitFor();
  await page
    .getByRole("button", { name: "读取完整核对证据", exact: true })
    .click();
  await page
    .locator("pre")
    .filter({ hasText: '"cls-verification-1"' })
    .waitFor();
  await page.getByRole("button", { name: "报告信息", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出报告与全部关联复盘", exact: true })
    .click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^cls-review-2026-09-01-v1-/);
  await download.saveAs(join(logs, "fixture-export.json"));
  await page.getByRole("button", { name: "事实核对", exact: true }).click();
  await page.screenshot({
    path: join(logs, "after-first-1440.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(logs, "after-first-390.png"),
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  assert.equal(overflow, false, "no page-wide horizontal overflow");
  assert.deepEqual(errors, []);
  writeFileSync(
    join(logs, "browser-first.json"),
    JSON.stringify(
      {
        errors,
        overflow,
        draftRestored: true,
        save: true,
        verificationEvidence: true,
        export: download.suggestedFilename(),
      },
      null,
      2,
    ),
  );
  console.log("Browser workflow passed");
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    writeFileSync(join(logs, "browser-failure.txt"), await page.locator("body").innerText());
    await page.screenshot({ path: join(logs, "browser-failure.png"), fullPage: true });
  }
  throw error;
} finally {
  await browser.close();
}
