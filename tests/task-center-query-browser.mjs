/** Actual TaskCenter and TanStack Query; controlled transport, no DB or providers. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const dir = join(tmpdir(), "logs", "quant-task-center");
mkdirSync(dir, { recursive: true });
const stub = `
import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
const items=Array.from({length:85},(_,i)=>({id:'query-'+String(i).padStart(3,'0'),type:i%2?'research':'screen',status:i===0?'running':'completed',progress:i===0?40:100,phase:'阶段'+i,createdAt:1700000000000+i,updatedAt:1700000000000+i})).reverse();
window.taskFixture={items,revision:1,requests:[],calls:[],change(id,status){const row=items.find(i=>i.id===id);row.status=status;row.updatedAt=Date.now();this.revision++},add(){items.unshift({ ...items[0],id:'query-new',createdAt:Date.now(),updatedAt:Date.now(),status:'completed'});this.revision++}};
const f=window.taskFixture;
function query(name){return {useQuery(input,options){return useQuery({queryKey:[name,input],retry:false,...options,queryFn:async()=>{
 f.requests.push({name,input,at:Date.now()});
 if(f.fail===name)throw Error('受控离线');
 if(name==='taskOverview')return {total:items.length,running:items.filter(i=>i.status==='running').length,queued:items.filter(i=>i.status==='queued').length,failed:items.filter(i=>i.status==='failed').length,cancelled:items.filter(i=>i.status==='cancelled').length,completedToday:0,revision:f.revision,checkedAt:Date.now()};
 if(name==='taskHistory'){const filtered=items.filter(i=>(!input.status||i.status===input.status)&&(!input.type||i.type===input.type)&&(!input.id||i.id===input.id));const list=filtered.filter(i=>!input.cursor||i.createdAt<input.cursor.createdAt||(i.createdAt===input.cursor.createdAt&&i.id<input.cursor.id));const page=list.slice(0,20);return structuredClone({items:page,total:filtered.length,nextCursor:list.length>20?{createdAt:page.at(-1).createdAt,id:page.at(-1).id}:null})}
 if(name==='taskState'){const row=items.find(i=>i.id===input.id);return row?structuredClone({...row,sourceLink:{href:'/screen',label:'前往来源页重新配置'}}):null}
}})}}}
export const api={taskOverview:query('taskOverview'),taskHistory:query('taskHistory'),taskState:query('taskState'),
 cancel:{useMutation(){return useMutation({mutationFn:async id=>{f.calls.push(id);if(f.holdCancel)await new Promise(resolve=>f.releaseCancel=resolve);if(f.cancelFail)throw Error('受控取消失败');f.change(id,'cancelled');return {ok:true,outcome:'accepted',status:'cancelled'}}})}},
 useUtils(){const client=useQueryClient();return Object.fromEntries(['taskOverview','taskHistory','taskState','jobs'].map(name=>[name,{invalidate(input){return client.invalidateQueries({queryKey:input?[name,input]:[name]})}}]))}
};`;
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {TaskCenter} from './src/components/workbench/task-center';import {PanelVisibility} from './src/components/workbench/keep-alive';const client=new QueryClient({defaultOptions:{queries:{retry:false}}});function App(){const [visible,setVisible]=useState(true);window.setTaskVisible=setVisible;return <QueryClientProvider client={client}><PanelVisibility visible={visible}><div hidden={!visible}><TaskCenter state={{jobs:{data:[]},selectFormulaJob(){},setTab(){}}}/></div></PanelVisibility></QueryClientProvider>};createRoot(document.getElementById('root')).render(<App/>);`,
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
      name: "transport",
      setup(b) {
        b.onLoad({ filter: /trpc[\\/]react\.tsx$/ }, () => ({
          contents: stub,
          loader: "tsx",
          resolveDir: process.cwd(),
        }));
        b.onResolve({ filter: /^next\/link$/ }, () => ({
          path: "link",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents:
            'import React from "react";export default function Link({prefetch,...props}){return <a {...props}/>}',
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
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.clock.install();
  await page.route("**/*", (route) => {
    assert.equal(route.request().url(), "http://127.0.0.1/task-query-fixture");
    return route.fulfill({
      contentType: "text/html",
      body: '<meta charset="utf-8"><div id="root" style="padding:20px"></div>',
    });
  });
  await page.goto("http://127.0.0.1/task-query-fixture");
  await page.addStyleTag({ content: css.css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const rows = page.locator('[aria-label="任务列表"] article');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 20);
  const advance = async () => {
    await page.clock.runFor(2200);
    await page.waitForTimeout(80);
  };
  await page.evaluate(() => window.taskFixture.change("query-084", "running"));
  await advance();
  await rows.first().getByText("运行中", { exact: true }).waitFor();
  await page.locator("#task-trigger-query-084").click();
  await page
    .locator("#task-detail-query-084")
    .getByRole("button", { name: "取消任务", exact: true })
    .waitFor();
  await page.evaluate(() =>
    window.taskFixture.change("query-084", "completed"),
  );
  await advance();
  await page
    .locator("#task-detail-query-084")
    .getByText("已完成 · 100%", { exact: true })
    .waitFor();
  const terminal = await page.evaluate(
    () =>
      window.taskFixture.requests.filter((r) => r.name === "taskState").length,
  );
  await page.clock.runFor(6000);
  assert.equal(
    await page.evaluate(
      () =>
        window.taskFixture.requests.filter((r) => r.name === "taskState")
          .length,
    ),
    terminal,
  );
  await page.getByRole("button", { name: "刷新任务", exact: true }).click();
  assert.equal(
    await page.locator("#task-trigger-query-084").getAttribute("aria-expanded"),
    "true",
  );
  await page.getByRole("button", { name: "下一页任务" }).click();
  await rows.first().waitFor();
  const oldIds = await rows
    .locator("button[aria-expanded]")
    .evaluateAll((nodes) => nodes.map((n) => n.id));
  await page.evaluate(() => window.taskFixture.add());
  await advance();
  assert.deepEqual(
    await rows
      .locator("button[aria-expanded]")
      .evaluateAll((nodes) => nodes.map((n) => n.id)),
    oldIds,
  );
  await page.getByRole("button", { name: "有新任务，回到最新" }).click();
  await page.locator("#task-trigger-query-new").waitFor();
  const beforeTyping = await page.evaluate(
    () =>
      window.taskFixture.requests.filter((r) => r.name === "taskHistory")
        .length,
  );
  await page.getByLabel("精确任务编号").fill("query-000");
  assert.equal(
    await page.evaluate(
      () =>
        window.taskFixture.requests.filter((r) => r.name === "taskHistory")
          .length,
    ),
    beforeTyping,
  );
  await page.getByRole("button", { name: "查找", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[aria-label="任务列表"] article').length === 1,
  );
  await page.locator("#task-trigger-query-000").click();
  const cancel = page
    .locator("#task-detail-query-000")
    .getByRole("button", { name: "取消任务", exact: true });
  await page.evaluate(() => (window.taskFixture.holdCancel = true));
  await cancel.click();
  await page.waitForFunction(() => window.taskFixture.calls.length === 1);
  assert.equal(
    await page.getByRole("button", { name: "正在提交取消…" }).isDisabled(),
    true,
  );
  await page
    .getByRole("button", { name: "正在提交取消…" })
    .dispatchEvent("click");
  assert.equal(await page.evaluate(() => window.taskFixture.calls.length), 1);
  await page.evaluate(() => window.taskFixture.releaseCancel());
  await page
    .locator("#task-detail-query-000")
    .getByText("已取消 · 40%", { exact: true })
    .waitFor();
  // No action on recovery links; they are navigation only.
  assert.equal(
    await page
      .locator("#task-detail-query-000")
      .getByRole("link", { name: "前往来源页重新配置" })
      .getAttribute("href"),
    "/screen",
  );
  await page.evaluate(() => window.setTaskVisible(false));
  await page.waitForTimeout(50);
  const hiddenAt = await page.evaluate(
    () => window.taskFixture.requests.length,
  );
  await page.clock.runFor(610000);
  assert.equal(
    await page.evaluate(() => window.taskFixture.requests.length),
    hiddenAt,
  );
  await page.evaluate(() => window.setTaskVisible(true));
  await page.waitForFunction(
    (n) => window.taskFixture.requests.length > n,
    hiddenAt,
  );
  await page.evaluate(() => {
    window.taskFixture.fail = "taskHistory";
  });
  await page.getByRole("button", { name: "刷新任务", exact: true }).click();
  await page
    .getByText("任务列表读取失败：受控离线", { exact: false })
    .waitFor();
  assert.equal(await rows.count(), 1);
  await page
    .getByText("当前为上次读取的数据，尚未刷新。", { exact: false })
    .waitFor();
  await page.evaluate(() => (window.taskFixture.fail = null));
  await page.getByRole("button", { name: "重试列表" }).click();
  for (const width of [1440, 900, 640]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: join(dir, `query-${width}.png`),
      fullPage: true,
    });
  }
  // Simulated window blur independent of cached-panel hiding.
  await page.evaluate(() => {
    window.actualHasFocus = document.hasFocus.bind(document);
    document.hasFocus = () => false;
    window.dispatchEvent(new Event("blur"));
  });
  await page.waitForTimeout(50);
  const blurredAt = await page.evaluate(
    () => window.taskFixture.requests.length,
  );
  await page.clock.runFor(65000);
  assert.equal(
    await page.evaluate(() => window.taskFixture.requests.length),
    blurredAt,
  );
  await page.evaluate(() => {
    document.hasFocus = window.actualHasFocus;
    window.dispatchEvent(new Event("focus"));
  });
  await page.waitForFunction(
    (n) => window.taskFixture.requests.length > n,
    blurredAt,
  );
  for (let n = 0; n < 20; n++) {
    await page.evaluate(() => window.setTaskVisible(false));
    await page.waitForTimeout(10);
    const before = await page.evaluate(
      () => window.taskFixture.requests.length,
    );
    await page.evaluate(() => window.setTaskVisible(true));
    await page.waitForTimeout(50);
    assert.ok(
      (await page.evaluate(() => window.taskFixture.requests.length)) -
        before <=
        3,
      "Only overview/current page/selected detail may refresh on return",
    );
  }
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page.getByLabel("任务类型", { exact: true }).click();
  await page.getByRole("option", { name: "AI 研究", exact: true }).click();
  await page.waitForFunction(() =>
    [
      ...document.querySelectorAll('[aria-label="任务列表"] article strong'),
    ].every((n) => n.textContent === "AI 研究"),
  );
  assert.ok((await rows.count()) > 0);
  await page.evaluate(() => window.taskFixture.change("query-083", "running"));
  await page.getByRole("button", { name: "刷新任务", exact: true }).click();
  await page.getByLabel("历史任务状态", { exact: true }).click();
  await page.getByRole("option", { name: "运行中", exact: true }).click();
  await page.locator("#task-trigger-query-083").click();
  await page
    .locator("#task-detail-query-083")
    .getByRole("button", { name: "取消任务", exact: true })
    .waitFor();
  await page.evaluate(() =>
    window.taskFixture.change("query-083", "completed"),
  );
  await advance();
  await page.getByText("所选任务已不在当前页或筛选结果中。").waitFor();
  assert.match(
    await page.evaluate(() => document.activeElement.textContent),
    /共 0 条/,
  );
  await page.evaluate(() => (window.taskFixture.fail = "taskOverview"));
  await page.getByRole("button", { name: "刷新任务", exact: true }).click();
  await page.getByText("统计未刷新：受控离线", { exact: false }).waitFor();
  await page.evaluate(() => (window.taskFixture.fail = null));
  await page.getByRole("button", { name: "重试统计" }).click();
  assert.deepEqual(errors, []);
  writeFileSync(
    join(dir, "query-result.json"),
    JSON.stringify({ passed: true, hiddenRequests: 0, errors }, null, 2),
  );
  console.log(
    "PASS actual Query: lifecycle, terminal stop, stable page, no typing requests, cancellation guard, hidden 610s, stale errors, responsive",
  );
} finally {
  await browser.close();
}
