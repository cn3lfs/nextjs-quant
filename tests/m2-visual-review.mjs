/** M2 milestone review. Run against a built server using an isolated data profile:
 *   pnpm exec tsx tests/m2-visual-review.mjs
 * Uses the existing shared Playwright installation; no project dependency added.
 * Generates review evidence, never asserts agreement with 通达信.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const require = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
);
const { chromium } = require("playwright");
const destination = resolve("docs/m2-review");
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1800, height: 1200 },
    timezoneId: "Asia/Shanghai",
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.M2_REVIEW_URL ?? "http://127.0.0.1:3210");
  const chart = page.getByTestId("market-chart");
  await chart.waitFor({ timeout: 30000 });
  assert.equal(await chart.getAttribute("data-period"), "day");
  const panel = page.locator("section").filter({ has: chart });
  assert.match(await panel.innerText(), /600519/);
  console.log("UI snapshot:\n" + (await chart.ariaSnapshot()));
  await chart.getByLabel("BOLL", { exact: true }).check();
  const screenshots = [];
  for (const [mode, filename] of process.argv.includes("--interactions-only")
    ? []
    : [
        ["none", "sh600519-day-main.png"],
        ["volume", "sh600519-day-volume.png"],
        ["macd", "sh600519-day-macd.png"],
        ["kdj", "sh600519-day-kdj.png"],
        ["rsi", "sh600519-day-rsi.png"],
      ]) {
    await chart.getByLabel("副图", { exact: true }).selectOption(mode);
    const canvas = chart.locator(".price-chart");
    await canvas.scrollIntoViewIfNeeded();
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + bounds.width * 0.62, bounds.y + 130);
    // Allow the chart's animation frame and React legend commit to settle.
    await page.waitForTimeout(150);
    const legend = await chart.getByTestId("chart-legend").innerText();
    assert.match(legend, /MA5/);
    assert.match(legend, /BOLL上/);
    if (mode === "macd") assert.match(legend, /DIF.*DEA.*MACD/s);
    if (mode === "kdj") assert.match(legend, /K .*D .*J /s);
    if (mode === "rsi") assert.match(legend, /RSI6.*RSI12.*RSI24/s);
    assert.equal(
      await chart.locator('a[href="https://www.tradingview.com/"]').count(),
      1,
    );
    await panel.screenshot({ path: join(destination, filename) });
    screenshots.push({
      filename,
      mode,
      legend,
      history: await chart.getByTestId("chart-history").innerText(),
    });
  }
  const before = await chart.getByTestId("chart-history").innerText();
  const bounds = await chart.locator(".price-chart").boundingBox();
  for (
    let attempt = 0;
    attempt < 3 &&
    (await chart.getByTestId("chart-history").innerText()) === before;
    attempt++
  ) {
    await page.mouse.move(bounds.x + 40, bounds.y + 120);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 120, bounds.y + 120, {
      steps: 25,
    });
    await page.mouse.up();
    await page.waitForTimeout(150);
  }
  await page.waitForFunction(
    (previous) =>
      document.querySelector('[data-testid="chart-history"]')?.textContent !==
      previous,
    before,
  );
  const after = await chart.getByTestId("chart-history").innerText();
  await page.getByRole("button", { name: "5 分钟", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="market-chart"]')
        ?.getAttribute("data-period") === "5m",
    { timeout: 30000 },
  );
  assert.match(
    await chart.getByTestId("chart-legend").innerText(),
    /T.*\+08:00/,
  );
  const minuteLegend = await chart.getByTestId("chart-legend").innerText();
  await page.getByRole("button", { name: "日 K", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="market-chart"]')
        ?.getAttribute("data-period") === "day",
  );
  assert.doesNotMatch(
    await chart.getByTestId("chart-legend").innerText(),
    /T\d\d:/,
  );
  assert.deepEqual(errors, []);
  const evidence = {
    symbol: "sh600519",
    period: "day",
    adjustment: "none",
    capturedAt: new Date().toISOString(),
    screenshots,
    historyScroll: { before, after },
    minuteLegend,
    errors,
    visualAgreement: "用户待核对，执行者未判定",
  };
  await writeFile(
    join(
      destination,
      process.argv.includes("--interactions-only")
        ? "interactions.json"
        : "capture.json",
    ),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser.close();
}
