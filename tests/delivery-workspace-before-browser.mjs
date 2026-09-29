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
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
};
const http = {};
for (const [procedure, input] of [
  ["deliveryBatches", undefined],
  [
    "deliveryPreview",
    {
      path: join(fixture.files, "large.csv"),
      account: "合成预览账户",
      source: "generic",
    },
  ],
]) {
  const times = [];
  let bytes = 0;
  for (let i = 0; i < 35; i++) {
    const started = performance.now();
    const response = await fetch(
      `${base}/api/trpc/${procedure}${input ? `?input=${encodeURIComponent(JSON.stringify({ json: input }))}` : ""}`,
      { headers: { "x-quant-client": "workbench", origin: base } },
    );
    const body = await response.text();
    assert.equal(response.status, 200, body.slice(0, 500));
    const result = JSON.parse(body).result.data.json;
    if (procedure === "deliveryBatches") assert.equal(result.length, 1000);
    else assert.equal(result.summary.new, 10000);
    bytes = Buffer.byteLength(body);
    if (i >= 5) times.push(performance.now() - started);
  }
  http[procedure] = { ...stats(times), bytes };
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const entered = performance.now();
  await page.goto(`${base}/trade-review`);
  await page.getByText("history-999.csv", { exact: false }).first().waitFor();
  const entryMs = performance.now() - entered;
  await page.screenshot({ path: join(logs, "before-1440.png") });
  await page
    .getByLabel("交割单目录（只读）", { exact: true })
    .fill(fixture.files);
  await page.getByRole("button", { name: "列出文件", exact: true }).click();
  await page.getByRole("button", { name: "选择文件", exact: true }).click();
  await page.getByLabel("账户别名", { exact: true }).fill("合成预览账户");
  const started = performance.now();
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByText(/将写入 10000 行/).waitFor({ timeout: 120000 });
  const previewMs = performance.now() - started;
  const domElements = await page.locator("*").count();
  await page.screenshot({ path: join(logs, "before-preview-1440.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(logs, "before-preview-390.png") });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  const result = {
    http,
    entryMs,
    previewMs,
    domElements,
    overflow,
    errors,
    browser: browser.version(),
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
    note: "Old production build; one browser interaction sample, not P95. No confirmation or fact writes.",
  };
  writeFileSync(
    join(logs, "d0-browser-baseline.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
