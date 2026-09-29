/** Real-browser check of the actual IntradayChart component with a stubbed
 * tRPC client (synthetic minutes shaped like TDX responses; no network).
 * Usage: node tests/intraday-browser.mjs  (writes a screenshot to the OS temp dir)
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
const require = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
);
const { chromium } = require("playwright");
// Daily bars end on 2026-09-24; the live previous close 1251.24 is 09-23's
// close, so the live minutes belong to 09-24 (verified), as observed on TDX.
const stub = `
const day = (base, drift) => Array.from({ length: 240 }, (_, i) => ({
  price: +(base + Math.sin(i / 20) * 6 + drift * i / 240).toFixed(2), volume: 400 + (i % 30) * 20 }));
const minutes = { 20260924: day(1250, -12), 20260923: day(1256, -5), 20260922: day(1262, -6) };
const bars = [["2026-09-21", 1268], ["2026-09-22", 1256.1], ["2026-09-23", 1251.24], ["2026-09-24", 1237]]
  .map(([date, close]) => ({ date, open: close, high: close, low: close, close, volume: 1, amount: 1 }));
const q = (data) => ({ data, isLoading: false, error: null, refetch() {}, dataUpdatedAt: 1 });
export const api = {
  tdxMinutes: { useQuery: (input) => q(minutes[20260924]) },
  tdxQuotes: { useQuery: () => q([{ preClose: 1251.24 }]) },
  chartBars: { useQuery: () => q({ bars }) },
  useQueries: (build) => build({ tdxMinutes: (input) => input }).map((input) => q(minutes[input.date])),
};`;
const result = await build({
  stdin: {
    contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntradayChart } from './src/components/market/intraday-chart';
createRoot(document.getElementById('root')).render(<div style={{height: 700}}><IntradayChart symbol="sh600519" snapshotId="s" /></div>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  alias: { "~": "./src" },
  plugins: [
    {
      name: "stub-trpc",
      setup(b) {
        b.onResolve({ filter: /^~\/trpc\/react$/ }, () => ({
          path: resolve("stub-trpc.js"),
          namespace: "stub",
        }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: stub,
          loader: "js",
        }));
      },
    },
  ],
  define: { "process.env.NODE_ENV": '"production"' },
});
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/bundle.js" ? "text/javascript" : "text/html; charset=utf-8",
  );
  res.end(
    req.url === "/bundle.js"
      ? result.outputFiles[0].text
      : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>',
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1400, height: 800 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('[data-testid="intraday-chart"] canvas');
  await page.waitForTimeout(300);
  const legend = () =>
    page.locator('[data-testid="intraday-legend"]').innerText();
  // Last minute of the verified live day 09-24, change vs 1251.24.
  const last = await legend();
  assert.ok(last.startsWith("2026-09-24 15:00"), last);
  assert.ok(!last.includes("?"), "live day is verified");
  const box = await page
    .locator('[data-testid="intraday-chart"] canvas')
    .first()
    .boundingBox();
  await page.mouse.move(box.x + 120, box.y + 150);
  await page.waitForTimeout(100);
  const hovered = await legend();
  assert.ok(
    hovered.startsWith("2026-09-24 09:") ||
      hovered.startsWith("2026-09-24 10:"),
    hovered,
  );
  await page.getByRole("button", { name: "3日" }).click();
  await page.waitForTimeout(200);
  await page.mouse.move(box.x + 60, box.y + 150);
  await page.waitForTimeout(100);
  const early = await legend();
  assert.ok(early.startsWith("2026-09-22"), `3 days start on 09-22: ${early}`);
  await page.keyboard.press("Alt+1");
  await page.mouse.move(box.x + 60, box.y + 150);
  await page.waitForTimeout(100);
  assert.ok(
    (await legend()).startsWith("2026-09-24"),
    "Alt+1 returns to one day",
  );
  await page.getByRole("button", { name: "3日" }).click();
  await page.mouse.move(box.x + box.width - 200, box.y + 120);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(tmpdir(), "intraday.png") });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, last, hovered, early }));
} finally {
  await browser?.close();
  server.close();
}
