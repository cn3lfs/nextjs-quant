/** Screening baseline against a running production server with an isolated
 * database that has been scanned (topbar 扫描本地数据). Usage:
 *   BASE=http://127.0.0.1:3217 node tests/screen-perf-browser.mjs
 * Times the default full-market TDX formula screen from click to rendered
 * candidates, then result paging and sorting (click → table updated).
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
  await page.goto(`${base}/screen`);
  // Running requires a passed syntax / future-function check first.
  await page.getByRole("button", { name: "语法检查与未来函数门禁" }).click();
  const t0 = Date.now();
  await page.getByRole("button", { name: "全市场执行公式" }).click();
  // Candidate count pill changes from "—个" once results render.
  const results = page.locator("text=/候选结果/").locator("..");
  await page.waitForFunction(
    () =>
      /\d+\s*个/.test(
        document.body.innerText.match(/候选结果\s*\S+/)?.[0] ?? "",
      ),
    null,
    { timeout: 600000 },
  );
  const screenMs = Date.now() - t0;
  const summary = (await results.innerText()).slice(0, 80).replace(/\n/g, " ");
  await page.screenshot({
    path: join(tmpdir(), "screen-results.png"),
    fullPage: true,
  });
  const timed = async (label, act) => {
    const first = await page
      .locator("tbody tr")
      .first()
      .innerText()
      .catch(() => "");
    const t = Date.now();
    await act();
    await page
      .waitForFunction(
        (before) =>
          (document.querySelector("tbody tr")?.textContent ?? "") !== before,
        first.replace(/\s+/g, ""),
        { timeout: 20000 },
      )
      .catch(() => {});
    return { label, ms: Date.now() - t };
  };
  const rows = [];
  const next = page.getByRole("button", { name: /下一页/ }).first();
  if (await next.count()) rows.push(await timed("翻页", () => next.click()));
  const header = page.locator("thead th button").nth(1);
  if (await header.count())
    rows.push(await timed("排序", () => header.click()));
  console.log(JSON.stringify({ screenMs, summary, rows, errors }, null, 1));
} finally {
  await browser.close();
}
