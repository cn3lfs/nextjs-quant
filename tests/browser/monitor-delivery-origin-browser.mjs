/** Synthetic MonitorWorkspace + TanStack Query; no DB, server or real notifications. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");

// Clearly synthetic data: 20 newer failed deliveries fill page 1, and page 2
// holds a valid manual resend, a self-referencing resend and an old resend with
// no source. The original d-origin record is deliberately absent from every
// list and only exists behind the exact-id detail read.
const stub = `
import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
const channel={id:'ch-syn',name:'合成渠道',type:'webhook',enabled:true,configured:true,target:'https://example.invalid/hook',targetHint:'ht…ok',destinationVersion:'v1'};
const NOW=1700000000000;
const fill=Array.from({length:20},(_,i)=>({id:'d-fill-'+String(i).padStart(2,'0'),title:'合成填充投递 '+String(i+1).padStart(2,'0'),status:'failed',createdAt:NOW+i,manualRetry:false,channelId:channel.id,error:'合成失败'}));
const specials=[
 {id:'d-resend',title:'合成人工重发记录',status:'failed',createdAt:NOW-1,manualRetry:true,sourceDeliveryId:'d-origin',channelId:channel.id,error:'合成失败'},
 {id:'d-self',title:'合成自引用重发',status:'failed',createdAt:NOW-2,manualRetry:true,sourceDeliveryId:'d-self',channelId:channel.id,error:null},
 {id:'d-old',title:'合成旧人工记录',status:'failed',createdAt:NOW-3,manualRetry:true,channelId:channel.id,error:null}
];
const origin={id:'d-origin',title:'合成原通知（成功）',status:'sent',createdAt:NOW-10,manualRetry:false,channelId:channel.id,error:null};
const list=[...fill,...specials];
const f=window.monitorFixture={rows:list,detailRequests:[],pageRequests:[],mutations:[],originNull:false,
 byId:Object.fromEntries([...list,origin].map(r=>[r.id,{...r,body:'合成正文 '+r.id,attempts:1,remoteId:null,decisions:[],policyDecisionIds:[],channel}]))};
async function run(name,input){
 if(name==='alertStatus')return {mode:'shadow',runtime:{lastCheck:NOW,error:null},gaps:[]};
 if(name==='monitorWorkspaceSummary')return {enabledMonitors:0,todaySignals:0,todaySent:0,failedDeliveries:23,pausedSymbolInstances:0,activeDeliveries:0,assessedAt:NOW};
 if(name==='channels')return structuredClone([channel]);
 if(name==='deliveryWorkspacePage'){
   f.pageRequests.push(structuredClone(input??{}));
   const q=input??{};
   let rows=f.rows.slice().sort((a,b)=>b.createdAt-a.createdAt);
   if(q.status)rows=rows.filter(r=>r.status===q.status);
   if(q.channelId)rows=rows.filter(r=>r.channelId===q.channelId);
   if(q.query)rows=rows.filter(r=>r.title.includes(q.query));
   const start=q.cursor?Number(q.cursor):0;
   const items=rows.slice(start,start+20);
   const more=rows.length>start+20;
   return structuredClone({items,hasMore:more,nextCursor:more?String(start+20):null});
 }
 if(name==='deliveryWorkspaceDetail'){
   f.detailRequests.push(input);
   if(f.originNull&&input==='d-origin')return null;
   return structuredClone(f.byId[input]??null);
 }
 if(name==='monitorWorkspaceDetail'||name==='signalWorkspaceDetail')return null;
 if(name==='monitorWorkspacePage'||name==='signalWorkspacePage')return {items:[],hasMore:false,nextCursor:null};
 if(name==='monitorWorkspaceExport')return {schemaVersion:1,kind:input&&input.kind,value:null};
 return null;
}
function q(name){return {useQuery(input,options){return useQuery({queryKey:[name,input],retry:false,...options,queryFn:()=>run(name,input)})}}}
function m(name){return {useMutation(config){return useMutation({mutationFn:async v=>{f.mutations.push({name,v});throw Error('合成环境不写入')},...config})}}}
export const api={
 alertStatus:q('alertStatus'),monitorWorkspaceSummary:q('monitorWorkspaceSummary'),channels:q('channels'),
 monitorWorkspacePage:q('monitorWorkspacePage'),signalWorkspacePage:q('signalWorkspacePage'),deliveryWorkspacePage:q('deliveryWorkspacePage'),
 monitorWorkspaceDetail:q('monitorWorkspaceDetail'),signalWorkspaceDetail:q('signalWorkspaceDetail'),deliveryWorkspaceDetail:q('deliveryWorkspaceDetail'),
 monitorWorkspaceExport:q('monitorWorkspaceExport'),
 monitorWorkspaceToggle:m('toggle'),deliveryWorkspaceConfirm:m('confirm'),monitorWorkspaceSave:m('save'),
 useUtils(){const client=useQueryClient();const entry=name=>({invalidate(){return client.invalidateQueries({queryKey:[name]})},refetch(){return client.refetchQueries({queryKey:[name]})},fetch(input){return client.fetchQuery({queryKey:[name,input],queryFn:()=>run(name,input)})},reset(){return client.resetQueries({queryKey:[name]})}});return {monitorWorkspaceSummary:entry('monitorWorkspaceSummary'),monitorWorkspacePage:entry('monitorWorkspacePage'),signalWorkspacePage:entry('signalWorkspacePage'),deliveryWorkspacePage:entry('deliveryWorkspacePage'),monitorWorkspaceDetail:entry('monitorWorkspaceDetail'),monitorWorkspaceExport:entry('monitorWorkspaceExport')}}
};
`;

// Mirrors Next's native history integration for this component: pushState /
// replaceState update the pathname/search snapshot, while only Back/Forward
// dispatch popstate (which the workspace reads).
const navigation = `
import {useSyncExternalStore} from 'react';
for(const name of ['pushState','replaceState']){
  const original=window.history[name].bind(window.history);
  window.history[name]=(data,unused,url)=>{original(data,unused,url);window.dispatchEvent(new Event('next-navigation'))};
}
function subscribe(listener){
  window.addEventListener('popstate',listener);
  window.addEventListener('next-navigation',listener);
  return ()=>{window.removeEventListener('popstate',listener);window.removeEventListener('next-navigation',listener)};
}
export function usePathname(){return useSyncExternalStore(subscribe,()=>window.location.pathname,()=>window.location.pathname)}
export function useSearchParams(){const search=useSyncExternalStore(subscribe,()=>window.location.search,()=>window.location.search);return new URLSearchParams(search)}
export function useRouter(){return {push(){},replace(){},back(){window.history.back()},forward(){window.history.forward()},refresh(){}}}
`;

const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {MonitorWorkspace} from './src/components/signals/monitor-workspace';const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><MonitorWorkspace watchlist={['sh600000']}/></QueryClientProvider>);`,
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
      name: "harness",
      setup(b) {
        b.onResolve({ filter: /^next\/navigation$/ }, () => ({
          path: "navigation",
          namespace: "next-navigation",
        }));
        b.onLoad({ filter: /.*/, namespace: "next-navigation" }, () => ({
          contents: navigation,
          loader: "ts",
          resolveDir: process.cwd(),
        }));
        b.onResolve({ filter: /^next\/link$/ }, () => ({
          path: "link",
          namespace: "next-link",
        }));
        b.onLoad({ filter: /.*/, namespace: "next-link" }, () => ({
          contents:
            'import React from "react";export default function Link({prefetch,...props}){return <a {...props}/>}',
          loader: "tsx",
          resolveDir: process.cwd(),
        }));
        b.onLoad({ filter: /trpc[\\/]react\.tsx$/ }, () => ({
          contents: stub,
          loader: "tsx",
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});
const script = bundle.outputFiles[0].text;

const origin = "http://127.0.0.1";
const search = encodeURIComponent(JSON.stringify({ query: "", status: "failed" }));
const start = `${origin}/system/notifications?monitorTab=deliveries&monitorFilters=${search}`;
const record = () =>
  new URLSearchParams(location.search).get("monitorRecord");
const filters = (page) =>
  new URLSearchParams(new URL(page.url()).search).get("monitorFilters");

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
    });
    try {
      // Verified session cursor: applied delivery filter on page 2.
      sessionStorage.setItem(
        'monitor-pages:deliveries:{"query":"","status":"failed"}',
        '[null,"20"]',
      );
    } catch {}
  });
  const requests = [];
  await page.route("**/*", (route) => {
    const url = route.request().url();
    requests.push(url);
    assert.ok(url.startsWith(`${origin}/`), `非 loopback 请求：${url}`);
    return route.fulfill({
      contentType: "text/html",
      body: '<meta charset="utf-8"><div id="root"></div>',
    });
  });
  await page.goto(start);
  await page.addScriptTag({ content: script });

  const list = page.locator('[aria-label="投递列表"] button');
  const open = () => page.getByRole("button", { name: "查看原投递", exact: true });
  const detailIds = () =>
    page.evaluate(() => window.monitorFixture.detailRequests.slice());
  const pageRequests = () =>
    page.evaluate(() => window.monitorFixture.pageRequests.slice());

  // Page 2 under the applied "failed" filter.
  await page.getByText("第 2 页", { exact: true }).waitFor();
  assert.equal((await page.getByLabel("投递状态筛选").textContent())?.trim(), "失败");
  await page.getByText("投递状态：失败", { exact: true }).waitFor();
  assert.equal(await list.count(), 3);

  // Select the manual resend; its detail loads the exact record.
  await list.filter({ hasText: "合成人工重发记录" }).click();
  await page
    .getByRole("heading", { name: "合成人工重发记录" })
    .waitFor();
  await page.waitForFunction(
    () => new URLSearchParams(location.search).get("monitorRecord") === "d-resend",
  );
  assert.deepEqual(await detailIds(), ["d-resend"]);
  await page.getByText("原投递：d-origin", { exact: true }).waitFor();
  await open().waitFor();

  const beforeDetail = (await detailIds()).length;
  const beforePages = (await pageRequests()).length;
  const beforeFilters = filters(page);
  await open().click();

  // The source opens by its exact id; no list, filter or page change.
  await page
    .getByRole("heading", { name: "合成原通知（成功）" })
    .waitFor();
  await page.waitForFunction(
    () => new URLSearchParams(location.search).get("monitorRecord") === "d-origin",
  );
  const added = (await detailIds()).slice(beforeDetail);
  assert.ok(added.length >= 1, "缺少源详情读取");
  assert.ok(
    added.every((id) => id === "d-origin"),
    `读取了非源记录：${added.join(",")}`,
  );
  const laterPages = (await pageRequests()).slice(beforePages);
  assert.ok(
    laterPages.every((input) => input.status === "failed" && input.cursor === "20"),
    `列表筛选或页码被改写：${JSON.stringify(laterPages)}`,
  );
  assert.equal(filters(page), beforeFilters);
  assert.equal(
    new URLSearchParams(new URL(page.url()).search).get("monitorTab"),
    "deliveries",
  );
  await page.getByText("第 2 页", { exact: true }).waitFor();
  assert.equal(await list.count(), 3);

  // Back restores the resend at the same filter and page; Forward returns.
  await page.evaluate(() => history.back());
  await page.waitForFunction(
    () => new URLSearchParams(location.search).get("monitorRecord") === "d-resend",
  );
  await page.getByRole("heading", { name: "合成人工重发记录" }).waitFor();
  await page.getByText("第 2 页", { exact: true }).waitFor();
  assert.equal(await list.count(), 3);
  await page.evaluate(() => history.forward());
  await page.waitForFunction(
    () => new URLSearchParams(location.search).get("monitorRecord") === "d-origin",
  );
  await page.getByRole("heading", { name: "合成原通知（成功）" }).waitFor();

  // A same-session reload keeps the deep link, filter and page.
  await page.reload();
  await page.addScriptTag({ content: script });
  await page.getByRole("heading", { name: "合成原通知（成功）" }).waitFor();
  assert.equal(
    new URLSearchParams(new URL(page.url()).search).get("monitorRecord"),
    "d-origin",
  );
  await page.getByText("第 2 页", { exact: true }).waitFor();
  await page.getByText("投递状态：失败", { exact: true }).waitFor();
  assert.equal(await list.count(), 3);

  // A missing source shows the existing empty state and Back still returns.
  await page.evaluate(() => history.back());
  await page.getByRole("heading", { name: "合成人工重发记录" }).waitFor();
  await page.evaluate(() => (window.monitorFixture.originNull = true));
  await open().click();
  await page
    .getByText("记录不存在或已被清理，请返回列表刷新。", { exact: true })
    .waitFor();
  assert.match(page.url(), /monitorRecord=d-origin/);
  await page.evaluate(() => history.back());
  await page.getByRole("heading", { name: "合成人工重发记录" }).waitFor();
  await page.getByText("第 2 页", { exact: true }).waitFor();
  assert.equal(await list.count(), 3);

  // An old resend without a source keeps its text and offers no action.
  const beforeOld = (await detailIds()).length;
  await list.filter({ hasText: "合成旧人工记录" }).click();
  await page.getByRole("heading", { name: "合成旧人工记录" }).waitFor();
  await page
    .getByText("旧人工记录未保存原投递ID，无法追溯具体来源。", { exact: true })
    .waitFor();
  assert.equal(await open().count(), 0);
  assert.deepEqual((await detailIds()).slice(beforeOld), ["d-old"]);

  // A self-referencing source shows the untraceable note and never navigates.
  const beforeSelf = (await detailIds()).length;
  await list.filter({ hasText: "合成自引用重发" }).click();
  await page.getByRole("heading", { name: "合成自引用重发" }).waitFor();
  await page.getByText("原投递：d-self", { exact: true }).waitFor();
  await page
    .getByText("原投递ID无效或指向当前记录，无法追溯到具体来源。", {
      exact: true,
    })
    .waitFor();
  assert.equal(await open().count(), 0);
  assert.deepEqual((await detailIds()).slice(beforeSelf), ["d-self"]);

  assert.deepEqual(
    await page.evaluate(() => window.monitorFixture.mutations),
    [],
  );
  assert.ok(
    requests.every((url) => url.startsWith(`${origin}/`)),
    "出现非 loopback 请求",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: delivery origin link, exact source read, Back/Forward/reload and no-action boundaries",
  );
} finally {
  await browser.close();
}
