/** Real-browser check of the chart compare popover's TDX sector list.
 * Uses the actual ChartWorkspace with a stubbed tRPC client (no network).
 * Usage: node tests/browser/chart-compare-sectors-browser.mjs
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const stub = `
import { defaultChartView } from '~/lib/chart/chart-view';
const make = (base) => Array.from({ length: 80 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
  open: base + i / 10, close: base + 1 + i / 10, high: base + 3 + i / 10, low: base - 2 + i / 10, volume: 100, amount: 10000 }));
const bars = make(100);
export const snapshot = { id: 'fixture', symbol: 'sh600196', bars, period: 'day', adjustment: 'none', source: 'fixture', hash: 'fixture', createdAt: 0, historyExhausted: true };
export const snapshot2 = { ...snapshot, id: 'fixture-2', symbol: 'sz000001', hash: 'fixture-2' };
const other = make(10).map((b, i) => ({ ...b, close: 10 + i / 5 }));
const view = { ...defaultChartView, mainIndicators: [], subchart: ['volume'] };
const fixed = { chartView: view, chartBars: snapshot };
const result = (data) => ({ data, isLoading: false, isFetching: false, error: null, refetch() {}, dataUpdatedAt: 1 });
const sectors = (symbol) => symbol === 'sz000001'
  ? { symbol, status: 'ready', observedAt: 1763500000000,
      industry: [{ category: 'industry', code: '881155', name: '银行', selectionName: '通达信·881155·银行', sourceDate: null }],
      concept: [] }
  : { symbol, status: 'ready', observedAt: 1763500000000,
      industry: [
        { category: 'industry', code: '881232', name: '化学制剂', selectionName: '通达信·881232·化学制剂', sourceDate: null },
        { category: 'industry', code: '881231', name: '化学制药', selectionName: '通达信·881231·化学制药', sourceDate: null },
      ],
      concept: [
        { category: 'concept', code: '880652', name: '创新药', selectionName: '通达信·880652·创新药', sourceDate: '2026-08-21' },
        { category: 'concept', code: '880933', name: '智能医疗', selectionName: '通达信·880933·智能医疗', sourceDate: '2026-10-28' },
        { category: 'concept', code: '880729', name: 'CXO概念', selectionName: '通达信·880729·CXO概念', sourceDate: '2026-10-16' },
        { category: 'concept', code: '880747', name: 'AI医疗概念', selectionName: '通达信·880747·AI医疗概念', sourceDate: '2026-11-11' },
        { category: 'concept', code: '880904', name: '机器人概念', selectionName: '通达信·880904·机器人概念', sourceDate: '2026-11-16' },
        { category: 'concept', code: '880978', name: 'DeepSeek概念', selectionName: '通达信·880978·DeepSeek概念', sourceDate: '2026-10-30' },
      ] };
globalThis.__sectorCalls = [];
const query = (name) => ({ useQuery: (input, options) => {
  if (name === 'chartBars')
    return result(input?.snapshotId === snapshot2.id ? snapshot2 : snapshot);
  if (name === 'marketPoolAssociations') {
    if (options?.enabled && !globalThis.__sectorCalls.includes(input.symbol)) globalThis.__sectorCalls.push(input.symbol);
    return result(sectors(input.symbol));
  }
  return result(fixed[name]);
} });
export const api = new Proxy({
  useUtils: () => ({ chartView: { setData() {} } }),
  saveChartView: { useMutation: () => ({ mutate() {}, error: null }) },
  useQueries: (build) => build({ compareBars: (input) => input }).map(() => result({ bars: other })),
}, { get: (target, name) => (name in target ? target[name] : query(name)) });`;
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
import { ChartWorkspace } from './src/components/market/chart-workspace'; import { snapshot, snapshot2 } from '~/trpc/react';
const host = document.getElementById('root');
let root = createRoot(host);
root.render(<ChartWorkspace snapshot={snapshot} period="day" adjustment="none" />);
// A stock switch replaces the workspace instance, as the market route does.
globalThis.__renderOther = () => {
  root.unmount();
  root = createRoot(host);
  root.render(<ChartWorkspace snapshot={snapshot2} period="day" adjustment="none" />);
};`,
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
    {
      // PoolMembersLink renders next/link; keep the lightweight page free of
      // the Next client runtime while preserving the real href.
      name: "stub-next-link",
      setup(b) {
        b.onResolve({ filter: /^next\/link$/ }, () => ({
          path: resolve("stub-next-link.tsx"),
          namespace: "stub-next-link",
        }));
        b.onLoad({ filter: /.*/, namespace: "stub-next-link" }, () => ({
          contents: `export default function Link({ href, children, ...props }) {
            return <a href={href} {...props}>{children}</a>;
          }`,
          loader: "tsx",
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});
const css = await postcss([tailwind()]).process(
  readFileSync("src/styles/globals.css", "utf8"),
  { from: resolve("src/styles/globals.css") },
);
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
  await page.addStyleTag({ content: css.css });
  const plot = page.getByRole("application");
  await plot.waitFor();
  await page.waitForTimeout(300);
  const calls = () => page.evaluate(() => globalThis.__sectorCalls.slice());
  const compare = page.getByRole("button", { name: /^叠加对比（/ });
  // Closed popover: the association component is not mounted, so no read.
  assert.deepEqual(await calls(), []);
  await compare.click();
  await page.getByText("化学制剂").waitFor();
  assert.deepEqual(await calls(), ["sh600196"]);
  // Current-snapshot source and reliable code are shown, grouped by category.
  const sectors = page.getByRole("region", { name: "所属板块" });
  assert.match(await sectors.innerText(), /当前成分快照/);
  assert.match(await sectors.innerText(), /880652/);
  assert.match(await sectors.innerText(), /更新 2026-08-21/);
  assert.match(await sectors.innerText(), /881232/);
  assert.equal(await sectors.getByRole("link", { name: "成分" }).count(), 6);
  // The 成分 entry reuses the existing pool-members destination.
  assert.equal(
    await sectors
      .getByRole("link", { name: "成分" })
      .first()
      .getAttribute("href"),
    `/scan?tab=pool&poolCategory=industry&poolName=${encodeURIComponent(
      "通达信·881232·化学制剂",
    )}`,
  );
  // The concept group previews four rows and expands without a new read.
  assert.equal(await page.getByText("机器人概念").count(), 0);
  await page.getByRole("button", { name: "展开其余 2 项" }).click();
  await page.getByText("机器人概念").waitFor();
  assert.deepEqual(await calls(), ["sh600196"]);
  // Add one board: the chip uses the board name and the slot counter advances.
  await page
    .getByRole("listitem")
    .filter({ hasText: "化学制剂" })
    .getByRole("button", { name: "加入对比 化学制剂" })
    .click();
  await page.getByRole("button", { name: "化学制剂 ×" }).waitFor();
  await page.getByRole("button", { name: /叠加对比（1\/3）/ }).waitFor();
  await page.getByRole("button", { name: "已加入 化学制剂" }).waitFor();
  // Duplicates stay out: the added row is disabled and the count is unchanged.
  assert.equal(
    await page.getByRole("button", { name: /叠加对比（1\/3）/ }).count(),
    1,
  );
  for (const name of ["创新药", "智能医疗"])
    await page
      .getByRole("listitem")
      .filter({ hasText: name })
      .getByRole("button", { name: `加入对比 ${name}` })
      .click();
  await page.getByRole("button", { name: /叠加对比（3\/3）/ }).waitFor();
  await page.getByText("已满 3 个叠加品种，请先移除一个再添加。").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "加入对比 CXO概念" }).isDisabled(),
    true,
  );
  // Removing a chip frees the slot and the explicit full notice disappears.
  await page.getByRole("button", { name: "化学制剂 ×" }).click();
  await page.getByRole("button", { name: /叠加对比（2\/3）/ }).waitFor();
  assert.equal(
    await page.getByText("已满 3 个叠加品种，请先移除一个再添加。").count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "加入对比 CXO概念" }).isDisabled(),
    false,
  );
  // A different stock remounts the section and never reuses the old membership.
  await page.evaluate(() => globalThis.__renderOther());
  await page.getByRole("button", { name: /^叠加对比（/ }).click();
  await page.getByText("银行", { exact: true }).waitFor();
  assert.equal(await page.getByText("化学制剂").count(), 0);
  assert.deepEqual(await calls(), ["sh600196", "sz000001"]);
  if (process.env.CHART_SHOT_DIR)
    await page.screenshot({
      path: join(process.env.CHART_SHOT_DIR, "chart-compare-sectors.png"),
    });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, calls: await calls() }));
} finally {
  await browser?.close();
  server.close();
}
