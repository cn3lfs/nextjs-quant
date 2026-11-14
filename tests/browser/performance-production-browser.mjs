/** Built Next app + real RPC + isolated SQLite; all market bars are synthetic. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { chromium } from "@playwright/test";

const directory = mkdtempSync(join(tmpdir(), "quant-evaluation-production-"));
const env = {
  ...process.env,
  QUANT_DATA_DIR: directory,
  HOSTNAME: "127.0.0.1",
};
const seed = `
import {put,sqlite} from './src/server/db/index.ts';
import {replayFiveMinute,maBaselineInputSchema} from 'quant-backtest';
const bars=[],calendar=[];
for(let i=0;i<390;i++){const date=new Date(Date.UTC(2024,8,30+i));if([0,6].includes(date.getUTCDay()))continue;const day=date.toISOString().slice(0,10);calendar.push(day);for(let j=0;j<48;j++){const m=j<24?575+j*5:785+(j-24)*5;const p=10+Math.sin((i*48+j)/41)*.8+i*.001;bars.push({date:day+'T'+String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0')+':00+08:00',open:p,high:p+.05,low:p-.05,close:p,volume:10000,amount:100000});}}
const input=maBaselineInputSchema.parse({symbol:'sh600000',start:calendar[1],end:calendar.at(-1),initial:100000});
const result=replayFiveMinute(input,bars);
const archive={result,manifest:{version:'ma-baseline-input-1',symbol:input.symbol,period:'5m',adjustment:'none',sourceFileHash:'synthetic-fixture',dataHash:'synthetic-fixture',calendarHash:'synthetic-fixture',actionHash:null,start:input.start+'T09:35:00+08:00',end:input.end+'T15:00:00+08:00',warmupBars:20,sourceMs:0,computeMs:0},inputSnapshot:{bars,calendar:calendar.slice(1),actions:{version:'backtest-actions-1',status:'partial',symbol:input.symbol,start:input.start,end:input.end,events:[],warnings:['Synthetic browser fixture, not actual market data']}}};
put('job','evaluation-production-fixture',{id:'evaluation-production-fixture',type:'backtest',status:'completed',progress:100,createdAt:Date.now(),updatedAt:Date.now(),input:{type:'ma-baseline',input},result:archive});sqlite().close();`;
execFileSync(
  process.execPath,
  ["--import", "tsx", "--input-type=module", "-e", seed],
  { cwd: process.cwd(), env, windowsHide: true, stdio: "pipe" },
);
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const server = spawn(
  process.env.QUANT_EVALUATION_NODE ?? process.execPath,
  [
    resolve(
      process.env.QUANT_EVALUATION_SERVER ?? ".next/standalone/server.js",
    ),
  ],
  {
    env: { ...env, PORT: String(port) },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
server.stdout.on("data", (chunk) => (logs += chunk));
server.stderr.on("data", (chunk) => (logs += chunk));
let browser;
try {
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(ready, true, logs);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${url}/backtest`);
  await page
    .getByRole("button", {
      name: "恢复实验 evaluation-production-fixture",
      exact: true,
    })
    .click();
  await page.getByRole("tab", { name: "绩效评价", exact: true }).click();
  await page.getByLabel("绩效评价内容").waitFor();
  await page.getByLabel("全程交易轮次评价").waitFor();
  await page.getByRole("button", { name: "季度", exact: true }).click();
  await page.getByRole("button", { name: "查看 2025-Q1", exact: true }).click();
  await page.getByLabel("选中期间详情").waitFor();
  assert.match(await page.getByLabel("选中期间详情").textContent(), /2025-Q1/);
  await page
    .getByLabel("月度收益热力图")
    .getByRole("button", { name: /^2025-02 / })
    .click();
  await page.getByLabel("选中期间详情").waitFor();
  assert.match(await page.getByLabel("选中期间详情").textContent(), /2025-02/);
  await page.screenshot({
    path: join(tmpdir(), "quant-performance-production.png"),
    fullPage: true,
  });
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出完整实验", exact: true }).click();
  const download = await downloading;
  const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
  assert.equal(exported.evaluation.version, "performance-report-v2");
  assert.equal(exported.evaluation.trades.version, "trade-performance-v1");
  assert.equal(
    exported.evaluation.trades.closedTrades,
    exported.result.fills.filter((f) => f.side === "sell").length,
  );
  const winCard = await page
    .getByLabel("全程交易轮次评价")
    .getByText("交易胜率", { exact: true })
    .locator("..")
    .textContent();
  assert.ok(
    winCard.includes(
      (exported.evaluation.trades.winRate.value * 100).toFixed(2) + "%",
    ),
  );
  assert.equal(exported.evaluation.basis.dataHash, "synthetic-fixture");
  assert.equal(
    exported.evaluation.overview.days,
    exported.result.equity.length,
  );
  assert.ok(exported.evaluation.quarter.length > 4);
  assert.ok(exported.evaluation.month.length > 12);
  assert.equal(exported.evaluation.daily.length, exported.result.equity.length);
  assert.deepEqual(errors, []);
  console.log(
    "Production evaluation: built Next app, isolated real RPC/SQLite, tab, quarter/month drill-down, and JSON export passed. Synthetic data only; screenshot TEMP/quant-performance-production.png.",
  );
} finally {
  await browser?.close();
  const stopped = once(server, "exit");
  server.kill();
  await stopped;
  const target = resolve(directory);
  assert.ok(
    target.startsWith(resolve(tmpdir()) + sep) &&
      target.split(sep).at(-1).startsWith("quant-evaluation-production-"),
  );
  rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
