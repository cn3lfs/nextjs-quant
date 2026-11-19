/** Stock RPS multi-period conditions: real component, controlled transport. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "@playwright/test";

const transport = `
import {useQuery} from '@tanstack/react-query';
const baseRows=[
 {symbol:'sh600000',name:'有排名样本',localDay:true,value:{return:0.119,rank:1,rps:90},reason:null},
 {symbol:'sh600001',name:'退市缓存样本',localDay:false,fullDayCache:true,value:null,reason:'停牌'},
 {symbol:'sz000022',name:'代码变更样本',localDay:false,value:null,reason:'上市不足250个交易日'},
];
window.rpsConditionFixture={requests:[],unavailable:false};
function pool(input){
 window.rpsConditionFixture.requests.push(structuredClone(input));
 const conditions=input.conditions??[];
 const unavailable=conditions.length>0&&window.rpsConditionFixture.unavailable;
 const rows=unavailable?[]:conditions.length?[{
  symbol:'sh600000',name:'双条件命中',localDay:true,
  value:{return:0.119,rank:1,rps:90},
  conditionValues:Object.fromEntries(conditions.map(condition=>[String(condition.period),{return:0.05,rank:5,rps:condition.period===20?92:85}])),
  reason:null,
 }]:structuredClone(baseRows);
 return {
  query:input,
  availability:{rps:'ready',dailyIndex:'ready'},
  source:null,membershipCount:rows.length,unmatchedLocalCount:0,excludedMarket:0,
  period:input.period,total:rows.length,previous:null,next:null,
  rps:{
   date:'2026-11-12',mode:'backfill',count:10,inputHash:'fixture',observation:null,
   ...(conditions.length?{conditions:conditions.map(condition=>({...condition,count:unavailable?null:condition.period===20?5870:5801,periodMissing:unavailable}))}:{}),
  },
  rows,
 };
}
export const api={
 rpsStatus:{useQuery:()=>({data:{progress:null}})},
 marketPoolPage:{useQuery:(input,options)=>useQuery({queryKey:['marketPoolPage',input],queryFn:async()=>pool(input),...options})},
};
`;

const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {StockRpsRanking} from './src/components/market/stock-rps-ranking';const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});function App(){return <QueryClientProvider client={client}><StockRpsRanking/></QueryClientProvider>};createRoot(document.getElementById('root')).render(<App/>);`,
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
      name: "controlled-rps-transport",
      setup(b) {
        b.onLoad({ filter: /trpc[\\/]react\.tsx$/ }, () => ({
          contents: transport,
          loader: "tsx",
          resolveDir: process.cwd(),
        }));
        b.onResolve({ filter: /^next\/navigation$/ }, () => ({
          path: "next-navigation",
          namespace: "rps-stub",
        }));
        b.onLoad({ filter: /.*/, namespace: "rps-stub" }, () => ({
          contents:
            "export const useRouter=()=>({push(){},replace(){}});export const useSearchParams=()=>new URLSearchParams();",
          loader: "ts",
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
    assert.equal(route.request().url(), "http://127.0.0.1/rps-conditions");
    return route.fulfill({
      contentType: "text/html",
      body: '<meta charset="utf-8"><div id="root" style="padding:16px"></div>',
    });
  });
  await page.goto("http://127.0.0.1/rps-conditions");
  await page.addStyleTag({ content: css.css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  const table = page.getByRole("table", { name: "个股RPS排名", exact: true });
  await table.getByText("有排名样本", { exact: false }).waitFor();
  // The applied summary block stays mounted while its text changes.
  const summary = page.locator('div[role="status"][aria-live="polite"]');
  await summary.getByText("已生效条件", { exact: false }).waitFor();
  assert.match(await summary.textContent(), /无 RPS 条件/);
  assert.match(await summary.textContent(), /命中 3 只/);

  // A draft row and threshold are not applied until the button is pressed.
  await page.getByRole("button", { name: "添加条件", exact: true }).click();
  await page.getByRole("combobox", { name: "条件1周期", exact: true }).click();
  await page.getByRole("option", { name: "RPS20", exact: true }).click();
  await page.getByLabel("条件1阈值", { exact: true }).fill("85");
  assert.equal(
    await page.evaluate(() =>
      window.rpsConditionFixture.requests.some(
        (input) => (input.conditions ?? []).length > 0,
      ),
    ),
    false,
  );
  assert.match(await summary.textContent(), /无 RPS 条件/);

  await page.getByRole("button", { name: "应用条件", exact: true }).click();
  await page.waitForFunction(
    () => window.rpsConditionFixture.requests.at(-1)?.conditions?.length === 1,
  );
  assert.deepEqual(
    await page.evaluate(
      () => window.rpsConditionFixture.requests.at(-1).conditions,
    ),
    [{ period: 20, side: "gte", value: 85 }],
  );
  await table.getByText("双条件命中", { exact: false }).waitFor();
  assert.match(await summary.textContent(), /RPS20 ≥ 85/);
  await table.getByText("RPS20 92.00", { exact: true }).waitFor();
  assert.match(await summary.textContent(), /条件周期有效排名基数：RPS20 5870/);

  // A second period joins the same AND group and shows both actual RPS values.
  await page.getByRole("button", { name: "添加条件", exact: true }).click();
  await page.getByRole("combobox", { name: "条件2周期", exact: true }).click();
  await page.getByRole("option", { name: "RPS50", exact: true }).click();
  await page.getByLabel("条件2阈值", { exact: true }).fill("80");
  await page.getByRole("button", { name: "应用条件", exact: true }).click();
  await page.waitForFunction(
    () => window.rpsConditionFixture.requests.at(-1)?.conditions?.length === 2,
  );
  assert.deepEqual(
    await page.evaluate(
      () => window.rpsConditionFixture.requests.at(-1).conditions,
    ),
    [
      { period: 20, side: "gte", value: 85 },
      { period: 50, side: "gte", value: 80 },
    ],
  );
  await table.getByText("RPS20 92.00 · RPS50 85.00", { exact: true }).waitFor();
  assert.match(await summary.textContent(), /RPS50 5801/);

  // A duplicate period is rejected with the row marked, without a new query.
  const before = await page.evaluate(
    () => window.rpsConditionFixture.requests.length,
  );
  await page.getByRole("button", { name: "添加条件", exact: true }).click();
  await page.getByRole("combobox", { name: "条件3周期", exact: true }).click();
  await page.getByRole("option", { name: "RPS20", exact: true }).click();
  await page.getByLabel("条件3阈值", { exact: true }).fill("70");
  await page.getByRole("button", { name: "应用条件", exact: true }).click();
  await page
    .getByRole("alert")
    .getByText("条件周期不能重复", { exact: false })
    .waitFor();
  assert.equal(await page.getByText("周期重复", { exact: true }).count(), 2);
  assert.equal(
    await page.evaluate(() => window.rpsConditionFixture.requests.length),
    before,
  );
  await page.getByRole("button", { name: "移除", exact: true }).nth(2).click();

  // A missing condition period is reported as unavailable, never as 0 hits.
  await page.evaluate(() => (window.rpsConditionFixture.unavailable = true));
  await page.getByRole("combobox", { name: "条件1周期", exact: true }).click();
  await page.getByRole("option", { name: "RPS120", exact: true }).click();
  await page.getByRole("button", { name: "应用条件", exact: true }).click();
  await page.waitForFunction(() =>
    window.rpsConditionFixture.requests
      .at(-1)
      ?.conditions?.some((condition) => condition.period === 120),
  );
  await page.waitForFunction(() =>
    document
      .querySelector('div[role="status"][aria-live="polite"]')
      ?.textContent.includes("条件不可用"),
  );
  const unavailableSummary = await summary.textContent();
  assert.match(unavailableSummary, /条件不可用/);
  assert.doesNotMatch(unavailableSummary, /命中 0 只/);
  await page
    .getByText("条件不可用：当前批次未计算所需周期", { exact: false })
    .waitFor();
  assert.equal(await page.getByText("共 0 条", { exact: false }).count(), 0);
  await page.evaluate(() => (window.rpsConditionFixture.unavailable = false));

  await page.getByRole("button", { name: "清除条件", exact: true }).click();
  await page.waitForFunction(
    () => window.rpsConditionFixture.requests.at(-1)?.conditions?.length === 0,
  );
  await table.getByText("有排名样本", { exact: false }).waitFor();
  assert.match(await summary.textContent(), /无 RPS 条件/);
  assert.equal(errors.length, 0);
  console.log("stock-rps-conditions browser fixture passed");
} finally {
  await browser.close();
}
