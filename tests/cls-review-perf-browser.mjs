import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto("http://127.0.0.1:3224/cls-review");
  const panel = page.getByRole("region", { name: "已导入报告", exact: true });
  const list = page.getByLabel("报告列表", { exact: true });
  await list.getByRole("button").first().waitFor();
  const filters = [],
    paging = [],
    details = [];
  for (let i = 0; i < 35; i++) {
    const prefix = i % 2 ? "98" : "99",
      last = i % 2 ? 989 : 999;
    await page
      .getByLabel("报告标题", { exact: true })
      .fill(`合成报告 ${prefix}`);
    const start = performance.now();
    await page.getByRole("button", { name: "查询报告", exact: true }).click();
    await list
      .getByRole("button", { name: new RegExp(`^合成报告 ${last} ·`) })
      .waitFor();
    if (i >= 5) filters.push(performance.now() - start);
  }
  await panel.getByRole("button", { name: "重置", exact: true }).click();
  await list.getByRole("button", { name: /^合成报告 2019 ·/ }).waitFor();
  for (let i = 0; i < 35; i++) {
    const next = i % 2 === 0,
      start = performance.now();
    await panel
      .getByRole("button", { name: next ? "下一页" : "上一页", exact: true })
      .click();
    await list
      .getByRole("button", {
        name: next ? /^合成报告 999 ·/ : /^合成报告 2019 ·/,
      })
      .waitFor();
    if (i >= 5) paging.push(performance.now() - start);
  }
  for (let i = 0; i < 35; i++) {
    const index = 999 - (i % 10),
      start = performance.now();
    await list
      .getByRole("button", { name: new RegExp(`^合成报告 ${index} ·`) })
      .click();
    await page
      .getByRole("heading", { name: `合成报告 ${index}`, exact: true })
      .waitFor();
    await page
      .getByRole("textbox", { name: "事实原文摘录", exact: true })
      .waitFor();
    if (i >= 5) details.push(performance.now() - start);
  }
  const summary = (values) => {
    values.sort((a, b) => a - b);
    return { p50: values[15], p95: values[28] };
  };
  const result = {
    browser: browser.version(),
    filters: summary(filters),
    paging: summary(paging),
    details: summary(details),
    fixture: "142MB stress data, normal report detail",
  };
  writeFileSync(
    join(tmpdir(), "logs/quant-cls-review/browser-performance.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  assert.ok(
    [result.filters, result.paging, result.details].every(
      (value) => value.p95 <= 300,
    ),
    "normal interaction P95 <= 300ms",
  );
} finally {
  await browser.close();
}
