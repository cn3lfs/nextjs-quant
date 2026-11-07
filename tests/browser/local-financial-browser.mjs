/** Real finance components and parser fixture; controlled transport, no production DB. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "quant-financial-browser-"));
let browser;
try {
  mkdirSync(join(root, "vipdoc/cw"), { recursive: true });
  for (const [from, to] of [
    ["gpcw20260930.dat", "gpcw20260930.dat"],
    ["gpsz000001.dat", "gpsh600519.dat"],
    ["gpsh999999.dat", "gpsh999999.dat"],
  ])
    copyFileSync(
      `packages/tstdx/tests/fixtures/local/${from}`,
      join(root, "vipdoc/cw", to),
    );
  const fixture = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
    import {localFinancialView,localFinancialSeriesView} from './src/server/financial/local-financial-service.ts';
    const root=process.env.QUANT_FINANCIAL_FIXTURE;
    const views=await Promise.all(Array.from({length:7},(_,pageIndex)=>localFinancialView(root,{symbol:'sh600519',pageIndex,pageSize:100})));
    console.log(JSON.stringify({view:{...views[0],rows:views.flatMap(v=>v.rows)},stock:await localFinancialSeriesView(root,{symbol:'sh600519'}),market:await localFinancialSeriesView(root,{symbol:'sh999999'})}));
  `,
      ],
      {
        env: {
          ...process.env,
          QUANT_DATA_DIR: join(root, "app-data"),
          QUANT_FINANCIAL_FIXTURE: root,
        },
        encoding: "utf8",
      },
    ),
  );
  assert.equal(fixture.view.rows.length, 658);
  const transport = `
    import {useMemo} from 'react';
    import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
    const data=${JSON.stringify(fixture)};
    const f=window.financeFixture={requests:[],mutations:[],fail:'',jobs:{}};
    function value(name,input){
      f.requests.push({name,input});if(f.fail===name)throw Error('受控读取失败');
      if(name==='localFinancialView'){
        const rows=data.view.rows.filter(r=>(!input.search||(r.code+' '+r.label).includes(input.search))&&(!input.section||r.section===input.section));
        return {...data.view,query:input,rows:rows.slice(input.pageIndex*input.pageSize,(input.pageIndex+1)*input.pageSize),rowCount:rows.length};
      }
      if(name==='localFinancialSeries'){const source=input.symbol==='sh999999'?data.market:data.stock;const rows=source.rows.filter(r=>input.group===undefined||r.group===input.group);return {...source,rows,rowCount:rows.length};}
      if(name==='job')return f.jobs[input.id]??null;
      if(name.endsWith('History')||name==='marketPoolCatalog')return [];
      return null;
    }
    const queries=['localFinancialView','localFinancialSeries','localFinancialAudit','job','localFinancialArchiveHistory','localFinancialArchive','localFinancialScreenHistory','localFinancialScreenPage','marketPoolCatalog'];
    const mutations=['localFinancialAuditStart','localFinancialArchiveCreate','localFinancialArchiveDelete','localFinancialScreenStart','localFinancialScreenDelete','cancel'];
    export const api={...Object.fromEntries(queries.map(name=>[name,{useQuery(input,options){return useQuery({queryKey:[name,input],retry:false,...options,queryFn:async()=>value(name,input)});}}])),
      ...Object.fromEntries(mutations.map(name=>[name,{useMutation(options){const client=useQueryClient();return useMutation({...options,mutationFn:async(input)=>{f.mutations.push({name,input});if(name==='cancel'){f.jobs[input].status='cancelled';await client.invalidateQueries({queryKey:['job']});return {ok:true};}const id='finance-job-'+f.mutations.length;return f.jobs[id]={id,status:'queued',progress:0,phase:'排队'};}});}}])),
      useUtils(){const client=useQueryClient();return useMemo(()=>Object.fromEntries([...queries,'localFinancialExport','localFinancialScreenExport'].map(name=>[name,{invalidate:()=>client.invalidateQueries({queryKey:[name]}),fetch:async input=>{if(f.fail===name)throw Error('受控导出失败');return {report:{reportDate:'2026-09-30'},rows:data.view.rows};}}])),[client]);}
    };
  `;
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {LocalFinancialWorkbench} from './src/components/financial/local-financial-workbench';const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><LocalFinancialWorkbench symbol="sh600519"/></QueryClientProvider>);`,
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
        name: "finance-transport",
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
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) => {
    assert.equal(route.request().url(), "http://127.0.0.1/financial-fixture");
    return route.fulfill({
      contentType: "text/html",
      body: '<meta charset="utf-8"><div id="root" style="padding:16px"></div>',
    });
  });
  await page.goto("http://127.0.0.1/financial-fixture");
  await page.addStyleTag({ content: css.css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByText("报告期 2026-09-30", { exact: false }).waitFor();
  assert.equal(
    await page.evaluate(() => window.financeFixture.mutations.length),
    0,
  );
  await page.getByRole("tab", { name: "三表与全部字段", exact: true }).click();
  const table = page.getByLabel("本地财务字段", { exact: true }).first();
  assert.equal(await table.locator("tbody tr").count(), 30);
  await table.getByRole("button", { name: /下一页/ }).click();
  await page.waitForFunction(() =>
    window.financeFixture.requests.some(
      (r) => r.name === "localFinancialView" && r.input.pageIndex === 1,
    ),
  );
  await page.getByLabel("搜索财务字段", { exact: true }).fill("FN63");
  await table.getByText("负债合计", { exact: true }).waitFor();
  assert.equal(await table.locator("tbody tr").count(), 1);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出本期全部字段", exact: true })
    .click();
  assert.match(
    (await download).suggestedFilename(),
    /2026-09-30-financial\.json$/,
  );
  await page.evaluate(
    () => (window.financeFixture.fail = "localFinancialExport"),
  );
  await page
    .getByRole("button", { name: "导出本期全部字段", exact: true })
    .click();
  await page.getByRole("alert").getByText("受控导出失败").waitFor();
  await page.evaluate(() => (window.financeFixture.fail = ""));
  await page.getByRole("tab", { name: "股票/板块/市场", exact: true }).click();
  await page.getByText("无有效日期（0）", { exact: true }).waitFor();
  await page.getByRole("button", { name: "全市场", exact: true }).click();
  await page.getByText("SC99", { exact: false }).waitFor();
  await page.getByRole("tab", { name: "来源与诊断", exact: true }).click();
  await page
    .getByText("尚无已验证本地映射的官方项目", { exact: false })
    .click();
  await page.getByText("GO1", { exact: false }).first().waitFor();
  await page.getByRole("tab", { name: "本地质量档案", exact: true }).click();
  await page
    .getByRole("button", { name: "生成本地财务档案", exact: true })
    .click();
  await page.getByRole("button", { name: "取消任务", exact: true }).click();
  await page.waitForFunction(() =>
    window.financeFixture.mutations.some((r) => r.name === "cancel"),
  );
  await page.getByRole("tab", { name: "财务组合筛选", exact: true }).click();
  await page
    .getByRole("button", { name: "删除条件", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "删除条件", exact: true }).click();
  await page
    .getByRole("button", { name: "添加本地数据因子", exact: true })
    .click();
  await page.getByLabel("数据因子1字段", { exact: true }).click();
  await page
    .getByRole("option", { name: "规模 · 对数总市值 · 指数", exact: true })
    .click();
  await page.getByLabel("数据因子1阈值", { exact: true }).fill("20");
  await page
    .getByRole("button", { name: "添加本地数据因子", exact: true })
    .click();
  await page.getByLabel("数据因子2字段", { exact: true }).click();
  await page
    .getByRole("option", {
      name: "指定板块 · BK5 PE TTM整体法 · 原单位",
      exact: true,
    })
    .click();
  await page.getByLabel("板块因子标的", { exact: true }).fill("sh880301");
  await page.getByRole("button", { name: "添加技术条件", exact: true }).click();
  await page.getByLabel("技术条件1因子", { exact: true }).click();
  await page
    .getByRole("option", { name: "波动 · 收益波动率", exact: true })
    .click();
  await page.getByLabel("财务筛选基准日期", { exact: true }).fill("2026-11-06");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "因子编辑器窄屏不得溢出",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "运行财务组合筛选", exact: true })
    .click();
  const submitted = await page.evaluate(
    () =>
      window.financeFixture.mutations.find(
        (r) => r.name === "localFinancialScreenStart",
      ).input,
  );
  assert.deepEqual(submitted.conditions, []);
  assert.deepEqual(
    submitted.dataFactors.map((f) => f.id),
    ["log-market-cap", "BK5-0"],
  );
  assert.equal(submitted.factorBlockSymbol, "sh880301");
  assert.equal(submitted.technical[0].left.id, "return-volatility");
  await page.getByRole("button", { name: "取消筛选", exact: true }).click();
  await page.getByRole("tab", { name: "三表与全部字段", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("搜索财务字段", { exact: true }).fill("FN74");
  await table.getByText("其中：营业收入", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "窄屏页面不得横向溢出",
  );
  await page.evaluate(
    () => (window.financeFixture.fail = "localFinancialView"),
  );
  await page.getByRole("button", { name: "刷新本地数据", exact: true }).click();
  await page
    .getByText("本地财务读取失败：受控读取失败", { exact: true })
    .waitFor();
  await page.evaluate(() => (window.financeFixture.fail = ""));
  await page.getByRole("button", { name: "刷新本地数据", exact: true }).click();
  await page.waitForFunction(
    () => !document.body.textContent.includes("本地财务读取失败：受控读取失败"),
  );
  await page.getByRole("tab", { name: "财务概览", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByText("报告期 2026-09-30", { exact: false }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "财务浏览器：分页/查找/导出/缺失日期/市场未知组/新增因子配置提交/指定板块/任务取消/窄屏/失败重试/键盘通过",
  );
} finally {
  await browser?.close();
  rmSync(root, { recursive: true, force: true });
}
