/** Real-browser check of the 分时 / 日 K / 周 K / 月 K toolbar control and the
 * 更多周期 dropdown on the actual ChartWorkspace, with a stubbed tRPC client
 * (synthetic bars, no network). The market session is the real store.
 * Usage: node tests/browser/chart-period-switch-browser.mjs
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const shotDir = process.env.PERIOD_SWITCH_SHOT_DIR;
if (shotDir) mkdirSync(shotDir, { recursive: true });

const stub = `
import { defaultChartView } from '~/lib/chart/chart-view';
const bars = Array.from({ length: 120 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
  open: 100 + i / 10, close: 101 + i / 10, high: 103 + i / 10,
  low: 98 + i / 10, volume: 1000, amount: 100000,
}));
export const snapshot = { id: 'fixture', symbol: 'sh600000', bars, period: 'day',
  adjustment: 'none', source: 'fixture', hash: 'fixture', createdAt: 0,
  historyExhausted: true };
const view = { ...defaultChartView, mainIndicators: ['ma'], subchart: ['volume'] };
const fixed = { chartView: view, chartBars: snapshot, chartPosition: null,
  rpsCurve: null, securityNames: {} };
const result = (data) => ({ data, isLoading: false, isFetching: false,
  isPending: false, error: null, refetch() {}, dataUpdatedAt: 1 });
const query = (name) => ({ useQuery: () => result(fixed[name]) });
export const api = new Proxy({
  useUtils: () => ({ chartView: { setData() {} },
    chartSharedDrawings: { invalidate() { return Promise.resolve(); } } }),
  saveChartView: { useMutation: () => ({ mutate() {}, error: null }) },
  useQueries: () => [],
}, { get: (target, name) => (name in target ? target[name] : query(name)) });`;

const bundle = await build({
  stdin: {
    contents: `import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChartWorkspace } from './src/components/market/chart-workspace';
import { ChartPeriodControl } from './src/components/workbench/market-view';
import { SecuritySelect } from './src/components/market/security-select';
import { useMarketSession } from '~/lib/stores/market-session';
import { snapshot } from '~/trpc/react';
useMarketSession.setState({ symbol: 'sh600000', marketSource: 'local',
  adjustment: 'forward', chartPeriod: 'day', chartMode: 'k' });
const periods = ['day', 'week', 'month', '5m', '15m', '30m', '60m'];
function App() {
  const chartPeriod = useMarketSession((s) => s.chartPeriod);
  const chartMode = useMarketSession((s) => s.chartMode);
  const symbol = useMarketSession((s) => s.symbol);
  const marketSource = useMarketSession((s) => s.marketSource);
  const adjustment = useMarketSession((s) => s.adjustment);
  const setChartPeriod = useMarketSession((s) => s.setChartPeriod);
  const setChartMode = useMarketSession((s) => s.setChartMode);
  const [canIntraday, setCanIntraday] = useState(true);
  window.setCanIntraday = setCanIntraday;
  const intraday = canIntraday && chartMode === 'intraday';
  const selectChart = (next) => {
    if (next === 'intraday') { setChartMode('intraday'); return; }
    setChartMode('k'); setChartPeriod(next);
  };
  return <div className="app-shell"><main className="main"><div className="page">
    <ChartPeriodControl period={chartPeriod} intraday={intraday}
      canIntraday={canIntraday} disabled={false} periods={periods}
      onSelect={selectChart} />
    <SecuritySelect symbol="sh600000" name="浦发银行" period="day"
      disabled={false} onSelect={() => {}} onPeriod={selectChart} />
    <output data-testid="session" style={{ display: 'block', fontSize: 12,
      overflowWrap: 'anywhere' }}>{JSON.stringify({ symbol, marketSource,
      adjustment, chartPeriod, chartMode })}</output>
    <div className="min-w-0"><ChartWorkspace snapshot={snapshot} period={chartPeriod}
      adjustment={adjustment} chartMode={chartMode}
      onChartModeChange={setChartMode} /></div>
  </div></main></div>;
}
createRoot(document.getElementById('root')).render(<App />);`,
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
      name: "controlled-transport",
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
        b.onResolve({ filter: /^next\/navigation$/ }, () => ({
          path: "navigation",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /^next\/link$/ }, () => ({
          path: "link",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /^navigation$/, namespace: "fixture" }, () => ({
          contents:
            "export const useRouter = () => ({ push() {}, replace() {} });",
          loader: "js",
          resolveDir: process.cwd(),
        }));
        b.onLoad({ filter: /^link$/, namespace: "fixture" }, () => ({
          contents: `import React from 'react';
export default function Link({ href, children, ...props }) {
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
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1300, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addStyleTag({ content: css.css });
  const group = page.getByRole("group", { name: "常用图表周期" });
  const period = page.getByRole("combobox", { name: "行情周期", exact: true });
  const chart = page.getByTestId("market-chart").first();
  await chart.waitFor();
  const session = async () =>
    JSON.parse(await page.getByTestId("session").innerText());
  const initial = await session();
  assert.deepEqual(
    [initial.symbol, initial.marketSource, initial.adjustment],
    ["sh600000", "local", "forward"],
  );
  assert.equal(initial.chartMode, "k");
  assert.equal(initial.chartPeriod, "day");
  assert.match(await period.innerText(), /更多 ·/);
  assert.match(await period.innerText(), /日 K/);

  // 更多周期 is a visible entry, and the dropdown is driven with the keyboard.
  const chooseMore = async (index) => {
    await page.evaluate(() => document.activeElement?.blur());
    await period.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("option").first().waitFor({ state: "attached" });
    await page.waitForTimeout(100);
    await page.keyboard.press("Home");
    await page.waitForTimeout(50);
    for (let step = 0; step < index; step++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(50);
    }
    await page.keyboard.press("Enter");
    await page.getByRole("option").first().waitFor({ state: "detached" });
  };

  // 分时 is a mode, not a period value.
  await group.getByRole("button", { name: "分时", exact: true }).click();
  await page.getByTestId("intraday-chart").waitFor();
  assert.match(await period.innerText(), /更多 ·/);
  assert.match(await period.innerText(), /分时/);
  let state = await session();
  assert.equal(state.chartMode, "intraday");
  assert.equal(state.chartPeriod, "day");
  assert.deepEqual(
    [state.symbol, state.marketSource, state.adjustment],
    ["sh600000", "local", "forward"],
    "分时 must not change symbol, source or adjustment",
  );
  assert.equal(await page.getByTestId("market-chart").count(), 0);

  // Direct 周 K leaves 分时 and returns a weekly K chart for the same security.
  await group.getByRole("button", { name: "周 K", exact: true }).click();
  await page.getByTestId("market-chart").first().waitFor();
  assert.equal(
    await page.getByTestId("market-chart").first().getAttribute("data-period"),
    "week",
  );
  assert.equal(await page.getByTestId("intraday-chart").count(), 0);
  assert.match(await period.innerText(), /更多 ·/);
  assert.match(await period.innerText(), /周线/);
  state = await session();
  assert.equal(state.chartMode, "k");
  assert.equal(state.chartPeriod, "week");
  assert.deepEqual(
    [state.symbol, state.marketSource, state.adjustment],
    ["sh600000", "local", "forward"],
    "周 K must keep the same symbol, source and adjustment",
  );

  // A non-quick minute period picked from 更多周期 is shown by the entry.
  await chooseMore(3); // day, week, month, 5m
  await page.getByTestId("market-chart").first().waitFor();
  assert.equal(
    await page.getByTestId("market-chart").first().getAttribute("data-period"),
    "5m",
  );
  assert.match(await period.innerText(), /更多 ·/);
  assert.match(await period.innerText(), /5 分钟/);
  state = await session();
  assert.equal(state.chartMode, "k");
  assert.equal(state.chartPeriod, "5m");

  // 分时 keeps 5m hidden; choosing the same 5m from 更多周期 must still fire
  // onValueChange and return to the K chart at that period.
  await group.getByRole("button", { name: "分时", exact: true }).click();
  await page.getByTestId("intraday-chart").waitFor();
  state = await session();
  assert.equal(state.chartMode, "intraday");
  assert.equal(state.chartPeriod, "5m");
  await chooseMore(3); // the same 5 分钟 item
  await page.getByTestId("market-chart").first().waitFor();
  assert.equal(
    await page.getByTestId("market-chart").first().getAttribute("data-period"),
    "5m",
  );
  assert.equal(await page.getByTestId("intraday-chart").count(), 0);
  assert.match(await period.innerText(), /更多 ·/);
  assert.match(await period.innerText(), /5 分钟/);
  state = await session();
  assert.equal(state.chartMode, "k");
  assert.equal(state.chartPeriod, "5m");
  assert.deepEqual(
    [state.symbol, state.marketSource, state.adjustment],
    ["sh600000", "local", "forward"],
    "returning from 分时 must keep the same symbol, source and adjustment",
  );

  // F5 in the workspace drives the same session mode the toolbar shows.
  // The combobox keeps focus after choosing an option, where page keys pause.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("F5");
  await page.getByTestId("intraday-chart").waitFor();
  state = await session();
  assert.equal(state.chartMode, "intraday");
  assert.equal(state.chartPeriod, "5m");
  assert.match(await period.innerText(), /分时/);
  await page.keyboard.press("F5");
  await page.getByTestId("market-chart").first().waitFor();
  state = await session();
  assert.equal(state.chartMode, "k");
  assert.equal(state.chartPeriod, "5m");
  assert.match(await period.innerText(), /5 分钟/);

  // The TDX sprite period code (M5) is the same K-period entry: it must leave
  // 分时 and show the actual period.
  await group.getByRole("button", { name: "分时", exact: true }).click();
  await page.getByTestId("intraday-chart").waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("m");
  await page.waitForTimeout(150);
  await page.keyboard.press("5");
  await page
    .getByRole("option", { name: /切换到5 分钟/ })
    .waitFor({ state: "attached" });
  await page.keyboard.press("Enter");
  await page.getByTestId("market-chart").first().waitFor();
  assert.equal(
    await page.getByTestId("market-chart").first().getAttribute("data-period"),
    "5m",
  );
  state = await session();
  assert.equal(state.chartMode, "k");
  assert.equal(state.chartPeriod, "5m");
  assert.match(await period.innerText(), /5 分钟/);

  // Frozen / non-tradable availability hides 分时 but keeps K periods.
  await page.evaluate(() => window.setCanIntraday(false));
  assert.equal(
    await group.getByRole("button", { name: "分时", exact: true }).count(),
    0,
  );
  assert.equal(
    await group.getByRole("button", { name: "月 K", exact: true }).count(),
    1,
  );
  await page.evaluate(() => window.setCanIntraday(true));

  // The four direct choices wrap instead of overflowing a narrow window.
  await page.setViewportSize({ width: 640, height: 900 });
  await page.waitForTimeout(100);
  assert.equal(
    await group.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
    true,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  if (shotDir)
    await page.screenshot({
      path: join(shotDir, "chart-period-switch-640.png"),
      fullPage: true,
    });
  assert.deepEqual(errors, []);
  console.log(
    "PASS 更多周期 entry, 分时→same 5m round trip, M5 sprite code, frozen hiding and narrow wrapping",
  );
} finally {
  await browser?.close();
  server.close();
}
