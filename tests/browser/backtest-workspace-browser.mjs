/** Real workspace + TanStack Query, controlled transport; no files or database. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "@playwright/test";

const transport = `
import {useMemo} from 'react';
import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {queryPerformanceEvaluation} from './src/server/performance/backtest-evaluation';
const input={symbol:'sz000001',start:'2026-10-08',end:'2026-10-30',initial:100000,costs:{version:'cost-experiment-1',commissionBps:3,minimumCommission:5,sellTaxBps:5,slippageBps:5}};
const orders=Array.from({length:125},(_,i)=>({id:i+1,side:i%2?'sell':'buy',signalAt:'2026-10-08T10:00:00+08:00',status:i<60?'rejected':i<120?'filled':'pending',attempts:1,reason:i<60?'受控拒单：资金不足一手':i>=120?'T+1：当日买入不可卖出':null}));
const fills=Array.from({length:60},(_,i)=>({orderId:i+61,side:i%2?'sell':'buy',signalAt:'2026-10-08T10:00:00+08:00',barEnd:'2026-10-08T10:05:00+08:00',executedAt:'2026-10-08T10:00:00+08:00',price:10,shares:100,fee:5,cashAfter:99995,sharesAfter:100}));
const report={summary:{engineVersion:'ts-backtest-foundation-1',engineHash:'engine-fixture',strategyId:'ma-cross-baseline-v1',quality:'rule-check-only',input,cash:100100,shares:0,evaluated:48,totalReturn:0.1,maxDrawdown:0.25,equity:[{date:'2026-10-08',value:100100}],assumptions:['T+1，期末不强制平仓']},manifest:{version:'ma-baseline-input-1',symbol:input.symbol,period:'5m',adjustment:'none',sourceFileHash:'source-fixture',dataHash:'data-fixture',calendarHash:'calendar-fixture',actionHash:'actions-fixture',start:'2026-10-08T09:35:00+08:00',end:'2026-10-30T15:00:00+08:00',warmupBars:20,sourceMs:100,computeMs:5},fills,fillCount:60,orderCount:125,rejectedCount:60,pending:orders.slice(120)};
const jobs={old:{id:'old',symbol:input.symbol,status:'completed',progress:100,createdAt:1},failed:{id:'failed',symbol:input.symbol,status:'failed',progress:0,createdAt:2,error:'受控失败：研究窗口缺少时段'},zero:{id:'zero',symbol:'sh600519',status:'completed',progress:100,createdAt:3}};
window.backtestFixture={jobs,requests:[],mutations:[],fail:'',removeFail:false,seq:0};
const f=window.backtestFixture;
function query(name){return {useQuery(input,options){return useQuery({queryKey:[name,input],retry:false,...options,queryFn:async()=>{
f.requests.push({name,input});if(f.fail===name)throw Error('受控读取失败');
if(name==='maBaselineHistory')return Object.values(jobs).reverse().map(j=>({...j}));
if(name==='jobSummary')return jobs[input.id]?{...jobs[input.id]}:null;
if(name==='maBaselineEvaluation')return queryPerformanceEvaluation({result:{...report.summary,input:{...report.summary.input,symbol:jobs[input.id].symbol},fills:input.id==='zero'?[]:report.fills},inputSnapshot:{bars:[]}},input);
if(name==='maBaselineResult'){const r=structuredClone(report);if(input.id==='zero'){r.manifest.symbol='sh600519';r.summary.input.symbol='sh600519';r.fillCount=0;r.fills=[];return r;}r.fills=r.fills.slice(input.pageIndex*50,(input.pageIndex+1)*50);return r;}
if(name==='maBaselineOrders'){const filtered=orders.filter(o=>input.status==='all'||o.status===input.status);return {orders:filtered.slice(input.pageIndex*50,(input.pageIndex+1)*50),rowCount:filtered.length};}
}})}}}
function mutation(name){return {useMutation(options){return useMutation({...options,mutationFn:async input=>{
f.mutations.push({name,input});
if(name==='maBaseline'){const id='new-'+(++f.seq);jobs[id]={id,symbol:input.symbol,status:'queued',progress:0,createdAt:Date.now()};return {...jobs[id]};}
if(name==='cancel'){jobs[input].status='cancelled';return {ok:true};}
if(name==='maBaselineRemove'){if(f.removeFail)throw Error('受控删除失败');delete jobs[input];return {removed:true};}
}})}}}
export const api={...Object.fromEntries(['maBaselineHistory','jobSummary','maBaselineResult','maBaselineOrders','maBaselineEvaluation'].map(n=>[n,query(n)])),...Object.fromEntries(['maBaseline','cancel','maBaselineRemove'].map(n=>[n,mutation(n)])),
useUtils(){const client=useQueryClient();return useMemo(()=>({...Object.fromEntries(['maBaselineHistory','maBaselineResult','maBaselineOrders'].map(n=>[n,{invalidate:input=>client.invalidateQueries({queryKey:input?[n,input]:[n]})}])),maBaselineCoverage:{fetch:async symbol=>{if(f.fail==='coverage')throw Error('受控覆盖失败');return {symbol,start:'2026-01-01',end:'2026-10-30',bars:10000}}},maBaselineExport:{fetch:async id=>{if(f.fail==='export')throw Error('受控导出失败');return {result:report,manifest:report.manifest,inputSnapshot:{bars:[]}}}}}),[client]);}};`;
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {MaBaselinePanel} from './src/components/backtest/ma-baseline-panel';import {PanelVisibility} from './src/components/workbench/keep-alive';const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});function App(){const [visible,setVisible]=useState(true);window.setBacktestVisible=setVisible;return <QueryClientProvider client={client}><PanelVisibility visible={visible}><div hidden={!visible}><MaBaselinePanel loaded={null}/></div></PanelVisibility></QueryClientProvider>};createRoot(document.getElementById('root')).render(<App/>);`,
    loader: "tsx",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  jsx: "automatic",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  plugins: [
    {
      name: "controlled-backtest-transport",
      setup(b) {
        b.onLoad({ filter: /trpc[\\/]react\.tsx$/ }, () => ({
          contents: transport,
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
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    assert.equal(route.request().url(), "http://127.0.0.1/backtest-fixture");
    return route.fulfill({
      contentType: "text/html",
      body: '<meta charset="utf-8"><div id="root" style="padding:16px"></div>',
    });
  });
  await page.goto("http://127.0.0.1/backtest-fixture");
  await page.addStyleTag({ content: css.css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const run = page.getByRole("button", { name: "开始回测", exact: true });
  await run.waitFor();
  assert.equal(await run.isDisabled(), true);
  assert.equal(await page.getByLabel("实验报告空状态").count(), 1);
  assert.equal(await page.getByText("+0.10%", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "读取本地覆盖", exact: true }).click();
  assert.equal(
    await page.getByLabel("基线开始日期").inputValue(),
    "2026-09-30",
  );
  await page.getByRole("button", { name: "恢复实验 old", exact: true }).click();
  await page.getByLabel("实验报告", { exact: true }).waitFor();
  await page.getByText("当前配置已修改", { exact: false }).waitFor();
  await page.getByRole("button", { name: "复用此配置", exact: true }).click();
  assert.equal(
    await page.getByLabel("基线开始日期").inputValue(),
    "2026-10-08",
  );
  await page.evaluate(() => (window.backtestFixture.fail = "export"));
  await page.getByRole("button", { name: "导出完整实验", exact: true }).click();
  await page.getByText("受控导出失败", { exact: true }).waitFor();
  await page.evaluate(() => (window.backtestFixture.fail = ""));
  assert.equal(
    await page.getByText("当前配置已修改", { exact: false }).count(),
    0,
  );
  assert.equal(
    await page.evaluate(() => window.backtestFixture.mutations.length),
    0,
  );
  await page.getByLabel("基线初始资金").fill("200000");
  await page.getByText("当前配置已修改", { exact: false }).waitFor();
  await page.getByRole("tab", { name: "复现依据", exact: true }).click();
  assert.equal(
    await page.getByText("100,000.00 元", { exact: true }).count(),
    1,
  );
  await page.getByRole("tab", { name: "成交与订单", exact: true }).click();
  const fills = page.getByLabel("策略逐笔成交", { exact: true }).first();
  assert.equal(await fills.locator("tbody tr").count(), 50);
  await fills.getByRole("button", { name: /下一页/ }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="策略逐笔成交"] tbody')
      ?.textContent.includes("#111"),
  );
  assert.equal(await fills.locator("tbody tr").count(), 10);
  await page
    .getByRole("button", { name: "订单诊断 · 125", exact: true })
    .click();
  const ordersTable = page.getByLabel("策略订单诊断", { exact: true }).first();
  await ordersTable.getByText("受控拒单：资金不足一手").first().waitFor();
  await page.getByRole("combobox", { name: "订单状态", exact: true }).click();
  await page.getByRole("option", { name: "已拒绝", exact: true }).click();
  await page.waitForFunction(() =>
    window.backtestFixture.requests.some(
      (r) => r.name === "maBaselineOrders" && r.input.status === "rejected",
    ),
  );
  await ordersTable.getByRole("button", { name: /下一页/ }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="策略订单诊断"] tbody')
      ?.textContent.includes("#51"),
  );
  assert.equal(await ordersTable.locator("tbody tr").count(), 10);
  await page.getByRole("button", { name: "删除实验", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.equal(
    await page.evaluate(() => window.backtestFixture.mutations.length),
    0,
  );
  await page.getByRole("button", { name: "保留实验", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "删除实验", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.evaluate(() => (window.backtestFixture.removeFail = true));
  await page.getByRole("button", { name: "删除实验", exact: true }).click();
  await page.getByRole("button", { name: "确认删除实验", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByText("受控删除失败", { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("实验报告", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "保留实验", exact: true }).click();
  await page
    .getByRole("button", { name: "恢复实验 failed", exact: true })
    .click();
  await page.getByText("受控失败：研究窗口缺少时段", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("实验报告", { exact: true }).count(), 0);
  await page
    .getByRole("button", { name: "恢复实验 zero", exact: true })
    .click();
  await page.getByText("本次实验没有成交", { exact: true }).waitFor();
  await page.getByRole("button", { name: "复用此配置", exact: true }).click();
  await page.getByRole("tab", { name: "概览", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page
    .locator('[role="tab"][data-state="active"]')
    .filter({ hasText: "绩效评价" })
    .waitFor();
  await page.getByLabel("绩效评价内容").waitFor();
  await page.keyboard.press("ArrowRight");
  await page
    .locator('[role="tab"][data-state="active"]')
    .filter({ hasText: "成交与订单" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("tab", { name: "成交与订单", exact: true })
      .getAttribute("data-state"),
    "active",
  );
  await page.getByLabel("策略模式", { exact: true }).click();
  await page
    .getByRole("option", { name: "模块化因子组合", exact: true })
    .click();
  await page.getByRole("button", { name: "放量通道突破", exact: true }).click();
  const editor = page.getByLabel("模块化技术因子策略", { exact: true });
  await editor
    .getByRole("button", { name: "添加条件", exact: true })
    .first()
    .click();
  await page.getByLabel("entry3左侧因子", { exact: true }).click();
  await page
    .getByRole("option", { name: "动量 · Qlib MA", exact: true })
    .click();
  await page.getByLabel("entry3左侧period", { exact: true }).fill("0");
  assert.equal(await run.isDisabled(), true);
  await page.getByLabel("entry3左侧period", { exact: true }).fill("60");
  assert.equal(await run.isDisabled(), false);
  await editor
    .getByRole("link", { name: "Microsoft Qlib Alpha158 · MA", exact: true })
    .waitFor();
  for (const width of [400, 320]) {
    await page.setViewportSize({ width, height: 860 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "No page-level overflow at " + width,
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await run.click();
  await page.getByRole("button", { name: "取消任务", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "恢复实验 old", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "取消任务", exact: true }).click();
  await page.getByText("本次已取消，无可用报告。", { exact: false }).waitFor();
  const newRuns = await page.evaluate(() =>
    window.backtestFixture.mutations.filter((m) => m.name === "maBaseline"),
  );
  assert.equal(newRuns.length, 1);
  assert.equal(newRuns[0].input.symbol, "sh600519");
  assert.equal(newRuns[0].input.strategy.id, "factor-combination-v1");
  assert.deepEqual(newRuns[0].input.strategy.entry.conditions[2].left, {
    id: "qlib-MA",
    parameters: { period: 60 },
  });
  assert.equal(await page.getByLabel("实验报告", { exact: true }).count(), 0);
  await page.evaluate(() => (window.backtestFixture.removeFail = false));
  await page.getByRole("button", { name: "删除实验", exact: true }).click();
  await page.getByRole("button", { name: "确认删除实验", exact: true }).click();
  await page
    .getByText("实验及其冻结输入已删除，审计事实保留。", { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("实验报告空状态").count(), 1);
  await run.click();
  await page.getByRole("button", { name: "取消任务", exact: true }).waitFor();
  await page.evaluate(() => window.setBacktestVisible(false));
  await page.waitForTimeout(500);
  const before = await page.evaluate(
    () => window.backtestFixture.requests.length,
  );
  await page.waitForTimeout(1000);
  assert.equal(
    await page.evaluate(() => window.backtestFixture.requests.length),
    before,
  );
  await page.evaluate(() => window.setBacktestVisible(true));
  await page.getByRole("button", { name: "取消任务", exact: true }).click();
  await page.getByText("本次已取消，无可用报告。", { exact: false }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Backtest workspace: factor editing/validation/provenance/submission, draft/report identity, paging/filtering, zero/failed/cancelled, deletion/focus, keyboard, 320/400px and hidden reads passed.",
  );
} finally {
  await browser.close();
}
