/** 通达信本地涨跌停与涨跌家数面板：真实组件 + esbuild 夹具。 */
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
    const emptyBreadth={state:'no-history',latest:null,sourceFirst:null,sourceLast:null,window:null,points:[],duplicates:[],warning:'本地源没有 SC31 的有效日期记录'};
    const breadth=(points,duplicates=[])=>({
      ...emptyBreadth,state:'ok',sourceFirst:'2018-08-17',sourceLast:'2026-11-17',
      latest:points.at(-1).date,window:{start:points[0].date,end:points.at(-1).date,count:points.length},
      points,duplicates,warning:null
    });
    const datasets={
      '2026-11-18':{state:'ok',sourceFirst:'2018-08-17',sourceLast:'2026-11-18',latest:'2026-11-18',window:{start:'2026-11-16',end:'2026-11-18',count:3},points:[
        {date:'2026-11-16',limitUp:10,limitDown:0},
        {date:'2026-11-17',limitUp:null,limitDown:5},
        {date:'2026-11-18',limitUp:42,limitDown:40}],
        duplicates:[{group:3,field:'limitUp',date:'2026-11-17',count:2}],
        breadth:breadth([
          {date:'2026-11-12',up:0,down:2400},
          {date:'2026-11-13',up:1800,down:2600},
          {date:'2026-11-14',up:null,down:null},
          {date:'2026-11-16',up:null,down:0},
          {date:'2026-11-17',up:3200,down:1300}
        ],[{date:'2026-11-14',count:2}])},
      '2026-11-10':{state:'ok',sourceFirst:'2018-08-17',sourceLast:'2026-11-18',latest:'2026-11-10',window:{start:'2026-11-09',end:'2026-11-10',count:2},points:[
        {date:'2026-11-09',limitUp:7,limitDown:3},
        {date:'2026-11-10',limitUp:8,limitDown:4}],duplicates:[],
        breadth:breadth([{date:'2026-11-09',up:900,down:3600}])}
    };
    const base=(date)=>({version:'limit-history-1',source:'通达信本地',scope:'本地',filename:'gpsh999999.dat',requestedDate:date,latest:null,sourceFirst:'2018-08-17',sourceLast:'2026-11-18',window:null,points:[],duplicates:[],breadth:emptyBreadth,warning:null,loadedAt:1,generatedAt:1});
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

  const limitPanel = page.getByRole("region", { name: "涨跌停按日" });
  const breadthPanel = page.getByRole("region", { name: "涨跌家数按日" });
  const noPageOverflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  await limitPanel.getByText("跟随查询日期 2026-11-18").waitFor();
  await limitPanel
    .getByText("显示 2026-11-16 ~ 2026-11-18", { exact: false })
    .waitFor();
  await breadthPanel
    .getByText("显示 2026-11-12 ~ 2026-11-17", { exact: false })
    .waitFor();
  const limitBounds = await limitPanel.boundingBox();
  const breadthBounds = await breadthPanel.boundingBox();
  assert.ok(
    limitBounds &&
      breadthBounds &&
      breadthBounds.y >= limitBounds.y + limitBounds.height,
    "涨跌家数应显示在涨跌停下方",
  );
  assert.deepEqual(await page.evaluate(() => window.limitFixture.requests), [
    { date: "2026-11-18" },
  ]);
  assert.equal(await noPageOverflow(), true, "1024 宽窗口不得横向溢出");
  // 键盘展开原生 details，核对精确数值、真实 0 与歧义缺失。
  await limitPanel.locator("summary").focus();
  await page.keyboard.press("Enter");
  const table = limitPanel.getByRole("table", {
    name: "通达信本地涨跌停逐日明细",
  });
  await table.waitFor();
  assert.equal(await table.locator("tbody tr").count(), 3);
  const rows = await table.locator("tbody tr").allInnerTexts();
  assert.match(rows.join("\n"), /2026-11-17.*歧义（重复）.*5/s);
  assert.match(rows.join("\n"), /2026-11-16.*10.*0/s);

  const breadthChart = breadthPanel.getByRole("img", {
    name: "2026-11-12 至 2026-11-17 通达信本地上涨与下跌家数曲线",
  });
  await breadthChart.waitFor();
  assert.equal(await breadthChart.evaluate((chart) => chart.localName), "svg");
  assert.equal(
    await breadthPanel.getByText("上涨 3200 家", { exact: true }).count(),
    1,
  );
  assert.equal(
    await breadthPanel.getByText("下跌 1300 家", { exact: true }).count(),
    1,
  );
  // 两条曲线都连接有效点，遇到缺失分段；真实 0 有各自的基线圆点。
  const paths = await breadthChart
    .locator("path")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("d") ?? ""));
  assert.equal(paths.length, 2);
  assert.deepEqual(
    paths.map((path) => path.match(/[ML]/g)?.join("")),
    ["MLM", "MLML"],
  );
  const zero = await breadthChart.locator("line").getAttribute("y1");
  assert.ok(zero);
  assert.equal(await breadthChart.locator(`circle[cy="${zero}"]`).count(), 2);

  const breadthTable = breadthPanel.getByRole("table", {
    name: "通达信本地涨跌家数逐日明细",
  });
  assert.equal(await breadthTable.isVisible(), false);
  await breadthPanel.locator("summary").focus();
  await page.keyboard.press("Enter");
  await breadthTable.waitFor();
  assert.deepEqual(
    await breadthTable
      .locator("tbody tr")
      .evaluateAll((bodyRows) =>
        bodyRows.map((row) => Array.from(row.cells, (cell) => cell.innerText)),
      ),
    [
      ["2026-11-17", "3200", "1300"],
      ["2026-11-16", "缺失", "0"],
      ["2026-11-14", "歧义（重复）", "歧义（重复）"],
      ["2026-11-13", "1800", "2600"],
      ["2026-11-12", "0", "2400"],
    ],
  );
  assert.equal(
    await noPageOverflow(),
    true,
    "1024px 展开两个明细表后无横向溢出",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await noPageOverflow(),
    true,
    "窄屏展开明细时页面不得横向溢出，表格应在自身容器内滚动",
  );
  await page.setViewportSize({ width: 1024, height: 900 });

  // 切日必须换成新曲线，不能保留上一个日期。
  await page.getByRole("button", { name: "切到 11-10" }).click();
  await limitPanel.getByText("跟随查询日期 2026-11-10").waitFor();
  await breadthPanel
    .getByRole("img", {
      name: "2026-11-09 至 2026-11-09 通达信本地上涨与下跌家数曲线",
    })
    .waitFor();
  assert.equal(await page.getByText("2026-11-16", { exact: false }).count(), 0);

  // 未配置与无历史各自可辨识。
  await page.getByRole("button", { name: "未配置" }).click();
  await page.getByText("通达信本地目录尚未配置", { exact: false }).waitFor();
  await page.getByRole("button", { name: "无历史" }).click();
  await limitPanel
    .getByText("所选日期及之前没有记录", { exact: false })
    .waitFor();
  await breadthPanel.getByText("本地源没有 SC31 的有效日期记录").waitFor();

  // 错误与重试只作用于本地读取。
  await page.evaluate(() => {
    window.limitFixture.mode = "ok";
    window.limitFixture.fail = "1";
    window.limitInvalidate();
  });
  await page.getByText("受控本地读取失败", { exact: false }).waitFor();
  await page.evaluate(() => (window.limitFixture.fail = ""));
  await page.getByRole("button", { name: "重试本地读取" }).click();
  await limitPanel.getByText("跟随查询日期 2026-11-10").waitFor();
  await breadthPanel.getByText("跟随查询日期 2026-11-10").waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "涨跌停与涨跌家数按日：独立日期/双曲线/键盘展开明细/缺失、重复和0/1024px无横溢/本地重试通过",
  );
} finally {
  await browser?.close();
}
