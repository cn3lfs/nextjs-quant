import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const bundle = await build({
  stdin: {
    contents: `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client'; import {TaskCenter} from './src/components/workbench/task-center'; import {PanelVisibility} from './src/components/workbench/keep-alive'; function Fixture(){const [visible,setVisible]=useState(true); window.setTaskVisible=setVisible;return <PanelVisibility visible={visible}><TaskCenter state={{selectFormulaJob:id=>window.openedScreen=id,setTab:tab=>window.openedTab=tab}}/></PanelVisibility>}; createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "isolated-task-fixture",
      setup(b) {
        b.onResolve({ filter: /^next\/link$/ }, () => ({
          path: "link",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          loader: "tsx",
          resolveDir: process.cwd(),
          contents: `import React from 'react'; export default function Link({prefetch,children,...props}) {return <a {...props}>{children}</a>}`,
        }));
        b.onLoad({ filter: /trpc[\\/]react\.tsx$/ }, () => ({
          loader: "tsx",
          contents: `
      import {useState,useEffect} from 'react';
      const listeners = new Set();
      const bump=()=>listeners.forEach(fn=>fn(n=>n+1));
      function useRevision(){const [,set]=useState(0);useEffect(()=>{listeners.add(set);return()=>listeners.delete(set)},[])}
      window.fixture={mode:'ok',listError:false,cancelFail:true,queries:[],cancelled:[],set(values){Object.assign(this,values);bump()}};
      const f=window.fixture;
      const items=Array.from({length:22},(_,i)=>({id:'task-'+String(i).padStart(3,'0'),type:i===18?'screen':'research',status:i===19?'running':i%2?'failed':'completed',progress:i===19?45:100,phase:'阶段摘要 '+i,createdAt:1700000000000+i,updatedAt:1700000001000+i})).reverse();
      const full=id=>{const value=items.find(j=>j.id===id);return {...value,phase:'完整阶段 '+id,error:value.status==='failed'?'完整错误：证据缺失\\n'+ 'LONG_ERROR_'.repeat(80):undefined,resultLink:id==='task-020'?{href:'/reports/report/report-020',label:'查看研究报告'}:undefined,screenResultId:id==='task-018'?id:undefined,auditIncomplete:id==='task-021',attemptId:id==='task-021'?'attempt-021':undefined}};
      export const api={
        taskHistory:{useQuery(input){useRevision();const filtered=items.filter(j=>!input.status||j.status===input.status);const start=input.cursor?filtered.findIndex(j=>j.id===input.cursor.id)+1:0;const page=filtered.slice(start,start+20);return {data:f.listError?undefined:{items:page,total:filtered.length,nextCursor:start+20<filtered.length?{id:page.at(-1).id,createdAt:page.at(-1).createdAt}:null},isFetching:false,error:f.listError?{message:'列表离线'}:null,refetch:()=>{f.listError=false;bump()}}}},
        taskState:{useQuery({id},options){useRevision();f.detailEnabled=options.enabled;f.interval=options.refetchInterval({state:{data:items.find(j=>j.id===id)}});useEffect(()=>{if(options.enabled)f.queries.push(id)},[id,options.enabled]);return {data:!options.enabled||f.mode==='loading'||f.mode==='error'?undefined:f.mode==='missing'?null:full(id),isFetching:options.enabled&&f.mode==='loading',error:options.enabled&&f.mode==='error'?{message:'详情离线'}:null,refetch:()=>{f.mode='ok';bump()}}}},
        cancel:{useMutation(options){const [error,setError]=useState(null);const [variables,setVariables]=useState();return {error,variables,isPending:false,reset:()=>setError(null),mutate:id=>{setVariables(id);f.cancelled.push(id);if(f.cancelFail)setError({message:'取消请求失败'});else{items.find(j=>j.id===id).status='cancelled';setError(null);options.onSuccess({},id);bump()}}}}},
        useUtils:()=>({taskHistory:{invalidate:bump},taskState:{invalidate:bump},jobs:{invalidate:bump}})
      };
    `,
        }));
        if (process.env.TASK_CENTER_NEGATIVE === "1")
          b.onLoad(
            { filter: /components[\\/]task-history\.tsx$/ },
            async (args) => ({
              loader: "tsx",
              contents: (await readFile(args.path, "utf8")).replace(
                'setSelected(expanded ? "" : job.id)',
                "setSelected(job.id)",
              ),
            }),
          );
      },
    },
  ],
});
const css = await postcss([tailwind()]).process(
  await readFile("src/styles/globals.css", "utf8"),
  { from: resolve("src/styles/globals.css") },
);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
  });
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === "http://127.0.0.1/task-fixture")
      return route.fulfill({
        contentType: "text/html",
        body: '<meta charset="utf-8"><div id="root" style="padding:24px;max-width:1100px;margin:auto"></div>',
      });
    external.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://127.0.0.1/task-fixture");
  await page.addStyleTag({ content: css.css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const rows = page.locator('[aria-label="任务列表"] article');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 20);
  assert.deepEqual(await page.evaluate(() => window.fixture.queries), []);
  const trigger = (id) => page.locator('[id="task-trigger-' + id + '"]');
  const panel = (id) => page.locator('[id="task-detail-' + id + '"]');
  await trigger("task-021").click();
  await panel("task-021").getByText("失败原因", { exact: true }).waitFor();
  assert.ok(
    (await panel("task-021").textContent()).includes("LONG_ERROR_".repeat(80)),
  );
  assert.ok(
    (await panel("task-021").textContent()).includes("审计记录未完整保存"),
  );
  assert.equal(await trigger("task-021").getAttribute("aria-expanded"), "true");
  await trigger("task-021").press("Enter");
  assert.equal(
    await trigger("task-021").getAttribute("aria-expanded"),
    "false",
  );
  await trigger("task-020").focus();
  await page.keyboard.press("Space");
  await panel("task-020").getByRole("link", { name: "查看研究报告" }).waitFor();
  assert.equal(
    await panel("task-020").getByRole("link").getAttribute("href"),
    "/reports/report/report-020",
  );
  assert.equal(
    await page
      .locator('button[aria-expanded="true"][id^="task-trigger-"]')
      .count(),
    1,
  );
  assert.equal(await panel("task-021").isVisible(), false);
  await trigger("task-018").click();
  await panel("task-018").getByRole("button", { name: "查看选股结果" }).click();
  assert.equal(await page.evaluate(() => window.openedScreen), "task-018");
  assert.equal(await page.evaluate(() => window.openedTab), "screen");
  await trigger("task-019").click();
  assert.equal(await page.evaluate(() => window.fixture.interval), 2000);
  await page.evaluate(() => window.setTaskVisible(false));
  await page.waitForFunction(() => window.fixture.detailEnabled === false);
  assert.equal(await page.evaluate(() => window.fixture.interval), false);
  await page.evaluate(() => window.setTaskVisible(true));
  await page.waitForFunction(() => window.fixture.detailEnabled === true);
  await panel("task-019")
    .getByRole("button", { name: "取消任务", exact: true })
    .click();
  await panel("task-019").getByText("取消失败：取消请求失败").waitFor();
  await page.evaluate(() => window.fixture.set({ cancelFail: false }));
  await panel("task-019")
    .getByRole("button", { name: "取消任务", exact: true })
    .click();
  await panel("task-019").getByText("已取消 · 45%", { exact: true }).waitFor();
  assert.equal(
    await panel("task-019")
      .getByRole("button", { name: "取消任务", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "下一页任务" }).click();
  assert.equal(await rows.count(), 2);
  assert.equal(
    await rows
      .first()
      .locator("button[aria-expanded]")
      .getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(
    await page.getByRole("button", { name: "下一页任务" }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "上一页任务" }).click();
  await page.getByLabel("历史任务状态", { exact: true }).click();
  await page.getByRole("option", { name: "失败", exact: true }).click();
  assert.equal(await rows.count(), 10);
  await page.getByLabel("历史任务状态", { exact: true }).click();
  await page.getByRole("option", { name: "全部", exact: true }).click();
  assert.equal(await rows.count(), 20);
  await trigger("task-021").click();
  await page.evaluate(() => window.fixture.set({ mode: "loading" }));
  await panel("task-021").getByRole("status").waitFor();
  await page.evaluate(() => window.fixture.set({ mode: "missing" }));
  await panel("task-021")
    .getByText("任务不存在，可能已被清理。请刷新任务列表。")
    .waitFor();
  await page.evaluate(() => window.fixture.set({ mode: "error" }));
  await panel("task-021").getByRole("button", { name: "重试详情" }).click();
  await panel("task-021").getByText("失败原因", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: join(tmpdir(), "quant-task-center-mobile.png"),
  });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.screenshot({
    path: join(tmpdir(), "quant-task-center-desktop.png"),
  });
  await page.getByRole("button", { name: "刷新任务", exact: true }).click();
  assert.equal(
    await page
      .locator('button[aria-expanded="true"][id^="task-trigger-"]')
      .count(),
    0,
  );
  await page.evaluate(() => window.fixture.set({ listError: true }));
  await page.getByRole("button", { name: "重试列表" }).click();
  assert.equal(await rows.count(), 20);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "default 20+2 pagination",
        "lazy detail",
        "inline accordion",
        "keyboard Enter/Space",
        "exact report link",
        "screen result navigation",
        "cancel failure/success",
        "filter reset",
        "loading/missing/retry",
        "mobile no overflow",
        "manual refresh",
        "hidden panel pauses detail updates",
      ],
      externalRequests: external.length,
    }),
  );
} finally {
  await browser.close();
}
