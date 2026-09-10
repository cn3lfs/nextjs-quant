// Uses the repository's existing shared Playwright installation. No installation.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const require = createRequire(
  "C:/Users/jm/.agent-tools/playwright/package.json",
);
const { chromium } = require("playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const evidence = {
  capturedAt: new Date().toISOString(),
  checks: [],
  errors: [],
  screenshots: [],
};
await mkdir("docs/q2b-review", { recursive: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1200 },
    timezoneId: "Asia/Shanghai",
  });
  page.on("pageerror", (e) => evidence.errors.push(e.message));
  await page.goto("http://127.0.0.1:3212");
  await page.getByRole("button", { name: "条件选股", exact: true }).click();
  const panel = page.getByRole("region", { name: "通达信公式选股" });
  await page
    .getByRole("option", { name: "老鸭头（价量部分，非原公式）" })
    .waitFor({ state: "attached", timeout: 30000 });
  const capture = async (name, locator = panel) => {
    await locator.screenshot({ path: `docs/q2b-review/${name}.png` });
    evidence.screenshots.push(`${name}.png`);
  };
  const check = page.getByRole("button", { name: "语法检查与未来函数门禁" });
  const execute = page.getByRole("button", { name: "全市场执行公式" });
  const source = page.getByRole("textbox", { name: "公式源码", exact: true });
  const name = page.getByRole("textbox", { name: "公式名称", exact: true });
  const params = page.getByRole("textbox", { name: "公式参数 JSON" });
  const savedName = `Q2b 参数保存验证 ${Date.now()}`;
  await name.fill(savedName);
  await check.click();
  await page.getByRole("button", { name: "保存公式", exact: true }).click();
  await panel.getByRole("status").filter({ hasText: "公式已保存" }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "条件选股", exact: true }).click();
  await page
    .getByRole("option", { name: savedName, exact: true })
    .waitFor({ state: "attached" });
  await page
    .getByRole("combobox", { name: "已保存公式" })
    .selectOption({ label: savedName });
  assert.deepEqual(JSON.parse(await params.inputValue()), { N1: 5, N2: 20 });
  evidence.checks.push("名称/源码/N1,N2 保存后刷新可恢复");
  for (const [file, fn] of [
    ["q2b-buffett", "FINANCE"],
    ["q2b-old-duck-original", "FINANCE"],
    ["q2b-price-limits", "NAMEINCLUDE"],
  ]) {
    await source.fill(await readFile(`tests/fixtures/${file}.tdx`, "utf8"));
    await params.fill('{"N1":10,"N2":10,"N3":10}');
    await check.click();
    assert.match(
      await panel.getByRole("status").innerText(),
      new RegExp(`第\\d+行 ${fn}`),
    );
    assert.equal(await execute.isDisabled(), true);
    await capture(file);
  }
  await source.fill("正常:=MA(C,5);\n选股:IF(0,ZIG(C,3),C>正常);");
  await check.click();
  assert.match(await panel.getByRole("status").innerText(), /第2行 ZIG/);
  assert.equal(await execute.isDisabled(), true);
  await capture("future-rejected");
  evidence.checks.push("三条原文明确拒绝；死分支未来函数不能执行");
  await page
    .getByRole("combobox", { name: "已保存公式" })
    .selectOption({ label: "老鸭头（价量部分，非原公式）" });
  await check.click();
  await capture("editor-ready");
  await execute.click();
  const progress = page.getByRole("region", { name: "规则与AI独立进度" });
  await progress.getByText(/规则筛选 · 运行中/).waitFor({ timeout: 30000 });
  await panel.getByText("支持函数（60）与执行边界", { exact: true }).click();
  await capture("running-progress", progress);
  evidence.checks.push("执行在 worker 期间展开函数目录，界面可交互");
  await progress.getByText(/规则筛选 · 已完成/).waitFor({ timeout: 300000 });
  const candidates = page.locator("section.panel").filter({
    has: page.getByRole("heading", { name: "候选结果", exact: true }),
  });
  await candidates
    .getByText("公式：老鸭头（价量部分，非原公式）", { exact: true })
    .waitFor({ timeout: 30000 });
  await capture("real-candidates", candidates);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出本次完整结果" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const exported = JSON.parse(await readFile(path, "utf8"));
  assert.equal(exported.format, "quant-formula-screen-export-1");
  assert.ok(exported.candidates.length > 0);
  evidence.checks.push(
    `界面编辑→门禁→worker→候选表→导出，真实候选 ${exported.candidates.length}`,
  );
  evidence.candidateCount = exported.candidates.length;
  evidence.asOf = exported.asOf;
  assert.equal(evidence.errors.length, 0);
} finally {
  await writeFile(
    "docs/q2b-review/browser-evidence.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await browser.close();
}
console.log(JSON.stringify(evidence));
