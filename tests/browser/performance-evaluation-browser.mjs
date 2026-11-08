/** Real evaluation container + report, controlled transport using the real pure adapter. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "@playwright/test";

const transport = `
import {useQuery} from '@tanstack/react-query';
import {queryPerformanceEvaluation} from './src/server/performance/backtest-evaluation';
const equity=[],bars=[];let value=100000,close=10;
for(let i=0;i<390;i++){const date=new Date(Date.UTC(2024,9,1+i));if([0,6].includes(date.getUTCDay()))continue;const day=date.toISOString().slice(0,10);value*=1+Math.sin(i/8)*.006+.0004;close*=1+Math.cos(i/9)*.005;equity.push({date:day,value});bars.push({date:day+'T15:00:00+08:00',open:10,close});}
const archive={result:{input:{start:equity[0].date,end:equity.at(-1).date,initial:100000},equity},inputSnapshot:{bars}};
window.evaluationFixture={requests:[],fail:false};
export const api={maBaselineEvaluation:{useQuery(input,options){return useQuery({queryKey:['evaluation',input],retry:false,...options,queryFn:async()=>{window.evaluationFixture.requests.push(input);await new Promise(r=>setTimeout(r,input.period?.endsWith('01')?200:30));if(window.evaluationFixture.fail)throw Error('受控评价读取失败');return queryPerformanceEvaluation(input.id==='short'?{...archive,result:{...archive.result,equity:[{date:'2026-01-05',value:100000}],input:{initial:100000}},inputSnapshot:{bars:[]}}:archive,input)}})}}};`;
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {MaEvaluationPanel} from './src/components/backtest/ma-evaluation-panel';import {PanelVisibility} from './src/components/workbench/keep-alive';const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});function App(){const[id,setId]=useState('long');const[visible,setVisible]=useState(true);window.setEvaluationId=setId;window.setEvaluationVisible=setVisible;window.refreshEvaluation=()=>client.invalidateQueries();return <QueryClientProvider client={client}><PanelVisibility visible={visible}><main style={{padding:16,minWidth:0}}><MaEvaluationPanel key={id} id={id}/></main></PanelVisibility></QueryClientProvider>};createRoot(document.getElementById('root')).render(<App/>);`,
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
      name: "evaluation-transport",
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
    viewport: { width: 1440, height: 1100 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<meta charset="utf-8"><body style="margin:0;background:var(--nc-bg);color:var(--nc-text)"><div id="root"></div></body>',
    }),
  );
  await page.goto("http://127.0.0.1/evaluation-fixture");
  await page.addStyleTag({ content: css.css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByLabel("绩效评价内容").waitFor();
  await page.getByRole("button", { name: "季度", exact: true }).click();
  await page.getByLabel("季度评价明细", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "查看 2025-Q1", exact: true }).click();
  await page.getByLabel("选中期间详情").waitFor();
  assert.match(await page.getByLabel("选中期间详情").textContent(), /2025-Q1/);
  await page.getByRole("combobox", { name: "评价年份" }).click();
  await page.getByRole("option", { name: "2024 年" }).click();
  await page
    .getByRole("button", { name: "查看 2024-Q4", exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("选中期间详情").count(), 0);
  const heatmap = page.getByLabel("月度收益热力图");
  assert.equal(
    await heatmap
      .getByRole("button", { name: "2024-01 无样本", exact: true })
      .isDisabled(),
    true,
  );
  const november = heatmap.getByRole("button", { name: /^2024-11 / });
  await november.focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("选中期间详情").waitFor();
  assert.match(await page.getByLabel("选中期间详情").textContent(), /2024-11/);
  assert.equal(
    await page
      .getByRole("button", { name: "月度", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.getByRole("combobox", { name: "评价年份" }).click();
  await page.getByRole("option", { name: "2025 年" }).click();
  await page
    .getByRole("button", { name: "查看 2025-01", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "查看 2025-01", exact: true }).click();
  await page.getByLabel("选中期间详情").waitFor();
  await page.screenshot({
    path: join(tmpdir(), "quant-performance-desktop.png"),
    fullPage: true,
  });
  for (const width of [400, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.getByRole("button", { name: "季度", exact: true }).click();
    await page.getByLabel("季度评价明细", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: "月度", exact: true }).click();
    await page.getByLabel("月度评价明细", { exact: true }).first().waitFor();
  }
  await page.screenshot({
    path: join(tmpdir(), "quant-performance-mobile.png"),
    fullPage: true,
  });
  await page.evaluate(() => {
    window.evaluationFixture.fail = true;
    window.refreshEvaluation();
  });
  await page.getByRole("alert").waitFor();
  assert.equal(await page.getByLabel("绩效评价内容").count(), 0);
  await page.evaluate(() => {
    window.evaluationFixture.fail = false;
  });
  await page.getByRole("button", { name: "重试绩效评价" }).click();
  await page.getByLabel("绩效评价内容").waitFor();
  await page.evaluate(() => window.setEvaluationId("short"));
  await page
    .getByText("缺少完整同窗持有对照", { exact: true })
    .first()
    .waitFor();
  assert.equal(await page.getByLabel("选中期间详情").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "年度", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.evaluate(() => window.setEvaluationVisible(false));
  const before = await page.evaluate(
    () => window.evaluationFixture.requests.length,
  );
  await page.evaluate(() => window.refreshEvaluation());
  await page.waitForTimeout(150);
  assert.equal(
    await page.evaluate(() => window.evaluationFixture.requests.length),
    before,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Performance evaluation: real adapter, year/quarter/month, heatmap keyboard drill-down, missing data, error/retry, experiment reset, hidden reads, 1440/400/320px passed; screenshots in TEMP/quant-performance-*.png.",
  );
} finally {
  await browser.close();
}
