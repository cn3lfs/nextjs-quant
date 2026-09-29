/** Real-browser check of the TDX keys on the actual MarketChart component.
 * Synthetic bars only. Usage: node tests/chart-keys-browser.mjs
 * Keys are pressed with page focus on <body> (not the chart), as a TDX user
 * would; asserts the legend follows the bar cursor and the viewport moves.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
);
const { chromium } = require("playwright");
const n = 600;
const result = await build({
  stdin: {
    contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MarketChart } from './src/components/market/chart';
const bars = Array.from({length: ${n}}, (_, i) => {
  const base = 30 + Math.sin(i / 37) * 6;
  return { date: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10),
    open: base, close: base + 0.3, high: base + 0.8, low: base - 0.8, volume: 1000 + i, amount: 3000 };
});
window.__bars = bars;
createRoot(document.getElementById('root')).render(<div style={{height: 700}}><MarketChart bars={bars} period="day" hotkeys /></div>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  alias: { "~": "./src" },
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
    viewport: { width: 1400, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector("div.tv-lightweight-charts canvas");
  await page.waitForTimeout(300);
  const legend = () => page.locator('[data-testid="chart-legend"]').innerText();
  const range = () =>
    page.evaluate(() => {
      const t = document.querySelector('[data-testid="chart-history"]');
      return t?.textContent ?? "";
    });
  const date = (i) => page.evaluate((i) => window.__bars[i].date, i);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  // First ← puts the cursor on the last visible bar; each further ← steps one bar.
  await page.keyboard.press("ArrowLeft");
  const first = await legend();
  assert.ok(first.startsWith(await date(n - 1)), first);
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
  assert.ok((await legend()).startsWith(await date(n - 5)), await legend());
  await page.keyboard.press("ArrowRight");
  assert.ok((await legend()).startsWith(await date(n - 4)), await legend());
  await page.keyboard.press("Escape");
  // Paging far left reaches the early bars and triggers history reveal.
  const before = await range();
  for (let i = 0; i < 6; i++) await page.keyboard.press("PageUp");
  await page.waitForTimeout(300);
  const after = await range();
  assert.notEqual(after, before, "paging left reveals more history");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp");
  await page.screenshot({ path: join(tmpdir(), "chart-keys.png") });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, first, before, after }));
} finally {
  await browser?.close();
  server.close();
}
