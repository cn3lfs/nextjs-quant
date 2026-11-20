/** 宽基 ETF 日度净申赎（国家队指标）：真实组件 + esbuild 夹具，无服务端/数据库。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "@playwright/test";

let browser;
try {
  const transport = `
    import {useQuery} from '@tanstack/react-query';
    const f=window.etfFixture={requests:[]};
    const base={version:'etf-net-subscriptions-2',source:'国家队指标',scope:'12只主流宽基 ETF 合计',filename:'state_history.csv',requestedDate:'2026-11-19',latest:null,sourceFirst:'2015-01-06',sourceLast:'2026-11-17',window:null,points:[],duplicates:[],summary:{total:null,coreTotal:null,valid:0,complete:false},index:{symbol:'sh000001',name:'上证指数',state:'unavailable',matched:0,sourceLast:null,warning:null},warning:null,loadedAt:1,generatedAt:1};
    const data={...base,state:'ok',latest:'2026-11-17',window:{start:'2026-11-11',end:'2026-11-17',count:5},points:[
      {date:'2026-11-11',net:186.2,coreNet:102.4,regime:'企稳确认',score:45,index:3584.58},
      {date:'2026-11-12',net:-315.54,coreNet:-180.1,regime:'撤退预警',score:-32,index:null},
      {date:'2026-11-13',net:0,coreNet:0,regime:'观望',score:0,index:3610.2},
      {date:'2026-11-16',net:null,coreNet:null,regime:null,score:null,index:3602.57},
      {date:'2026-11-17',net:152.39,coreNet:88.5,regime:'托底期',score:51,index:3580.1}],
      duplicates:[{date:'2026-11-16',count:2}],
      summary:{total:null,coreTotal:null,valid:4,complete:false},
      index:{...base.index,state:'ok',matched:4,sourceLast:'2026-11-18'}};
    export const api={etfNetSubscriptions:{useQuery(_input,options){return useQuery({queryKey:['etfNetSubscriptions'],...options,queryFn:async()=>{f.requests.push(1);return data;}});}}};
  `;
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {EtfNetSubscriptions} from './src/components/overview/etf-net-subscriptions';
      const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><EtfNetSubscriptions/></QueryClientProvider>);`,
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
        name: "etf-net-transport",
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
    viewport: { width: 1024, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    Object.defineProperty(document, "hasFocus", {
      value: () => true,
      configurable: true,
    });
  });
  await page.route("**/*", (route) => {
    assert.equal(route.request().url(), "http://127.0.0.1/etf-net-fixture");
    return route.fulfill({
      contentType: "text/html",
      body: '<meta charset="utf-8"><div id="root" style="padding:16px"></div>',
    });
  });
  await page.goto("http://127.0.0.1/etf-net-fixture");
  await page.addStyleTag({ content: css.css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  // 主路径：记录日、最新单点、核心池、阶段力度、未合计说明与指数同日覆盖。
  await page.getByText("宽基 ETF 日度净申赎").waitFor();
  await page.getByText("截至 2026-11-17（记录日）", { exact: false }).waitFor();
  await page.getByText("+152.39 亿元", { exact: true }).waitFor();
  await page.getByText("+88.50 亿元", { exact: false }).waitFor();
  await page.getByText("托底期", { exact: true }).waitFor();
  await page.getByText("有效 4/5 日 · 未合计", { exact: false }).waitFor();
  await page.getByText("指数源截至 2026-11-18", { exact: false }).waitFor();
  await page
    .getByText("仅 4/5 个记录日有精确同日点数", { exact: false })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "1024 宽窗口不得横向溢出",
  );

  // 键盘展开原生 details，核对精确数值、真实 0、负数、重复缺失与同日指数缺失。
  await page.locator("summary").focus();
  await page.keyboard.press("Enter");
  const table = page.getByRole("table", {
    name: "宽基 ETF 日度净申赎逐日明细",
  });
  await table.waitFor();
  assert.equal(await table.locator("tbody tr").count(), 5);
  const rows = await table.locator("tbody tr").allInnerTexts();
  assert.match(rows.join("\n"), /2026-11-16.*歧义（重复）.*3602\.57/s);
  assert.match(rows.join("\n"), /2026-11-12.*-315\.54.*同日无数据/s);
  assert.match(rows.join("\n"), /2026-11-13.*0\.00.*3610\.20/s);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "窄屏展开明细时页面不得横向溢出，表格应在自身容器内滚动",
  );
  assert.deepEqual(errors, []);
  console.log(
    "宽基 ETF 净申赎浏览器：国家队指标/记录日/核心池/阶段力度/明细/无横溢通过",
  );
} finally {
  await browser?.close();
}
