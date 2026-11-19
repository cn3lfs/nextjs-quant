/** 涨停行业下钻：真实 LimitUpView + esbuild 夹具，无服务端/数据库。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "@playwright/test";

const shanghai = () => new Date(Date.now() + 8 * 3600000);
const today = shanghai().toISOString().slice(0, 10);
const previous = new Date(shanghai().getTime() - 86400000)
  .toISOString()
  .slice(0, 10);

let browser;
try {
  const transport = `
    import {useQuery} from '@tanstack/react-query';
    const f=window.limitFixture={requests:[]};
    const stats={breakRate:null,maxHeight:2,promotionRate:null,limitUp:7,broken:2,limitDown:0,yesterdayAvgChange:null};
    const row=(symbol,name,firstSeal,industry,changePct=10,streak=1)=>({symbol,name,price:10,changePct,amount:1e8,floatCap:5e9,turnover:8,industry,streak,firstSeal,lastSeal:'14:59:59',sealFund:2e7,breaks:0,limitPrice:11,stat:'1天1板'});
    const zt=[
      row('sh600001','甲','09:31:02','半导体'),
      row('sh600002','乙','09:30:05','半导体',10,2),
      row('sh600003','丙','09:31:02','半导体'),
      row('sh600004','丁','99:99:99','半导体'),
      row('sh600005','戊','09:30:05','半导体',10,2),
      row('sz000001','己','10:00:00','电池'),
      row('sz000002','庚',null,'电池')
    ];
    const zb=[row('sz000003','辛','09:40:00','半导体',3),row('sz000004','壬',null,'电池',2)];
    const data={available:true,final:false,date:'${today}',stats,pools:{zt,zb,dt:[],yzt:[]},
      ladder:[{height:2,count:2,names:['乙','戊']}],
      industries:[{name:'半导体',count:5},{name:'电池',count:2}]};
    export const api={
      limitSentiment:{useQuery(input,options){return useQuery({queryKey:['limitSentiment',input],...options,queryFn:async()=>{f.requests.push(input);return data;}});}},
      limitHistory:{useQuery(input,options){return useQuery({queryKey:['limitHistory',input],...options,queryFn:async()=>({state:'source-unconfigured',requestedDate:input.date,points:[],duplicates:[]})});}}
    };
  `;
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {LimitUpView} from './src/components/market/limit-up-view';
      const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><LimitUpView/></QueryClientProvider>);`,
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
        name: "limit-up-transport",
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
  // 从炸板池开始，验证点行业一次就进入涨停池。
  await page.addInitScript(() =>
    localStorage.setItem(
      "nq-limit-up",
      JSON.stringify({ state: { pool: "zb" }, version: 0 }),
    ),
  );
  await page.route("**/*", (route) => {
    assert.equal(route.request().url(), "http://127.0.0.1/limit-up-fixture");
    return route.fulfill({
      contentType: "text/html",
      body: '<meta charset="utf-8"><div id="root" style="padding:16px"></div>',
    });
  });
  await page.goto("http://127.0.0.1/limit-up-fixture");
  await page.addStyleTag({ content: css.css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  await page.getByText("已查询", { exact: false }).waitFor();
  assert.equal(
    await page.getByText("盘中观测走势", { exact: false }).count(),
    0,
    "旧响应没有 intraday 时不得挂载盘中图",
  );
  const poolGroup = page.getByRole("radiogroup", { name: "涨停板池" });
  await page.getByRole("radio", { name: "炸板 2" }).waitFor();
  assert.equal(
    await page
      .getByRole("radio", { name: "炸板 2" })
      .getAttribute("aria-checked"),
    "true",
  );
  // 非涨停池没有首封排序选项。
  await page.getByRole("combobox", { name: "当前池排序" }).click();
  await page.getByRole("option", { name: "来源顺序" }).waitFor();
  assert.equal(
    await page.getByRole("option", { name: "首封时间升序" }).count(),
    0,
  );
  await page.keyboard.press("Escape");

  // 先按连板高度筛出子集，再点行业：必须清除旧高度，展示整个行业。
  await page.getByRole("button", { name: "筛选2连板涨停股" }).click();
  await page.getByText("筛选后 2 / 7 只 · 2板", { exact: false }).waitFor();
  assert.equal(
    await page
      .getByRole("radio", { name: "涨停 7" })
      .getAttribute("aria-checked"),
    "true",
  );
  await page
    .getByRole("button", { name: "打开半导体行业涨停，按首封时间升序" })
    .click();
  await page
    .getByText("筛选后 5 / 7 只 · 半导体 · 首封时间升序", { exact: false })
    .waitFor();
  assert.equal(
    await page.getByText("2板", { exact: false }).count(),
    0,
    "点行业后不得保留上一轮的连板高度",
  );
  await page.getByText("1 只缺首封时间，已排末尾", { exact: false }).waitFor();
  assert.equal(
    await page
      .getByRole("radio", { name: "涨停 7" })
      .getAttribute("aria-checked"),
    "true",
  );
  assert.equal(
    await page.getByRole("combobox", { name: "当前池排序" }).innerText(),
    "首封时间升序",
  );
  const table = page.getByRole("table", { name: "涨停池" });
  await table.waitFor();
  const names = await table
    .locator(".nc-table-row")
    .evaluateAll((rows) => rows.map((r) => r.innerText.split(" · ")[0]));
  // 同秒保留来源顺序（乙在戊前、甲在丙前），无法解析的丁排末尾。
  assert.deepEqual(names, ["乙", "戊", "甲", "丙", "丁"]);
  assert.equal(
    await table.getByText("99:99:99").count(),
    0,
    "无效首封时间不得原样显示",
  );
  assert.equal(
    await table
      .locator(".nc-table-row")
      .filter({ hasText: "丁" })
      .locator('[role="cell"]')
      .nth(4)
      .innerText(),
    "—",
  );

  // 切到其他池：沿用该池自己的排序，不出现首封选项。
  await poolGroup.getByRole("radio", { name: "炸板 2" }).click();
  assert.equal(
    await page.getByRole("combobox", { name: "当前池排序" }).innerText(),
    "来源顺序",
  );
  await page.getByRole("combobox", { name: "当前池排序" }).click();
  await page.getByRole("option", { name: "来源顺序" }).waitFor();
  assert.equal(
    await page.getByRole("option", { name: "首封时间升序" }).count(),
    0,
  );
  await page.keyboard.press("Escape");

  // 回到涨停池，仍保留刚才的行业与首封顺序。
  await poolGroup.getByRole("radio", { name: "涨停 7" }).click();
  await page
    .getByText("筛选后 5 / 7 只 · 半导体 · 首封时间升序", { exact: false })
    .waitFor();

  // 改日期沿用现有逻辑清空行业与顺序。
  await page.getByLabel("交易日").fill(previous);
  await page.getByRole("button", { name: "查询日期" }).click();
  await page.getByText(`已查询 ${previous}`, { exact: false }).waitFor();
  await page.getByText("筛选后 7 / 7 只", { exact: false }).waitFor();
  assert.equal(
    await page.getByText("半导体 · 首封时间升序", { exact: false }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("combobox", { name: "当前池排序" }).innerText(),
    "来源顺序",
  );
  assert.deepEqual(
    await page.evaluate(() => window.limitFixture.requests.map((r) => r.date)),
    [today, previous],
  );
  assert.deepEqual(errors, []);
  console.log(
    "涨停行业首封下钻：进入涨停池/行业与缺时间提示/同秒源序/其他池无选项/切池保留/改日期清空通过",
  );
} finally {
  await browser?.close();
}
