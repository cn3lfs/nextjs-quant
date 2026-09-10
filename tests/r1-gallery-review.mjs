// R1 gallery interactions and B-layer review artifacts; no business API calls.
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
  resolve(".test-data/r1/browser"),
);
const destination = resolve("docs/review/r1-review");
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:3214/ui-gallery");
  await page.getByRole("heading", { name: "UI 组件画廊" }).waitFor();
  await page.addStyleTag({ content: "nextjs-portal { visibility: hidden; }" });
  const capture = (name) =>
    page.screenshot({
      path: join(destination, `${name}.png`),
      fullPage: true,
      animations: "disabled",
    });
  await capture("gallery");
  const table = page.getByRole("table", { name: "分页展示样例" });
  const ids = () => table.locator("tbody tr td:first-child").allTextContents();
  assert.deepEqual(await ids(), ["sh600519", "sz000001"]);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  assert.deepEqual(await ids(), ["sz000002"]);
  assert.ok(
    await page
      .getByRole("button", { name: "下一页", exact: true })
      .isDisabled(),
  );
  await page.getByRole("button", { name: "证券代码" }).click();
  assert.deepEqual(await ids(), ["sz000002", "sz000001"]);
  assert.equal(
    await table.locator("th").first().getAttribute("aria-sort"),
    "descending",
  );
  const mode = page.getByRole("combobox", { name: "表格展示状态" });
  for (const [option, message] of [
    ["加载中", "正在加载…"],
    ["空数据", "暂无数据。"],
    ["加载失败", "样例读取失败，请重试。"],
  ]) {
    await mode.click();
    await page.getByRole("option", { name: option, exact: true }).click();
    assert.ok((await table.innerText()).includes(message));
  }
  await capture("gallery-error");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  assert.deepEqual(await ids(), ["sz000002", "sz000001"]);
  await page.getByLabel("观察名称", { exact: true }).fill("日线观察");
  await page.getByRole("checkbox").press("Space");
  assert.equal(
    await page.getByRole("checkbox").getAttribute("data-state"),
    "unchecked",
  );
  await page.getByRole("switch").press("Space");
  assert.equal(
    await page.getByRole("switch").getAttribute("data-state"),
    "checked",
  );
  await page.getByRole("tab", { name: "使用边界" }).click();
  assert.ok(
    await page.getByText("样例不是投资建议，也不代表策略业绩。").isVisible(),
  );
  await page.getByRole("button", { name: "展开 / 收起说明" }).click();
  assert.equal(await page.getByText("折叠内容仅展示，不保存设置。").count(), 0);
  const dialogTrigger = page.getByRole("button", {
    name: "打开对话框",
    exact: true,
  });
  await dialogTrigger.focus();
  await dialogTrigger.press("Enter");
  await page.getByRole("dialog").waitFor();
  await capture("gallery-dialog");
  await page.keyboard.press("Escape");
  assert.ok(
    await dialogTrigger.evaluate((el) => el === document.activeElement),
  );
  await page.getByRole("button", { name: "打开菜单", exact: true }).click();
  await page.getByRole("menu").waitFor();
  await capture("gallery-menu");
  await page.getByRole("menuitem", { name: "查看样例", exact: true }).click();
  assert.ok(await page.getByText("已选择查看样例。").isVisible());
  await page.getByRole("button", { name: "查看提示", exact: true }).focus();
  await page.getByRole("tooltip").waitFor();
  await capture("gallery-tooltip");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("gallery-mobile");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(destination, "gallery-checks.json"),
    JSON.stringify(
      {
        keyboardControls: true,
        dialogFocusReturned: true,
        paginationAndSortResponses: true,
        emptyLoadingErrorRetry: true,
        mobileOverflow: false,
        pageErrors: errors,
        visualAcceptance: "B 层待用户确认",
      },
      null,
      2,
    ),
  );
  console.log(
    "Gallery interactions passed; B-layer acceptance remains pending.",
  );
} finally {
  await browser.close();
}
