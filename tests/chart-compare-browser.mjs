/** Real-browser check of symbol comparison (TDX 叠加) on the actual
 * ChartWorkspace with a stubbed tRPC client (synthetic bars, no network).
 * Usage: node tests/chart-compare-browser.mjs
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const stub = `
import { defaultChartView } from '~/lib/chart/chart-view';
const make = (base) => Array.from({ length: 80 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
  open: base + i / 10, close: base + 1 + i / 10, high: base + 3 + i / 10, low: base - 2 + i / 10, volume: 100, amount: 10000 }));
const bars = make(100);
// The compared symbol trades at a tenth of the price and skips day 10.
const other = make(10).filter((_, i) => i !== 10).map((b, i) => ({ ...b, close: 10 + i / 5 }));
export const snapshot = { id: 'fixture', symbol: 'sh600000', bars, period: 'day', adjustment: 'none', source: 'fixture', hash: 'fixture', createdAt: 0, historyExhausted: true };
const view = { ...defaultChartView, mainIndicators: [], subchart: ['volume'] };
const fixed = { chartView: view, chartBars: snapshot, securityNames: { sz000001: '平安银行' },
  securities: [{ symbol: 'sz000001', name: '平安银行' }] };
const result = (data) => ({ data, isLoading: false, isFetching: false, error: null, refetch() {}, dataUpdatedAt: 1 });
const query = (name) => ({ useQuery: () => result(fixed[name]) });
export const api = new Proxy({
  useUtils: () => ({ chartView: { setData() {} } }),
  saveChartView: { useMutation: () => ({ mutate() {}, error: null }) },
  useQueries: (build) => build({ compareBars: (input) => input }).map(() => result({ bars: other })),
}, { get: (target, name) => (name in target ? target[name] : query(name)) });`;
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
import { ChartWorkspace } from './src/components/market/chart-workspace'; import { snapshot } from '~/trpc/react';
createRoot(document.getElementById('root')).render(<ChartWorkspace snapshot={snapshot} period="day" adjustment="none" />);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  alias: { "~": "./src" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "stub-trpc",
      setup(b) {
        b.onResolve({ filter: /^~\/trpc\/react$/ }, () => ({
          path: resolve("stub-trpc.ts"),
          namespace: "stub",
        }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: stub,
          loader: "ts",
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/bundle.js" ? "text/javascript" : "text/html; charset=utf-8",
  );
  res.end(
    req.url === "/bundle.js"
      ? bundle.outputFiles[0].text
      : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>',
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1300, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const plot = page.getByRole("application");
  await plot.waitFor();
  await page.waitForTimeout(300);
  // Status lines above the plot may appear (no app CSS in this page), so
  // chart-relative points are resolved against the plot's current position.
  // Pick a comparison symbol from the compare picker (not the page sprite).
  await page.getByLabel("叠加对比品种").click();
  await page.getByRole("option", { name: /平安银行/ }).click();
  await page.waitForTimeout(300);
  const chip = page.getByRole("button", { name: "平安银行 ×" });
  await chip.waitFor();
  const box = await plot.boundingBox();
  await page.mouse.move(box.x + 400, box.y + 150);
  await page.waitForTimeout(100);
  const legend = await page.locator('[data-testid="chart-legend"]').innerText();
  assert.match(legend, /平安银行 \d+\.\d{2}/, legend);
  // The price axis switches to percent from the first visible bar.
  await page.screenshot({ path: join(tmpdir(), "chart-compare.png") });
  const axis = await page.evaluate(
    () => [...document.querySelectorAll("div.tv-lightweight-charts td")].length,
  );
  assert.ok(axis > 0);
  await chip.click();
  await page.getByLabel("叠加对比品种").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "平安银行 ×" }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, legend }));
} finally {
  await browser?.close();
  server.close();
}
