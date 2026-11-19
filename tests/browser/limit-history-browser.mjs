/** 通达信本地涨跌停按日面板：真实组件 + esbuild 夹具，无服务端/数据库。 */
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
    const f=window.limitFixture={requests:[],fail:'',mode:'ok'};
    const datasets={
      '2026-11-18':{state:'ok',sourceFirst:'2018-08-17',sourceLast:'2026-11-18',latest:'2026-11-18',window:{start:'2026-11-16',end:'2026-11-18',count:3},points:[
        {date:'2026-11-16',limitUp:10,limitDown:0},
        {date:'2026-11-17',limitUp:null,limitDown:5},
        {date:'2026-11-18',limitUp:42,limitDown:40}],
        duplicates:[{group:3,field:'limitUp',date:'2026-11-17',count:2}]},
      '2026-11-10':{state:'ok',sourceFirst:'2018-08-17',sourceLast:'2026-11-18',latest:'2026-11-10',window:{start:'2026-11-09',end:'2026-11-10',count:2},points:[
        {date:'2026-11-09',limitUp:7,limitDown:3},
        {date:'2026-11-10',limitUp:8,limitDown:4}],duplicates:[]}
    };
    const base=(date)=>({version:'limit-history-1',source:'通达信本地',scope:'本地',filename:'gpsh999999.dat',requestedDate:date,latest:null,sourceFirst:'2018-08-17',sourceLast:'2026-11-18',window:null,points:[],duplicates:[],warning:null,loadedAt:1,generatedAt:1});
    export const api={limitHistory:{useQuery(input,options){return useQuery({queryKey:['limitHistory',input],...options,queryFn:async()=>{
      f.requests.push(input);
      if(f.fail)throw Error('受控本地读取失败');
      if(f.mode==='unconfigured')return {...base(input.date),state:'source-unconfigured',warning:'通达信本地目录尚未配置'};
      if(f.mode==='no-history')return {...base(input.date),state:'no-history',warning:'本地源覆盖 2018-08-17 ~ 2026-11-18，所选日期及之前没有记录'};
      return {...base(input.date),...datasets[input.date]};
    }});}}};
  `;
  const bundle = await build({
    stdin: {
      contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {LimitDailyTrend} from './src/components/market/limit-daily-trend';
      const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
      window.limitInvalidate=()=>client.invalidateQueries();
      function Fixture(){const [date,setDate]=useState('2026-11-18');return <div><button onClick={()=>setDate('2026-11-10')}>切到 11-10</button><button onClick={()=>{window.limitFixture.mode='unconfigured';window.limitInvalidate();}}>未配置</button><button onClick={()=>{window.limitFixture.mode='no-history';window.limitInvalidate();}}>无历史</button><LimitDailyTrend date={date} visible={true}/></div>;}
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><Fixture/></QueryClientProvider>);`,
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
        name: "limit-history-transport",
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
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) => {
    assert.equal(
      route.request().url(),
      "http://127.0.0.1/limit-history-fixture",
    );
    return route.fulfill({
      contentType: "text/html",
      body: '<meta charset="utf-8"><div id="root" style="padding:16px"></div>',
    });
  });
  await page.goto("http://127.0.0.1/limit-history-fixture");
  await page.addStyleTag({ content: css.css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  await page.getByText("跟随查询日期 2026-11-18", { exact: false }).waitFor();
  await page
    .getByText("显示 2026-11-16 ~ 2026-11-18", { exact: false })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "1024 宽窗口不得横向溢出",
  );
  // 键盘展开原生 details，核对精确数值、真实 0 与歧义缺失。
  await page.locator("summary").focus();
  await page.keyboard.press("Enter");
  const table = page.getByRole("table", {
    name: "通达信本地涨跌停逐日明细",
  });
  await table.waitFor();
  assert.equal(await table.locator("tbody tr").count(), 3);
  const rows = await table.locator("tbody tr").allInnerTexts();
  assert.match(rows.join("\n"), /2026-11-17.*歧义（重复）.*5/s);
  assert.match(rows.join("\n"), /2026-11-16.*10.*0/s);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "窄屏展开明细时页面不得横向溢出，表格应在自身容器内滚动",
  );
  await page.setViewportSize({ width: 1024, height: 900 });

  // 切日必须换成新曲线，不能保留上一个日期。
  await page.getByRole("button", { name: "切到 11-10" }).click();
  await page.getByText("跟随查询日期 2026-11-10", { exact: false }).waitFor();
  assert.equal(await page.getByText("2026-11-16", { exact: false }).count(), 0);

  // 未配置与无历史各自可辨识。
  await page.getByRole("button", { name: "未配置" }).click();
  await page.getByText("通达信本地目录尚未配置", { exact: false }).waitFor();
  await page.getByRole("button", { name: "无历史" }).click();
  await page.getByText("所选日期及之前没有记录", { exact: false }).waitFor();

  // 错误与重试只作用于本地读取。
  await page.evaluate(() => {
    window.limitFixture.mode = "ok";
    window.limitFixture.fail = "1";
    window.limitInvalidate();
  });
  await page.getByText("受控本地读取失败", { exact: false }).waitFor();
  await page.evaluate(() => (window.limitFixture.fail = ""));
  await page.getByRole("button", { name: "重试本地读取" }).click();
  await page.getByText("跟随查询日期 2026-11-10", { exact: false }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "涨跌停按日浏览器：1024宽无横溢/键盘展开明细/缺失与0/切日/未配置/无历史/本地重试通过",
  );
} finally {
  await browser?.close();
}
