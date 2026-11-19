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
    const f=window.limitFixture={requests:[],conceptRequests:[],sentimentCalls:0};
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
    const data={available:true,final:false,date:'${today}',fetchedAt:1700000000000,stats,pools:{zt,zb,dt:[],yzt:[]},
      ladder:[{height:2,count:2,names:['乙','戊']}],
      industries:[{name:'半导体',count:5},{name:'电池',count:2}]};
    const conceptRows={status:'ready',date:'${today}',poolFetchedAt:1700000000000,blocksObservedAt:1700000001000,
      limitUp:7,mapped:6,uncovered:1,
      concepts:[
        {code:'880001',name:'概念甲',symbols:['sh600005','sh600002','sh600001']},
        {code:'880002',name:'概念乙',symbols:['sh600002','sz000001']},
        {code:'880003',name:'概念丙',symbols:['sh600003','sh600004']}
      ]};
    export const api={
      limitSentiment:{useQuery(input,options){return useQuery({queryKey:['limitSentiment',input],...options,queryFn:async()=>{f.requests.push(input);if(f.sentimentCalls++>0)data.fetchedAt+=1000;return {...data};}});}},
      limitConcepts:{useQuery(input,options){return useQuery({queryKey:['limitConcepts',input],...options,queryFn:async()=>{f.conceptRequests.push(input);return input.fetchedAt===1700000000000?conceptRows:{status:'sync-required',date:input.date,poolFetchedAt:null,blocksObservedAt:null,limitUp:0,mapped:null,uncovered:null,concepts:[],message:'当前四池确认集已刷新或不在本进程；请用行情刷新后重新展开概念分布。'};}});}},
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

  // 概念分布按需读取：未展开不读取本机名单。
  assert.equal(
    await page.evaluate(() => window.limitFixture.conceptRequests.length),
    0,
  );
  assert.equal(
    await page.getByText("涨停概念分布", { exact: false }).count(),
    1,
  );
  // 原生按钮键盘可达：聚焦后按 Enter 展开。
  await page.getByRole("button", { name: "展开概念分布" }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByText("涨停 7 只 · 有概念映射 6 只 · 未覆盖 1 只", { exact: false })
    .waitFor();
  assert.match(
    await page.getByText("四池读取于", { exact: false }).first().innerText(),
    /本机概念名单读取于/,
  );
  const conceptCalls = await page.evaluate(
    () => window.limitFixture.conceptRequests,
  );
  assert.equal(conceptCalls.length, 1);
  assert.deepEqual(Object.keys(conceptCalls[0]).sort(), ["date", "fetchedAt"]);
  assert.equal(conceptCalls[0].date, today);
  assert.equal(conceptCalls[0].fetchedAt, 1700000000000);
  // 概念行按家数降序；同数沿用源顺序（乙在丙前）。
  assert.deepEqual(
    await page
      .getByRole("group", { name: "涨停概念分布列表" })
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      ),
    [
      "筛选概念甲概念涨停，按首封时间升序",
      "筛选概念乙概念涨停，按首封时间升序",
      "筛选概念丙概念涨停，按首封时间升序",
    ],
  );

  // 先叠加连板高度，再点概念：必须同时清掉行业和高度。
  await page.getByRole("button", { name: "筛选2连板涨停股" }).click();
  await page
    .getByText("筛选后 2 / 7 只 · 半导体 · 2板 · 首封时间升序", {
      exact: false,
    })
    .waitFor();
  await page
    .getByRole("button", { name: "筛选概念甲概念涨停，按首封时间升序" })
    .click();
  const conceptMeta = page.getByText(
    "筛选后 3 / 7 只 · 概念 概念甲 · 首封时间升序",
    { exact: false },
  );
  await conceptMeta.waitFor();
  const conceptMetaText = await conceptMeta.innerText();
  assert.ok(!conceptMetaText.includes("半导体"));
  assert.ok(!conceptMetaText.includes("2板"));
  const conceptNames = await page
    .getByRole("table", { name: "涨停池" })
    .locator(".nc-table-row")
    .evaluateAll((rows) => rows.map((r) => r.innerText.split(" · ")[0]));
  assert.deepEqual(conceptNames, ["乙", "戊", "甲"]);
  assert.equal(conceptNames.length, 3, "概念行 3 家应与打开表一致");
  assert.equal(
    await page
      .getByRole("button", { name: "筛选概念甲概念涨停，按首封时间升序" })
      .getAttribute("aria-pressed"),
    "true",
  );

  // 选择行业清概念。
  await page
    .getByRole("button", { name: "打开电池行业涨停，按首封时间升序" })
    .click();
  const industryMeta = page.getByText("筛选后 2 / 7 只 · 电池 · 首封时间升序", {
    exact: false,
  });
  await industryMeta.waitFor();
  assert.ok(!(await industryMeta.innerText()).includes("概念"));

  // 点概念乙：清掉电池行业，表内 2 家与概念行一致。
  await page
    .getByRole("button", { name: "筛选概念乙概念涨停，按首封时间升序" })
    .click();
  const conceptBMeta = page.getByText(
    "筛选后 2 / 7 只 · 概念 概念乙 · 首封时间升序",
    { exact: false },
  );
  await conceptBMeta.waitFor();
  assert.ok(!(await conceptBMeta.innerText()).includes("电池"));
  assert.deepEqual(
    await page
      .getByRole("table", { name: "涨停池" })
      .locator(".nc-table-row")
      .evaluateAll((rows) => rows.map((r) => r.innerText.split(" · ")[0])),
    ["乙", "己"],
  );

  // 切到炸板池只清离开池的概念，不重置该池自己的分页/筛选记忆。
  await poolGroup.getByRole("radio", { name: "炸板 2" }).click();
  await page.getByText("筛选后 2 / 2 只", { exact: false }).waitFor();
  assert.equal(
    await page.getByText("概念 概念乙", { exact: false }).count(),
    0,
  );

  // 炸板池点连板梯回涨停池，不得带回上个概念。
  await page.getByRole("button", { name: "筛选2连板涨停股" }).click();
  const ladderMeta = page.getByText("筛选后 2 / 7 只 · 2板 · 首封时间升序", {
    exact: false,
  });
  await ladderMeta.waitFor();
  assert.ok(!(await ladderMeta.innerText()).includes("概念"));
  assert.deepEqual(
    await page
      .getByRole("table", { name: "涨停池" })
      .locator(".nc-table-row")
      .evaluateAll((rows) => rows.map((r) => r.innerText.split(" · ")[0])),
    ["乙", "戊"],
  );

  // 恢复半导体行业，供后面的切池保留断言使用。
  await page
    .getByRole("button", { name: "打开半导体行业涨停，按首封时间升序" })
    .click();
  await page
    .getByText("筛选后 5 / 7 只 · 半导体 · 首封时间升序", { exact: false })
    .waitFor();

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

  // 选中概念后刷新：新键尚未完成时显示同步状态与刷新入口，不显示筛选后 0。
  await page
    .getByRole("button", { name: "筛选概念甲概念涨停，按首封时间升序" })
    .click();
  await page
    .getByText("筛选后 3 / 7 只 · 概念 概念甲 · 首封时间升序", { exact: false })
    .waitFor();
  await page.getByRole("button", { name: "刷新" }).click();
  await page
    .getByText("当前四池确认集已刷新或不在本进程", { exact: false })
    .first()
    .waitFor();
  await page
    .getByText("概念 概念甲 · 概念成员未就绪", { exact: false })
    .waitFor();
  assert.equal(await page.getByText("筛选后 0", { exact: false }).count(), 0);
  assert.equal(await page.getByText("有概念映射", { exact: false }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "刷新行情" }).count(), 1);
  assert.deepEqual(
    await page.evaluate(() =>
      window.limitFixture.conceptRequests.map((r) => r.fetchedAt),
    ),
    [1700000000000, 1700000001000],
  );

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
  // 历史日期不展示概念分布，也不新增概念读取。
  assert.equal(
    await page.getByText("涨停概念分布", { exact: false }).count(),
    0,
  );
  assert.equal(
    await page.evaluate(() => window.limitFixture.conceptRequests.length),
    2,
  );
  assert.deepEqual(
    await page.evaluate(() => window.limitFixture.requests.map((r) => r.date)),
    [today, today, previous],
  );
  assert.deepEqual(errors, []);
  console.log(
    "涨停首封下钻：行业与概念按需下钻/概念人数与表一致/清行业高度/切池只清离开概念/刷新同步不冒充空表/改日期清空通过",
  );
} finally {
  await browser?.close();
}
