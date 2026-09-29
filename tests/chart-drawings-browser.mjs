/** Real-browser check of drawing tools on the actual ChartWorkspace with a
 * stubbed tRPC client (synthetic bars, no network or database).
 * Usage: node tests/chart-drawings-browser.mjs
 * Covers: 3-click parallel channel, text label, on-chart select, handle drag,
 * body drag without panning the chart, Delete, and debounced view saving.
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
const bars = Array.from({ length: 80 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
  open: 100 + i / 10, close: 101 + i / 10, high: 103 + i / 10, low: 98 + i / 10, volume: 100, amount: 10000 }));
export const snapshot = { id: 'fixture', symbol: 'sh600000', bars, period: 'day', adjustment: 'none', source: 'fixture', hash: 'fixture', createdAt: 0, historyExhausted: true };
const view = { ...defaultChartView, mainIndicators: [], subchart: ['volume'] };
const fixed = { chartView: view, chartBars: snapshot };
const query = (name) => ({ useQuery: () => ({ data: fixed[name], isLoading: false, isFetching: false, error: null, refetch() {} }) });
export const api = new Proxy({
  useUtils: () => ({ chartView: { setData() {} } }),
  saveChartView: { useMutation: (options) => ({ mutate: (input) => { window.savedView = input.view; options?.onSuccess?.(input.view); }, error: null }) },
  useQueries: () => [],
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
  const at = async (x, y) => {
    const box = await plot.boundingBox();
    return [box.x + x, box.y + y];
  };
  // The date under a fixed pixel changes if the chart pans.
  const dateAt = async (x, y) => {
    await page.mouse.move(...(await at(x, y)));
    await page.waitForTimeout(50);
    return (
      await page.locator('[data-testid="chart-legend"]').innerText()
    ).slice(0, 10);
  };
  const saved = async () => {
    await page.waitForTimeout(1000); // view auto-save debounce is 800 ms
    return page.evaluate(() => window.savedView?.drawings ?? []);
  };
  const tool = async (name) => {
    const summary = page.locator("summary", { hasText: "画线：" });
    if (
      !(await page
        .locator('details[name="chart-tools"]')
        .evaluate((d) => d.open))
    )
      await summary.click();
    await page
      .getByRole("toolbar", { name: "画线工具" })
      .getByRole("button", { name, exact: true })
      .click();
    await summary.click(); // close the popover so it does not cover the plot
  };
  const click = async (x, y) => {
    await page.mouse.move(...(await at(x, y)));
    await page.mouse.click(...(await at(x, y)));
  };
  const drag = async ([x1, y1], [x2, y2]) => {
    await page.mouse.move(...(await at(x1, y1)));
    await page.mouse.down();
    await page.mouse.move(...(await at(x2, y2)), { steps: 5 });
    await page.mouse.up();
  };

  // 1) Parallel channel: two clicks for the base line, a third for the width.
  await tool("平行通道");
  await click(200, 200);
  await click(500, 150);
  await click(350, 100);
  let drawings = await saved();
  assert.equal(drawings.length, 1);
  assert.equal(drawings[0].kind, "channel");
  assert.ok(drawings[0].c, "channel stores its third point");
  const channel = drawings[0];

  // 2) Text label with the typed content.
  await page.locator("summary", { hasText: "画线：" }).click();
  await page
    .getByRole("toolbar", { name: "画线工具" })
    .getByRole("button", { name: "文字", exact: true })
    .click();
  await page.getByLabel("标注文字").fill("突破位");
  await page.locator("summary", { hasText: "画线：" }).click();
  await click(700, 250);
  drawings = await saved();
  assert.equal(drawings.length, 2);
  assert.equal(drawings[1].text, "突破位");

  // 3) Browsing: drag the channel's first handle; the chart must not pan.
  const dateBefore = await dateAt(900, 300);
  await drag([200, 200], [230, 260]);
  drawings = await saved();
  const reshaped = drawings.find((d) => d.id === channel.id);
  assert.notDeepEqual(reshaped.a, channel.a, "handle drag moves point a");
  assert.deepEqual(reshaped.b, channel.b, "handle drag leaves point b");
  assert.ok(
    reshaped.a.price < channel.a.price,
    "dragged down lowers the price",
  );

  // 4) Body drag moves every point together.
  await drag([420, 170], [420, 230]);
  drawings = await saved();
  const moved = drawings.find((d) => d.id === channel.id);
  for (const key of ["a", "b", "c"])
    assert.ok(moved[key].price < reshaped[key].price, `body drag moves ${key}`);
  assert.equal(
    await dateAt(900, 300),
    dateBefore,
    "dragging a drawing does not pan the chart",
  );
  await page.screenshot({ path: join(tmpdir(), "chart-drawings.png") });

  // 5) The drawing stays selected after the drag; Delete removes it.
  await page.keyboard.press("Delete");
  drawings = await saved();
  assert.deepEqual(
    drawings.map((d) => d.kind),
    ["text"],
  );

  // 6) Clicking empty space deselects; Delete then does nothing.
  await click(1000, 60);
  await page.keyboard.press("Delete");
  assert.equal((await saved()).length, 1);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ ok: true, channel: moved.kind, text: drawings[0]?.text }),
  );
} finally {
  await browser?.close();
  server.close();
}
