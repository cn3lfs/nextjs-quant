/** Trade-review baseline against a running production server whose isolated
 * database holds an imported account (ACCOUNT, default "big"). Usage:
 *   BASE=http://127.0.0.1:3217 ACCOUNT=big node tests/trade-review-perf-browser.mjs
 * Times 查看复盘 from click to rendered review, then lists the slowest API calls.
 */
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = process.env.BASE ?? "http://127.0.0.1:3217";
const account = process.env.ACCOUNT ?? "big";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 80)));
  const started = new Map();
  const calls = [];
  page.on("request", (r) => started.set(r, Date.now()));
  page.on("requestfinished", (r) => {
    const url = r.url();
    if (url.includes("/api/trpc/"))
      calls.push([
        Date.now() - started.get(r),
        decodeURIComponent(url.split("/api/trpc/")[1].split("?")[0]).slice(
          0,
          90,
        ),
      ]);
  });
  await page.goto(`${base}/trade-review`, { waitUntil: "networkidle" });
  calls.length = 0;
  await page.getByLabel("复盘账户别名").fill(account);
  const t = Date.now();
  await page.getByRole("button", { name: "查看复盘" }).click();
  const busy = page.getByText("正在读取行情并计算复盘…");
  await busy.waitFor({ timeout: 5000 }).catch(() => {});
  await busy.waitFor({ state: "detached", timeout: 600000 });
  const reviewMs = Date.now() - t;
  const nodes = await page.evaluate(
    () => document.querySelectorAll("*").length,
  );
  await page.screenshot({
    path: join(tmpdir(), "trade-review.png"),
    fullPage: true,
  });
  calls.sort((a, b) => b[0] - a[0]);
  console.log(
    JSON.stringify(
      { reviewMs, nodes, slowest: calls.slice(0, 8), errors },
      null,
      1,
    ),
  );
} finally {
  await browser.close();
}
