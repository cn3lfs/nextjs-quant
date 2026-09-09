/** M3 milestone: run against the built standalone server with an isolated data profile.
 * Screenshots are for human review, never proof of agreement with 通达信.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
);
const { chromium } = require("playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const destination = "docs/m3-review";
await mkdir(destination, { recursive: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1800, height: 1200 },
    timezoneId: "Asia/Shanghai",
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.M3_REVIEW_URL ?? "http://127.0.0.1:3211");
  await page.getByRole("button", { name: "扫描本地数据", exact: true }).click();
  const chart = page.getByTestId("market-chart");
  const evidence = [];
  for (const symbol of ["sh600519", "sz002084", "bj920748"]) {
    const input = page.getByRole("combobox", { name: "搜索品种名称或代码" });
    await input.fill(symbol);
    await page
      .getByRole("option")
      .filter({ hasText: new RegExp(symbol, "i") })
      .first()
      .click();
    await page.waitForFunction(() =>
      /笔 \d+ · 线段端点/.test(
        document.querySelector('[data-testid="czsc-status"]')?.textContent ??
          "",
      ),
    );
    assert.equal(await chart.getAttribute("data-period"), "day");
    const status = await chart.getByTestId("czsc-status").innerText();
    await chart.getByLabel("缠论结构", { exact: true }).uncheck();
    await chart.getByLabel("缠论结构", { exact: true }).check();
    await chart.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await chart.screenshot({ path: join(destination, `${symbol}-day.png`) });
    evidence.push({ symbol, status });
  }
  // M3 acceptance uses three daily snapshots. The extra minute-data probe is
  // documented separately; this case does not certify minute-history loading.
  const before = await chart.getByTestId("chart-history").innerText();
  console.log("M3 history before drag", before);
  if (!before.includes("已到快照历史起点")) {
    const bounds = await chart.locator(".price-chart").boundingBox();
    for (
      let attempt = 0;
      attempt < 3 &&
      (await chart.getByTestId("chart-history").innerText()) === before;
      attempt++
    ) {
      await page.mouse.move(bounds.x + 40, bounds.y + 120);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width - 100, bounds.y + 120, {
        steps: 25,
      });
      await page.mouse.up();
      await page.waitForTimeout(200);
    }
    await page.waitForFunction(
      (previous) =>
        document.querySelector('[data-testid="chart-history"]')?.textContent !==
        previous,
      before,
    );
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(destination, "capture.json"),
    JSON.stringify(
      { evidence, errors, visualReview: "待用户人工核对" },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ evidence, errors, historyLoad: true }));
} finally {
  await browser.close();
}
