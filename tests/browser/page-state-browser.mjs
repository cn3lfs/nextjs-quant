/** Actual page components, shell hook, session store and Query; no external calls. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const transport = `
import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
window.requests=[];window.mutations=[];window.failAnalysis=false;window.failStatus=false;
window.savedStatus={settings:{marketDataSource:'local',llmProvider:'deepseek'},watchlist:['sh600000'],coverage:{total:1,counts:{day:1},scannedAt:1}};
async function fetch(name,input){
 window.requests.push({name,input});
 if(name==='status'){if(window.failStatus)throw Error('fixture status failure');return window.savedStatus;}
 if(name==='taskOverview')return {running:0,queued:0,latestCompletedScan:null,checkedAt:Date.now(),revision:0};
 if(name==='securityNames')return {};
 if(name==='monitorWorkspaceSummary')return {today:'2026-11-13',failedDeliveries:0};
 if(name==='reportHistory')return {items:['sh600000','sz000001'].map(symbol=>({id:symbol,createdAt:1,securityContext:{symbol}}))};
 if(name==='signalWorkspacePage')return {items:[]};
 if(['jobs','channels','tdxQuotes'].includes(name))return [];
 return null;
}
export const api=new Proxy({}, {get:(_,name)=>name==='useUtils'?()=>{
 const client=useQueryClient();
 return new Proxy({}, {get:(_,key)=>({invalidate:()=>client.invalidateQueries({queryKey:[key]})})});
}:{
 useQuery(input,options={}){return useQuery({queryKey:[name,input],...options,queryFn:()=>fetch(name,input)})},
 useMutation(options={}){return useMutation({...options,mutationFn:async input=>{
   window.mutations.push({name,input});
   if(name==='analyze' && window.failAnalysis)throw Error('fixture research failure');
   if(!['analyze','scan'].includes(name))throw Error('unexpected mutation '+name);
   return {id:'task-fixture'};
 }})},
}});`;
const navigation = `
import {useSyncExternalStore} from 'react';
const subscribe=listener=>{window.addEventListener('popstate',listener);return()=>window.removeEventListener('popstate',listener)};
for(const name of ['pushState','replaceState']){const original=window.history[name].bind(window.history);window.history[name]=(...args)=>{original(...args);window.dispatchEvent(new PopStateEvent('popstate'))}}
const navigate=path=>window.history.pushState(null,'',path);
export const usePathname=()=>useSyncExternalStore(subscribe,()=>window.location.pathname,()=>'/backtest');
export const useRouter=()=>({push:navigate,replace:navigate});
export const useSearchParams=()=>new URLSearchParams(useSyncExternalStore(subscribe,()=>window.location.search,()=>''));`;
// Connections has its own UI harness. Keep its actual query/mutation container
// here, exposing just the scan action to isolate ownership and invalidation.
const connections = `import React from 'react';export function Connections({onScan,scanning,coverage}){
 return <><output data-testid='coverage'>{coverage?.total}</output><button disabled={scanning} onClick={onScan}>扫描测试</button></>;
}`;
const bundle = await build({
  stdin: {
    contents: `import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {usePathname,useRouter} from 'next/navigation';
import {useWorkbenchState} from './src/components/workbench/use-workbench-state';
import {WorkbenchSidebar} from './src/components/workbench/workbench-sidebar';
import {EvidenceAnalysis} from './src/components/workbench/evidence-analysis';
import {TodayOverview} from './src/components/overview/today-overview';
import {SettingsPanel} from './src/components/workbench/settings-panel';
import {PanelCache} from './src/components/workbench/keep-alive';
import {defaultStrategy} from './src/lib/domain';
window.shellRenders=0;window.researchMounts=0;window.notifications=[];window.defaultStrategy=defaultStrategy;
const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,refetchOnWindowFocus:false}}});window.client=client;
function Research(props){useEffect(()=>{window.researchMounts++},[]);return <EvidenceAnalysis {...props}/>}
const notify=text=>{window.notifications.push(text)};
function Shell(){window.shellRenders++;const state=useWorkbenchState();const path=usePathname();const router=useRouter();window.navigate=router.push;
 const [loaded,setLoaded]=useState(null);window.selectSnapshot=symbol=>setLoaded({id:'snapshot-'+symbol,symbol,period:'day',bars:[{date:'2026-11-13'}]});
 const panels=Object.fromEntries(['/backtest','/tasks','/rps','/news','/signals','/reports','/other'].map(path=>[path,<div>{path}</div>]));
 panels['/analysis']=<Research loaded={loaded} notify={notify}/>;
 panels['/settings']=<SettingsPanel notify={notify}/>;
 return <><WorkbenchSidebar active={path}/><output data-testid='route'>{path}</output><PanelCache active={path} panels={panels}/>{path==='/' && <TodayOverview/>}</>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><Shell/></QueryClientProvider>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  jsx: "automatic",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  plugins: [
    {
      name: "local-transport",
      setup(b) {
        b.onResolve({ filter: /^~\/trpc\/react$/ }, () => ({
          path: "api",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /^next\/navigation$/ }, () => ({
          path: "navigation",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /^next\/link$/ }, () => ({
          path: "link",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /^\.\/connections$/ }, () => ({
          path: "connections",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents:
            path === "api"
              ? transport
              : path === "navigation"
                ? navigation
                : path === "connections"
                  ? connections
                  : `import React from 'react';export default function Link({scroll,prefetch,...props}){return <a {...props}/>}`,
          loader: "tsx",
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});
const server = createServer((req, res) => {
  res.setHeader(
    "content-type",
    req.url === "/bundle.js" ? "text/javascript" : "text/html;charset=utf-8",
  );
  res.end(
    req.url === "/bundle.js"
      ? bundle.outputFiles[0].text
      : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/backtest`);
  const idle = () =>
    page.waitForFunction(() => window.client.isFetching() === 0);
  const navigate = async (path) => {
    await page.evaluate((path) => window.navigate(path), path);
    await page.waitForFunction(
      (path) =>
        document.querySelector('[data-testid="route"]').textContent ===
        new URL(path, window.location.href).pathname,
      path,
    );
    await idle();
  };
  await page.waitForFunction(() =>
    window.requests.some((r) => r.name === "taskOverview"),
  );
  await idle();
  const pageQueries = [
    "status",
    "securityNames",
    "channels",
    "signalWorkspacePage",
    "tdxQuotes",
    "reportHistory",
    "archivedReport",
  ];
  assert.deepEqual(
    await page.evaluate(
      (names) => window.requests.filter((r) => names.includes(r.name)),
      pageQueries,
    ),
    [],
    "cold unrelated route must not load page data",
  );

  await navigate("/analysis");
  assert.equal(
    await page
      .getByRole("button", { name: "开始研究", exact: true })
      .isDisabled(),
    true,
  );
  await page.evaluate(() => window.selectSnapshot("sh600000"));
  await page.waitForFunction(() =>
    window.requests.some(
      (r) => r.name === "archivedReport" && r.input === "sh600000",
    ),
  );
  await idle();
  const renders = await page.evaluate(() => window.shellRenders);
  await page.evaluate(() =>
    window.client.setQueryData(["status", undefined], (old) => ({
      ...old,
      settings: { ...old.settings, llmProvider: "claude" },
      coverage: { ...old.coverage, total: 99 },
      watchlist: ["sz000001"],
    })),
  );
  await page.getByText("Claude Code", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.shellRenders),
    renders,
    "coverage, watchlist and provider updates must not rerender the shell",
  );
  await page
    .getByRole("textbox", { name: "研究问题", exact: true })
    .fill("仅分析这份快照的风险");
  await page.getByRole("combobox", { name: "研究方法", exact: true }).click();
  await page
    .getByRole("option", { name: "SEPA 分阶段研究", exact: true })
    .click();
  assert.equal(
    await page.evaluate(() => window.shellRenders),
    renders,
    "editing the research draft must not rerender the shell",
  );
  await page.getByRole("button", { name: "开始研究", exact: true }).click();
  await page.waitForFunction(() =>
    window.notifications.includes("研究任务已加入队列，可在研究档案查看"),
  );
  assert.deepEqual(await page.evaluate(() => window.mutations[0]), {
    name: "analyze",
    input: {
      snapshotId: "snapshot-sh600000",
      question: "仅分析这份快照的风险",
      method: "sepa",
      strategy: await page.evaluate(() => window.defaultStrategy),
    },
  });
  assert.equal(
    await page.getByRole("link", { name: "查看研究档案" }).getAttribute("href"),
    "/reports",
  );
  await page.evaluate(() => {
    window.failAnalysis = true;
  });
  await page.getByRole("button", { name: "开始研究", exact: true }).click();
  await page.waitForFunction(() =>
    window.notifications.includes("fixture research failure"),
  );
  assert.equal(
    await page
      .getByRole("textbox", { name: "研究问题", exact: true })
      .inputValue(),
    "仅分析这份快照的风险",
  );

  await navigate("/tasks");
  await page.evaluate(async () => {
    window.requests.length = 0;
    window.selectSnapshot("sz000001");
    await window.client.invalidateQueries({ queryKey: ["reportHistory"] });
    await window.client.invalidateQueries({ queryKey: ["archivedReport"] });
  });
  await page.waitForTimeout(200);
  assert.deepEqual(
    await page.evaluate(() =>
      window.requests.filter((r) =>
        ["reportHistory", "archivedReport"].includes(r.name),
      ),
    ),
    [],
    "hidden research must not fetch a changed security or invalidated history",
  );
  await navigate("/analysis");
  await page.waitForFunction(() =>
    window.requests.some(
      (r) => r.name === "archivedReport" && r.input === "sz000001",
    ),
  );
  for (const path of [
    "/tasks",
    "/rps",
    "/news",
    "/signals",
    "/reports",
    "/other",
  ])
    await navigate(path);
  assert.equal(
    await page.getByRole("textbox", { name: "研究问题", exact: true }).count(),
    0,
  );
  await navigate("/analysis");
  assert.equal(
    await page.evaluate(() => window.researchMounts),
    2,
    "test must cause real cache eviction",
  );
  assert.equal(
    await page
      .getByRole("textbox", { name: "研究问题", exact: true })
      .inputValue(),
    "仅分析这份快照的风险",
  );
  assert.match(
    await page
      .getByRole("combobox", { name: "研究方法", exact: true })
      .textContent(),
    /SEPA/,
  );

  await navigate("/");
  await page.waitForFunction(() =>
    window.requests.some((r) => r.name === "tdxQuotes"),
  );
  await idle();
  await page.getByRole("radio", { name: "概念", exact: true }).click();
  await page.waitForFunction(
    () => new URLSearchParams(location.search).get("rank") === "concept",
  );
  await idle();
  assert.ok(
    await page.evaluate(() =>
      window.requests.some((r) => r.name === "conceptRpsPage"),
    ),
  );
  await navigate("/tasks");
  assert.equal(
    await page.getByRole("radio", { name: "概念", exact: true }).count(),
    0,
    "the overview must unmount on navigation",
  );
  await page.evaluate(async () => {
    window.requests.length = 0;
    window.client.setQueryData(["status", undefined], (old) => ({
      ...old,
      watchlist: ["sz000001"],
    }));
    for (const name of [
      "tdxQuotes",
      "channels",
      "signalWorkspacePage",
      "localDailyAsOf",
      "intradayStatus",
      "clsReviewSchedule",
      "rpsStatus",
      "industryRpsPage",
    ])
      await window.client.invalidateQueries({ queryKey: [name] });
  });
  await page.waitForTimeout(200);
  assert.deepEqual(
    await page.evaluate(() => window.requests),
    [],
    "hidden overview must not fetch invalidated data or new watch quotes",
  );
  await navigate("/?rank=concept");
  await page.waitForFunction(() =>
    window.requests.some(
      (r) => r.name === "tdxQuotes" && r.input.includes("sz000001"),
    ),
  );

  assert.equal(
    await page
      .getByRole("radio", { name: "概念", exact: true })
      .getAttribute("aria-checked"),
    "true",
  );
  await page.evaluate(() => (window.requests.length = 0));
  await navigate("/settings");
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="coverage"]').textContent === "99",
  );
  const settingsRenders = await page.evaluate(() => window.shellRenders);
  await page.evaluate(async () => {
    window.savedStatus = {
      ...window.savedStatus,
      coverage: { ...window.savedStatus.coverage, total: 42 },
    };
    await window.client.invalidateQueries({ queryKey: ["status"] });
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="coverage"]').textContent === "42",
  );
  assert.equal(await page.evaluate(() => window.shellRenders), settingsRenders);
  await page.evaluate(async () => {
    window.failStatus = true;
    await window.client.invalidateQueries({ queryKey: ["status"] });
  });
  await page.getByRole("button", { name: "重试设置", exact: true }).waitFor();
  assert.equal(
    await page.getByTestId("coverage").textContent(),
    "42",
    "a status refresh failure must retain the settings form",
  );
  await page.evaluate(() => {
    window.failStatus = false;
  });
  await page.getByRole("button", { name: "重试设置", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
  // Invalidate while settings is visible: its channels observer must refetch.
  await page.evaluate(() =>
    window.client.invalidateQueries({ queryKey: ["channels"] }),
  );
  await page.waitForFunction(() =>
    window.requests.some((r) => r.name === "channels"),
  );
  await page.getByRole("button", { name: "扫描测试", exact: true }).click();
  await page.waitForFunction(() =>
    window.notifications.includes("开始扫描本地行情，进度显示在任务栏"),
  );
  assert.equal(await page.evaluate(() => window.mutations.at(-1).name), "scan");
  await page.waitForFunction(() =>
    window.requests.some((r) => r.name === "taskOverview"),
  );
  await navigate("/tasks");
  await page.evaluate(async () => {
    window.requests.length = 0;
    await window.client.invalidateQueries({ queryKey: ["channels"] });
    await window.client.invalidateQueries({ queryKey: ["status"] });
  });
  assert.deepEqual(
    await page.evaluate(() =>
      window.requests.filter((r) => ["channels", "status"].includes(r.name)),
    ),
    [],
    "hidden settings/home/research must not refetch configuration or channels",
  );
  await navigate("/market");
  await idle();
  const beforeSource = await page.evaluate(() => window.shellRenders);
  await page.evaluate(() =>
    window.client.setQueryData(["status", undefined], (old) => ({
      ...old,
      settings: { ...old.settings, marketDataSource: "tencent" },
    })),
  );
  await page.waitForTimeout(150);
  assert.equal(
    await page.evaluate(() => window.shellRenders),
    beforeSource,
    "market source selection must not rerender the shell",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: cold route, research draft isolation/eviction/submission/failure, hidden report/settings requests, overview route unmount and URL rank, current watch quotes and scan invalidation",
  );
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
