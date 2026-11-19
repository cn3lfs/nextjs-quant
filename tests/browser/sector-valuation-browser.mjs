/** 板块估值：真实组件 + 受控 tRPC 传输，验证分类、排序、分页与缺口语义。 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "@playwright/test";

const transport = `
import {useQuery,useQueryClient} from '@tanstack/react-query';
window.sectorValuationFixture={requests:[]};
function pctWindow(value,samples,complete,reason=null){
 return {years:value===null?(samples>1000?10:5):5,windowStart:'2021-11-17',sampleStart:'2021-11-17',complete,samples,notAbove:value===null?null:Math.round(value/100*(samples||1)),percentile:value,reason};
}
function metric(value,percentile,samples,complete,reason=null){
 return {value,missing:value===null?'missing-on-date':null,
  y5:pctWindow(percentile,samples,complete,reason),
  y10:pctWindow(null,samples+1,false,'本地序列起点 2018-08-16 未覆盖 10 年窗口（窗口起点 2016-11-17）')};
}
function row(category,code,name,pe,pePct,peSamples,pb,pbPct,pbSamples,negative=false){
 return {category,classification:category==='industry'?'tdx-research':'tdx-concept',code,name,symbol:'sh'+code,status:'ok',reason:null,date:'2026-11-17',
  pe:metric(pe,negative?null:pePct,negative?4:peSamples,true,negative?'当前倍数缺失或非正，不计算分位':null),
  pb:metric(pb,pbPct,pbSamples,true),sourceFirst:'2018-08-16',sourceLast:'2026-11-17'};
}
function unavailable(category,code,name){
 const empty={value:null,missing:'no-file',y5:{years:5,windowStart:null,sampleStart:null,complete:false,samples:0,percentile:null,reason:'本地未下载该板块序列文件'},y10:{years:10,windowStart:null,sampleStart:null,complete:false,samples:0,percentile:null,reason:'本地未下载该板块序列文件'}};
 return {category,classification:category==='industry'?'tdx-research':'tdx-concept',code,name,symbol:'sh'+code,status:'unavailable',reason:'本地未下载该板块序列文件',date:null,pe:empty,pb:{...empty},sourceFirst:null,sourceLast:null};
}
function page(input){
 window.sectorValuationFixture.requests.push(structuredClone(input));
 const industry=input.category==='industry';
 const total=industry?60:1;
 const pageIndex=input.pageIndex??0;
 let rows;
 if(!industry) rows=[row('concept','880001','样本概念完整名',12,40,4,1.2,30,4)];
 else if(pageIndex===0) rows=[
  row('industry','881001','研究金融',input.refresh?19.5:17.9,75,4,1.69,60,4),
  row('industry','881002','研究银行',-5,0,0,1.2,30,4,true),
  unavailable('industry','881003','研究消费'),
  ...Array.from({length:47},(_,i)=>row('industry',String(882000+i),'样本行业'+(i+1),10+i,20,4,1.1,10,4)),
 ];
 else rows=Array.from({length:10},(_,i)=>row('industry',String(883000+i),'第二页板块'+(i+1),10+i,20,4,1.1,10,4));
 return {version:'sector-valuation-1',available:true,state:'ok',reason:null,requestedDate:'2026-11-19',
  category:input.category,classification:industry?'tdx-research':'tdx-concept',counts:{industry:60,concept:1},
  coverage:{blocks:total,readable:total-1,first:'2018-08-16',last:'2026-11-17'},
  observation:{date:'2026-11-17',window5:'2021-11-17',window10:'2016-11-17'},
  rows,total,pageIndex,pageSize:input.pageSize??50,sort:input.sort,descending:input.descending,cached:false,warning:null,generatedAt:1};
}
export const api={
 sectorValuation:{useQuery:(input,o)=>useQuery({queryKey:['sectorValuation',input],queryFn:async()=>page(input),...o})},
 useUtils:()=>{const qc=useQueryClient();return {sectorValuation:{
  fetch:(input)=>Promise.resolve(page(input)),
  setData:(input,data)=>qc.setQueryData(['sectorValuation',input],data),
 }}},
};
`;

const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {SectorValuationView} from './src/components/market/sector-valuation-view';const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><SectorValuationView/></QueryClientProvider>);`,
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
      name: "controlled-sector-valuation-transport",
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
    viewport: { width: 1440, height: 1200 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    assert.equal(route.request().url(), "http://127.0.0.1/sector-valuation");
    return route.fulfill({
      contentType: "text/html",
      body: '<meta charset="utf-8"><div id="root" style="padding:16px"></div>',
    });
  });
  await page.goto("http://127.0.0.1/sector-valuation");
  await page.addStyleTag({ content: css.css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  const region = page.getByRole("region", { name: "板块估值" });
  const table = page.getByRole("table", { name: "行业板块估值" });
  await table.getByText("研究金融", { exact: true }).waitFor();
  const last = () =>
    page.evaluate(() => window.sectorValuationFixture.requests.at(-1));
  assert.deepEqual(await last(), {
    category: "industry",
    sort: "pe5",
    descending: false,
    pageIndex: 0,
    pageSize: 50,
  });
  // 负值保留原倍数、分位留空；10 年窗口标历史不足；缺序列显示原因。
  assert.equal(await table.getByText("-5.00", { exact: true }).count(), 1);
  await table.getByText("研究消费", { exact: true }).waitFor();
  assert.match(await table.textContent(), /未下载序列/);
  assert.match(await table.textContent(), /历史不足/);
  assert.match(await table.textContent(), /当前倍数缺失或非正/);

  // 刷新用 refresh:true 读取，但结果写回当前普通 key；界面显示新值。
  await region.getByRole("button", { name: "刷新本地" }).click();
  await page.waitForFunction(() =>
    window.sectorValuationFixture.requests.some(
      (input) => input.refresh === true,
    ),
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.sectorValuationFixture.requests.find(
        (input) => input.refresh === true,
      ),
    ),
    {
      category: "industry",
      sort: "pe5",
      descending: false,
      pageIndex: 0,
      pageSize: 50,
      refresh: true,
    },
  );
  await table.getByText("19.50", { exact: true }).waitFor();
  assert.equal(await table.getByText("17.90", { exact: true }).count(), 0);

  // 切到概念后不得再显示行业刷新结果或行业身份。
  await page
    .getByRole("radiogroup", { name: "板块分类" })
    .getByRole("radio", { name: /概念/ })
    .click();
  await page.getByText("样本概念完整名", { exact: true }).waitFor();
  assert.equal((await last()).category, "concept");
  assert.equal(await page.getByText("研究金融", { exact: true }).count(), 0);
  assert.equal(await page.getByText("19.50", { exact: true }).count(), 0);

  await region.getByRole("combobox", { name: "板块估值排序" }).click();
  await page.getByRole("option", { name: "PE 倍数", exact: true }).click();
  await page.waitForFunction(
    () => window.sectorValuationFixture.requests.at(-1)?.sort === "pe",
  );
  assert.equal((await last()).pageIndex, 0);

  await page
    .getByRole("radiogroup", { name: "板块分类" })
    .getByRole("radio", { name: /行业/ })
    .click();
  await page.getByText("研究金融", { exact: true }).waitFor();
  await region.getByRole("button", { name: "下一页" }).click();
  await page.getByText("第二页板块1", { exact: true }).waitFor();
  assert.equal((await last()).pageIndex, 1);
  assert.match(await region.textContent(), /第 2 \/ 2 页/);
  assert.equal(errors.length, 0);
} finally {
  await browser.close();
}
