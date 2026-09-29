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
  await page.getByRole("button", { name: /合成报告 999/ }).click();
  await page
    .getByRole("button", { name: "保存事实核对", exact: true })
    .waitFor();
  await page.getByLabel("事实原文摘录", { exact: true }).fill("未保存的草稿");
  await page.getByRole("button", { name: /合成报告 998/ }).click();
  await page.getByRole("button", { name: /合成报告 999/ }).click();
  const draftAfterSwitch = await page
    .getByLabel("事实原文摘录", { exact: true })
    .inputValue();
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
        browser: browser.version(),
        errors,
        draftAfterSwitch,
        dom: await page.locator("*").count(),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ errors, draftAfterSwitch }));
} finally {
  await browser.close();
}
