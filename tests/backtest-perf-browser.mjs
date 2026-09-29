/** Backtest baseline against a running production server with an isolated
 * database holding a loaded snapshot. Usage:
 *   BASE=http://127.0.0.1:3217 node tests/backtest-perf-browser.mjs
 * Times 运行回测 and 运行滚动检验 from click to rendered results.
 */
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = process.env.BASE ?? "http://127.0.0.1:3217";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 80)));
  await page.goto(`${base}/backtest`, { waitUntil: "networkidle" });
  // Done = a fresh equity chart (backtest) or 测试段平均收益 (walk-forward)
  // rendered after the click; stale results are tagged first.
  const run = async (label, button, selector) => {
    await page
      .locator(selector)
      .evaluateAll((els) => els.forEach((el) => (el.dataset.stale = "1")));
    const t = Date.now();
    await page.getByRole("button", { name: button }).click();
    await page.waitForSelector(`${selector}:not([data-stale])`, {
      timeout: 600000,
    });
    return { label, ms: Date.now() - t };
  };
  const rows = [
    await run("回测", "运行回测", "[data-testid=equity-chart] > div"),
    await run("滚动检验", "运行滚动检验", "p:has-text('测试段平均收益')"),
  ];
  await page.screenshot({
    path: join(tmpdir(), "backtest-results.png"),
    fullPage: true,
  });
  console.log(JSON.stringify({ rows, errors }, null, 1));
} finally {
  await browser.close();
}
