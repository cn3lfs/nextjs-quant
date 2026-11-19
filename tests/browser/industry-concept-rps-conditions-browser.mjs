/** Industry and concept RPS conditions: real components, controlled transport. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "@playwright/test";

const transport = `
import {useQuery} from '@tanstack/react-query';
window.rpsGroupFixture={requests:{industry:[],concept:[]},hold:{industry:false,concept:false},release:{}};
const labels={industry:['甲行业','乙行业','丙行业'],concept:['A概念','B概念','C概念']};
const values=[{rank:1,rps:80,return:0.1},{rank:2,rps:60,return:0.05},{rank:3,rps:40,return:0.01}];
async function page(kind,input){
 window.rpsGroupFixture.requests[kind].push(structuredClone(input));
 if(window.rpsGroupFixture.hold[kind])
  await new Promise(resolve=>{window.rpsGroupFixture.release[kind]=resolve;window.rpsGroupFixture.hold[kind]=false;});
 const conditions=input.conditions??[];
 const narrow=conditions.some(c=>c.value===70);
 const names=narrow?[kind==='industry'?'新条件行业':'新条件概念']:labels[kind];
 const count=names.length;
 const rows=names.map((name,i)=>({
  name,total:2,eligible:2,excluded:{unavailable:0},valid:2,endpointMissing:0,reason:null,
  file:{file:name+'.txt',hash:'a'.repeat(64),mtimeMs:1000},
  value:narrow?{rank:1,rps:80,return:0.1}:values[i],
  ...(conditions.length?{conditionValues:Object.fromEntries(conditions.map(c=>[String(c.period),{rank:1,rps:c.period===20?91:84,return:0.1}]))}:{}),
 }));
 return {
  day:{date:'2026-11-18',mode:'forward',count,hash:'b'.repeat(64),root:'root',
   classification:kind==='industry'?'sw-industry':'external-concept',
   source:{root:'src',calendar:'cal',actionsCoverage:'2026-11-18'}},
  ...(conditions.length?{conditions:conditions.map(c=>({...c,count,periodMissing:false}))}:{}),
  rows,total:rows.length,
 };
}
const status={data:{root:'',membershipSource:'blocks',tdxConfigured:true,ready:true,progress:null,latest:null}};
const mutation={mutate(){},reset(){},isPending:false,data:undefined,error:null};
export const api={
 industryRpsStatus:{useQuery:()=>status},
 conceptRpsStatus:{useQuery:()=>status},
 industryRpsPage:{useQuery:(input,o)=>useQuery({queryKey:['industryRpsPage',input],queryFn:async()=>page('industry',input),...o})},
 conceptRpsPage:{useQuery:(input,o)=>useQuery({queryKey:['conceptRpsPage',input],queryFn:async()=>page('concept',input),...o})},
 industryRpsConfigure:{useMutation:()=>mutation},
 industryRpsSourceConfigure:{useMutation:()=>mutation},
 industryRpsInspect:{useMutation:()=>mutation},
 rpsStart:{useMutation:()=>mutation},
 rpsCancel:{useMutation:()=>mutation},
 universeAuditPage:{useQuery:()=>({data:undefined})},
};
`;

const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {IndustryRpsControls} from './src/components/market/industry-rps-controls';import {ConceptRpsControls} from './src/components/market/concept-rps-controls';const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});function App(){return <QueryClientProvider client={client}><IndustryRpsControls/><ConceptRpsControls/></QueryClientProvider>};createRoot(document.getElementById('root')).render(<App/>);`,
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
      name: "controlled-rps-group-transport",
      setup(b) {
        b.onLoad({ filter: /trpc[\\/]react\.tsx$/ }, () => ({
          contents: transport,
          loader: "tsx",
          resolveDir: process.cwd(),
        }));
        b.onResolve({ filter: /^next\/navigation$/ }, () => ({
          path: "next-navigation",
          namespace: "rps-group-stub",
        }));
        b.onResolve({ filter: /^next\/link$/ }, () => ({
          path: "next-link",
          namespace: "rps-group-stub",
        }));
        b.onLoad({ filter: /.*/, namespace: "rps-group-stub" }, (args) => ({
          contents:
            args.path === "next-link"
              ? "import React from 'react';export default function Link({href,children,...rest}){return <a href={typeof href==='string'?href:undefined} {...rest}>{children}</a>}"
              : "export const useRouter=()=>({push(){},replace(){}});export const useSearchParams=()=>new URLSearchParams();",
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
    assert.equal(route.request().url(), "http://127.0.0.1/rps-groups");
    return route.fulfill({
      contentType: "text/html",
      body: '<meta charset="utf-8"><div id="root" style="padding:16px"></div>',
    });
  });
  await page.goto("http://127.0.0.1/rps-groups");
  await page.addStyleTag({ content: css.css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  const industry = page.getByRole("region", { name: "行业RPS数据管理" });
  const concept = page.getByRole("region", { name: "概念RPS数据管理" });
  const industryTable = page.getByRole("table", {
    name: "行业RPS排名与成分审计",
    exact: true,
  });
  const conceptTable = page.getByRole("table", {
    name: "概念RPS排名",
    exact: true,
  });
  const industrySummary = industry.locator(
    'div[role="status"][aria-live="polite"]',
  );
  const conceptSummary = concept.locator(
    'div[role="status"][aria-live="polite"]',
  );
  await industryTable.getByText("甲行业", { exact: true }).waitFor();
  await conceptTable.getByText("A概念", { exact: true }).waitFor();

  const last = (kind) =>
    page.evaluate((k) => window.rpsGroupFixture.requests[k].at(-1), kind);
  // Defaults stay independent: industry 20, concept 50, no conditions.
  assert.equal((await last("industry")).period, 20);
  assert.equal((await last("concept")).period, 50);
  assert.deepEqual((await last("industry")).conditions, []);
  assert.deepEqual((await last("concept")).conditions, []);
  assert.match(await industrySummary.textContent(), /无 RPS 条件/);

  // Apply an industry condition; the concept query must stay untouched.
  await industry.getByRole("button", { name: "添加条件", exact: true }).click();
  await industry.getByRole("combobox", { name: "条件1周期" }).click();
  await page.getByRole("option", { name: "RPS20", exact: true }).click();
  await industry.getByLabel("条件1阈值").fill("85");
  await industry.getByRole("button", { name: "应用条件", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.rpsGroupFixture.requests.industry.at(-1)?.conditions?.length === 1,
  );
  assert.deepEqual((await last("industry")).conditions, [
    { period: 20, side: "gte", value: 85 },
  ]);
  assert.equal(
    await page.evaluate(() =>
      window.rpsGroupFixture.requests.concept.every(
        (input) => (input.conditions ?? []).length === 0,
      ),
    ),
    true,
  );
  await industryTable
    .getByText("RPS20 91.00", { exact: true })
    .first()
    .waitFor();
  const industryStatus = await industrySummary.textContent();
  assert.match(industryStatus, /RPS20 ≥ 85/);
  assert.match(industryStatus, /命中 3 个行业/);
  assert.match(industryStatus, /条件周期有效排名基数：RPS20 3/);
  assert.match(await conceptSummary.textContent(), /无 RPS 条件/);

  // The concept group is independent: its own RPS50 threshold applies alone.
  const industryRequests = await page.evaluate(
    () => window.rpsGroupFixture.requests.industry.length,
  );
  await concept.getByRole("button", { name: "添加条件", exact: true }).click();
  await concept.getByRole("combobox", { name: "条件1周期" }).click();
  await page.getByRole("option", { name: "RPS50", exact: true }).click();
  await concept.getByLabel("条件1阈值").fill("80");
  await concept.getByRole("button", { name: "应用条件", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.rpsGroupFixture.requests.concept.at(-1)?.conditions?.length === 1,
  );
  assert.deepEqual((await last("concept")).conditions, [
    { period: 50, side: "gte", value: 80 },
  ]);
  assert.equal(
    await page.evaluate(() => window.rpsGroupFixture.requests.industry.length),
    industryRequests,
  );
  await industryTable
    .getByText("RPS20 91.00", { exact: true })
    .first()
    .waitFor();
  await conceptTable
    .getByText("RPS50 84.00", { exact: true })
    .first()
    .waitFor();

  // Clearing industry keeps the concept condition and its request in place.
  await industry.getByRole("button", { name: "清除条件", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.rpsGroupFixture.requests.industry.at(-1)?.conditions?.length === 0,
  );
  assert.deepEqual((await last("concept")).conditions, [
    { period: 50, side: "gte", value: 80 },
  ]);
  await conceptTable
    .getByText("RPS50 84.00", { exact: true })
    .first()
    .waitFor();

  // A held next-key load must not present the previous industry batch as the
  // new condition: rows, hits and bases wait for the current key's success.
  await page.evaluate(() => {
    window.rpsGroupFixture.hold.industry = true;
  });
  await industry.getByRole("button", { name: "添加条件", exact: true }).click();
  await industry.getByRole("combobox", { name: "条件1周期" }).click();
  await page.getByRole("option", { name: "RPS20", exact: true }).click();
  await industry.getByLabel("条件1阈值").fill("70");
  await industry.getByRole("button", { name: "应用条件", exact: true }).click();
  await page.waitForFunction(() =>
    window.rpsGroupFixture.requests.industry
      .at(-1)
      ?.conditions?.some((condition) => condition.value === 70),
  );
  assert.equal(
    await industryTable.getByText("甲行业", { exact: true }).count(),
    0,
  );
  assert.equal(
    await industryTable.getByText("RPS20 91.00", { exact: true }).count(),
    0,
  );
  const pendingIndustry = await industrySummary.textContent();
  assert.match(pendingIndustry, /等待当前条件的成功查询结果/);
  assert.doesNotMatch(pendingIndustry, /命中 3 个行业/);
  assert.doesNotMatch(pendingIndustry, /RPS20 3/);
  await page.evaluate(() => window.rpsGroupFixture.release.industry());
  await industryTable.getByText("新条件行业", { exact: true }).waitFor();
  const loadedIndustry = await industrySummary.textContent();
  assert.match(loadedIndustry, /命中 1 个行业/);
  assert.match(loadedIndustry, /RPS20 1/);

  // The same gate applies to the concept table.
  await page.evaluate(() => {
    window.rpsGroupFixture.hold.concept = true;
  });
  await concept.getByLabel("条件1阈值").fill("70");
  await concept.getByRole("button", { name: "应用条件", exact: true }).click();
  await page.waitForFunction(() =>
    window.rpsGroupFixture.requests.concept
      .at(-1)
      ?.conditions?.some((condition) => condition.value === 70),
  );
  assert.equal(
    await conceptTable.getByText("A概念", { exact: true }).count(),
    0,
  );
  assert.equal(
    await conceptTable.getByText("RPS50 84.00", { exact: true }).count(),
    0,
  );
  const pendingConcept = await conceptSummary.textContent();
  assert.match(pendingConcept, /等待当前条件的成功查询结果/);
  assert.doesNotMatch(pendingConcept, /命中 3 个概念/);
  assert.doesNotMatch(pendingConcept, /RPS50 3/);
  await page.evaluate(() => window.rpsGroupFixture.release.concept());
  await conceptTable.getByText("新条件概念", { exact: true }).waitFor();
  const loadedConcept = await conceptSummary.textContent();
  assert.match(loadedConcept, /命中 1 个概念/);
  assert.match(loadedConcept, /RPS50 1/);
  assert.equal(errors.length, 0);
  console.log("industry-concept-rps-conditions browser fixture passed");
} finally {
  await browser.close();
}
