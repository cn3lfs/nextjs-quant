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
    const stats={breakRate:null,maxHeight:3,promotionRate:null,limitUp:7,broken:2,limitDown:0,yesterdayAvgChange:null};
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
    // 昨日涨停池 120 只：验证渐进加载 50 → 100 → 120 与分页按钮的移除。
    const yzt=Array.from({length:120},(_,i)=>row('sz'+String(100000+i),'昨'+i,null,'半导体'));
    // 3 板名单里的“孤儿”在池内没有对应行，必须以纯文本保留。
    const data={available:true,final:false,date:'${today}',fetchedAt:1700000000000,stats,pools:{zt,zb,dt:[],yzt},
      ladder:[{height:3,count:1,names:['孤儿']},{height:2,count:2,names:['乙','戊']}],
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
    "盘中分钟走势已移除，不再挂载",
  );
  // 梯队紧跟 KPI：每只股票都是直达K线的链接，池内没有对应行的名单保留为纯文本。
  const ladder = page.getByRole("region", { name: "连板梯队" });
  await ladder.waitFor();
  assert.deepEqual(
    await ladder
      .getByRole("link")
      .evaluateAll((links) =>
        links.map((link) => [link.textContent, link.getAttribute("href")]),
      ),
    [
      ["乙 · SH600002", "/scan?symbol=sh600002"],
      ["戊 · SH600005", "/scan?symbol=sh600005"],
    ],
  );
  assert.equal(
    await ladder.getByRole("button", { name: "筛选3连板涨停股" }).innerText(),
    "3 板 · 1",
  );
  assert.equal(await ladder.getByText("孤儿", { exact: true }).count(), 1);
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
  // 概念行按家数降序，同数沿用源顺序。
  const conceptPanel = page.getByRole("region", { name: "涨停概念分布" });
  const conceptList = conceptPanel.getByRole("group", {
    name: "涨停概念分布列表",
  });
  const conceptMembers = conceptPanel.getByRole("group", {
    name: "概念对应成分股",
  });
  const conceptTable = conceptMembers.getByRole("table", {
    name: "概念成分股",
  });
  const conceptButton = (name) =>
    conceptList.getByRole("button", { name: `查看${name}概念涨停成分股` });
  const dataRows = (grid) =>
    grid.getByRole("row").filter({ has: page.getByRole("cell") });
  const stockNames = (grid) =>
    dataRows(grid).evaluateAll((rows) =>
      rows.map((row) => row.innerText.split(" · ")[0]),
    );
  async function expectMembers(name, expectedNames) {
    await conceptMembers
      .getByText(`${name} · ${expectedNames.length} 只涨停成分股`, {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await conceptButton(name).getAttribute("aria-pressed"),
      "true",
    );
    assert.deepEqual(await stockNames(conceptTable), expectedNames);
  }

  assert.deepEqual(
    await conceptList
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      ),
    [
      "查看概念甲概念涨停成分股",
      "查看概念乙概念涨停成分股",
      "查看概念丙概念涨停成分股",
    ],
  );
  // 右侧默认预览第一名，成分股按连板降序、同板数按首封时间升序。
  await expectMembers("概念甲", ["乙", "戊", "甲"]);
  const removedButton = page.getByRole("button", { name: "仅看该概念涨停池" });
  assert.equal(await removedButton.count(), 0);

  // 对同一个池逐行比对所有单元格、元数据、排序和选中的池。
  const upPool = page.getByRole("region", { name: "涨停池" });
  const combinedMeta = "筛选后 2 / 7 只 · 半导体 · 2板 · 首封时间升序";
  async function poolSnapshot(panel, grid) {
    return {
      activeTab: await poolGroup
        .getByRole("radio", { checked: true })
        .innerText(),
      meta: await panel.getByText(/^筛选后 /).innerText(),
      sort: await panel
        .getByRole("combobox", { name: "当前池排序" })
        .innerText(),
      rows: await dataRows(grid).evaluateAll((rows) =>
        rows.map((row) =>
          Array.from(
            row.querySelectorAll('[role="cell"]'),
            (cell) => cell.innerText,
          ),
        ),
      ),
    };
  }

  await ladder.getByRole("button", { name: "筛选2连板涨停股" }).click();
  await upPool.getByText(combinedMeta, { exact: true }).waitFor();
  const filteredPool = await poolSnapshot(upPool, table);
  assert.equal(filteredPool.activeTab, "涨停 7");
  assert.equal(filteredPool.meta, combinedMeta);
  assert.equal(filteredPool.rows.length, 2);
  assert.deepEqual(await stockNames(table), ["乙", "戊"]);

  for (const [name, members] of [
    ["概念甲", ["乙", "戊", "甲"]],
    ["概念乙", ["乙", "己"]],
    ["概念丙", ["丙", "丁"]],
  ]) {
    await conceptButton(name).click();
    await expectMembers(name, members);
    assert.deepEqual(await poolSnapshot(upPool, table), filteredPool, name);
    assert.equal(await removedButton.count(), 0, name);
  }

  // 在炸板池点击概念也不能切回涨停池，右表继续使用涨停成分。
  await poolGroup.getByRole("radio", { name: "炸板 2" }).click();
  const brokenPool = page.getByRole("region", { name: "炸板池" });
  const brokenTable = brokenPool.getByRole("table", { name: "炸板池" });
  await brokenPool.getByText("筛选后 2 / 2 只", { exact: true }).waitFor();
  const brokenSnapshot = await poolSnapshot(brokenPool, brokenTable);
  assert.equal(brokenSnapshot.activeTab, "炸板 2");
  await expectMembers("概念丙", ["丙", "丁"]);
  await conceptButton("概念乙").click();
  await expectMembers("概念乙", ["乙", "己"]);
  assert.deepEqual(await poolSnapshot(brokenPool, brokenTable), brokenSnapshot);
  assert.equal(await removedButton.count(), 0);

  // 梯队能从炸板池切回，并恢复涨停池原来的行业和高度。
  await ladder.getByRole("button", { name: "筛选2连板涨停股" }).click();
  await upPool.getByText(combinedMeta, { exact: true }).waitFor();
  assert.deepEqual(await poolSnapshot(upPool, table), filteredPool);

  // 行业下钻仍可切换行业并清掉高度，右侧概念维持选中。
  await page
    .getByRole("button", { name: "打开电池行业涨停，按首封时间升序" })
    .click();
  await upPool
    .getByText("筛选后 2 / 7 只 · 电池 · 首封时间升序", { exact: false })
    .waitFor();
  await expectMembers("概念乙", ["乙", "己"]);

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

  // 四池刷新使概念数据重新同步，现有池筛选与成分保持稳定。
  await conceptButton("概念甲").click();
  await expectMembers("概念甲", ["乙", "戊", "甲"]);
  const beforeRefresh = await poolSnapshot(upPool, table);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await conceptPanel
    .getByRole("status")
    .filter({ hasText: "当前四池确认集已刷新或不在本进程" })
    .waitFor();
  assert.equal(await conceptMembers.count(), 0);
  assert.equal(
    await conceptPanel.getByText("有概念映射", { exact: false }).count(),
    0,
  );
  assert.deepEqual(await poolSnapshot(upPool, table), beforeRefresh);
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

  // 120 只的昨日涨停池：分页按钮换成渐进加载，先 50 只再追加。
  // 把池标签放到窗口底部，切池后触底观察点仍在视口外。
  const yesterdayTab = poolGroup.getByRole("radio", { name: "昨日涨停 120" });
  await page.setViewportSize({ width: 1024, height: 600 });
  await yesterdayTab.evaluate((tab) => tab.scrollIntoView({ block: "end" }));
  await yesterdayTab.click();
  const yztTable = page.getByRole("table", { name: "昨日涨停池" });
  await yztTable.waitFor();
  await page.getByText("已显示 50 / 共 120 只", { exact: true }).waitFor();
  assert.equal(await dataRows(yztTable).count(), 50);
  assert.equal(await page.getByRole("button", { name: "上一页" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "下一页" }).count(), 0);

  // 键盘手动追加一批，再把观察点滚入视口触发剩余一批。
  const loadMore = page.getByRole("button", { name: "加载更多" });
  await loadMore.evaluate((button) => button.focus({ preventScroll: true }));
  await page.keyboard.press("Enter");
  await page.getByText("已显示 100 / 共 120 只", { exact: true }).waitFor();
  assert.equal(await dataRows(yztTable).count(), 100);
  await loadMore.evaluate((button) =>
    button.scrollIntoView({ block: "center" }),
  );
  await page.getByText("已显示 120 / 共 120 只", { exact: true }).waitFor();
  assert.equal(await dataRows(yztTable).count(), 120);
  assert.equal(await loadMore.count(), 0);

  assert.deepEqual(errors, []);
  console.log(
    "涨停首封下钻：盘中图移除/梯队可点开K线/概念只更新右表/行业与高度保持/切池保留筛选/刷新后概念重新同步/改日期清空/渐进加载通过",
  );
} finally {
  await browser?.close();
}
