import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const logs = join(tmpdir(), "logs", "quant-news");
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:3223/news");
  await page
    .getByLabel("新闻截止时间", { exact: true })
    .fill("2025-01-07T16:00");
  await page.getByText(/本次筛选 10000 条/).waitFor();
  const archiveOptions =
    (await page
      .getByLabel("历史新闻分析", { exact: true })
      .locator("option")
      .count()) - 1;
  assert.equal(archiveOptions, 50);
  const details = await page.locator("details").count();
  assert.equal(details, 50);
  await page.screenshot({
    path: join(logs, "before-1440.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(logs, "before-390.png"), fullPage: true });
  writeFileSync(
    join(logs, "browser-before.json"),
    JSON.stringify(
      {
        archiveOptions,
        fixtureArchives: 121,
        newsDetails: details,
        dom: await page.locator("*").count(),
        errors,
        browser: browser.version(),
        note: "production build old NewsPanel; local 10000-news fixture, no model action",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
