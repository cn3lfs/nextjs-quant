import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const logs = join(tmpdir(), "logs/quant-delivery-import"),
  base = "http://127.0.0.1:3228";
const fixture = JSON.parse(readFileSync(join(logs, "fixture.json"), "utf8"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [],
  values = { page: [], filter: [], return: [] };
const stats = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  return { n: sorted.length, p50: sorted[14], p95: sorted[28] };
};
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/trade-review`);
  await page
    .getByLabel("交割单目录（只读）", { exact: true })
    .fill(fixture.files);
  await page.getByRole("button", { name: "检索文件", exact: true }).click();
  await page.getByRole("button", { name: "选择文件", exact: true }).click();
  await page.getByLabel("账户别名", { exact: true }).fill("交互性能验收");
  await page.getByRole("button", { name: "预览并核对", exact: true }).click();
  await page
    .getByRole("button", { name: "核对第 20 行", exact: true })
    .waitFor();
  for (let i = 0; i < 35; i++) {
    let started = performance.now();
    await page.getByRole("button", { name: "下一页核对", exact: true }).click();
    await page
      .getByRole("button", { name: "核对第 40 行", exact: true })
      .waitFor();
    if (i >= 5) values.page.push(performance.now() - started);
    await page.getByRole("button", { name: "上一页核对", exact: true }).click();
    await page
      .getByRole("button", { name: "核对第 20 行", exact: true })
      .waitFor();
    started = performance.now();
    await page.getByLabel("核对关键词", { exact: true }).fill("fixture-9999");
    await page
      .getByRole("button", { name: "核对第 10000 行", exact: true })
      .waitFor();
    if (i >= 5) values.filter.push(performance.now() - started);
    await page.getByLabel("核对关键词", { exact: true }).fill("");
    await page
      .getByRole("button", { name: "核对第 20 行", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "核对第 1 行", exact: true })
      .click();
    await page.getByLabel("单行证据", { exact: true }).waitFor();
    started = performance.now();
    await page
      .getByRole("button", { name: "返回核对列表", exact: true })
      .click();
    await page.waitForFunction(
      () => document.activeElement?.textContent === "核对第 1 行",
    );
    if (i >= 5) values.return.push(performance.now() - started);
  }
  const result = {
    results: Object.fromEntries(
      Object.entries(values).map(([name, list]) => [name, stats(list)]),
    ),
    errors,
    domElements: await page.locator("*").count(),
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
  };
  writeFileSync(
    join(logs, "workspace-perf-browser.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  for (const [name, value] of Object.entries(result.results))
    assert.ok(value.p95 <= 300, `${name}: ${value.p95} > 300ms`);
} finally {
  await browser.close();
}
