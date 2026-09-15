/** Synthetic rendering review of the actual MarketChart component. No data IO.
 * QUANT_DATA_DIR must be isolated. Assets stay in memory; screenshots overwrite
 * a fixed set under docs/review/s3b-review. Server/browser close in finally.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, readdir, readFile } from "node:fs/promises";
assert.equal(
  resolve(process.env.QUANT_DATA_DIR ?? ""),
  resolve(".test-data/s3b-review"),
);
const require = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
);
const { chromium } = require("playwright");
const result = await build({
  stdin: {
    contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarketChart } from './src/components/chart';
import { defaultChartView } from './src/lib/chart-view';
const bars = Array.from({length: 80}, (_, i) => ({date: new Date(Date.UTC(2026, 4, i+1)).toISOString().slice(0,10), open: 30+i/20, close: 30.5+i/20, high: 31+i/20, low: 29+i/20, volume: 100, amount: 3000}));
const rps = bars.map((b,i) => ({date:b.date, mode:i<45?'backfill':'forward', periods:[5,10,20,50,120,250], values:[5,10,20,50,120,250].map((_,j)=>i>=25&&i<=32?null:{rps:i===15?0:Math.min(100,45+j*6+i/4)})}));
function App(){ const [view,setView]=useState({...defaultChartView,subchart:['rps']}); const period=new URLSearchParams(location.search).get('period') || 'day'; return <main className="p-4"><h1>S3b 受控绘图样例（非市场结果）</h1><p>第16点为真值0；第26–33点缺失；前45点回填，其余向前新增。</p><MarketChart bars={bars} period={period} rps={rps} view={view} onViewChange={setView}/></main> }
createRoot(document.getElementById('root')).render(<App/>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
// Use the application's compiled Tailwind CSS, not a parallel review theme.
async function cssFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await cssFiles(p)));
    else if (e.name.endsWith(".css")) out.push(p);
  }
  return out;
}
const css = (
  await Promise.all(
    (await cssFiles(".next/static")).map((p) => readFile(p, "utf8")),
  )
).join("\n");
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/bundle.js"
      ? "text/javascript"
      : req.url === "/style.css"
        ? "text/css"
        : "text/html; charset=utf-8",
  );
  res.end(
    req.url === "/bundle.js"
      ? result.outputFiles[0].text
      : req.url === "/style.css"
        ? css
        : '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>',
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1500, height: 950 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  const dest = resolve("docs/review/s3b-review");
  await mkdir(dest, { recursive: true });
  await page.goto(url);
  const chart = page.getByTestId("market-chart");
  await chart.locator("canvas").first().waitFor();
  assert.equal(await chart.getByRole("checkbox", { checked: true }).count(), 5);
  await chart.screenshot({ path: join(dest, "01-day-rps.png") });
  await page.getByLabel("RPS参考阈值").fill("80");
  await page.getByLabel("RPS5", { exact: true }).check();
  await chart.screenshot({ path: join(dest, "02-configured-rps.png") });
  for (const period of ["week", "month", "5m"]) {
    await page.goto(`${url}/?period=${period}`);
    await page.getByText("RPS仅支持日线，当前周期不可用").waitFor();
    await chart.screenshot({
      path: join(dest, `03-${period}-unavailable.png`),
    });
  }
  assert.deepEqual(errors, []);
  console.log(
    "S3b visual review passed: default selection, threshold, window toggle, non-daily disclosure; synthetic fixtures.",
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
