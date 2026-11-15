/** Real shell/domain hooks, Zustand, panel cache and Query; local transport only. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const transport = `
import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
const jobs=[
 {id:'old-screen',type:'screen',status:'completed',isFormulaScreen:false},
 {id:'formula-latest',type:'screen',status:'completed',isFormulaScreen:true,updatedAt:1},
 {id:'formula-other',type:'screen',status:'completed',isFormulaScreen:true,updatedAt:1},
 {id:'formula-running',type:'screen',status:'running',isFormulaScreen:true,updatedAt:1},
];
window.requests=[];window.names={sh600000:'初始名称'};
window.jobs=[...jobs,...Array.from({length:90},(_,i)=>({id:'completed-'+i,type:'research',status:'completed',updatedAt:1000+i})),{id:'old-active',type:'research',status:'running',updatedAt:0}];
window.failedDeliveries=0;
async function fetch(name,input){
 window.requests.push({name,input});
 if(name==='jobs')return structuredClone(window.jobs.slice(0,80));
 if(name==='taskOverview')return {
  running:window.jobs.filter(job=>job.status==='running').length,
  queued:window.jobs.filter(job=>job.status==='queued').length,
  latestCompletedScan:structuredClone(window.jobs.filter(job=>job.type==='scan'&&job.status==='completed').sort((a,b)=>b.updatedAt-a.updatedAt||b.id.localeCompare(a.id))[0]??null),
  checkedAt:Date.now(),revision:1,
 };
 if(name==='jobSummary')return structuredClone(window.jobs.find(job=>job.id===input.id)??null);
 if(name==='screenResults')return {jobId:input.id,count:150,candidates:[],excluded:[],errors:[]};
 if(name==='status')return {settings:{marketDataSource:'local'},watchlist:[]};
 if(name==='securityNames')return {...window.names};
 if(name==='monitorWorkspaceSummary')return {today:'2026-11-13',failedDeliveries:window.failedDeliveries};
 return [];
}
export const api=new Proxy({}, {get:(_,name)=>name==='useUtils'?()=>{
 const client=useQueryClient();
 return new Proxy({}, {get:(_,key)=>({invalidate:()=>client.invalidateQueries({queryKey:[key]}),fetch:input=>fetch(key,input)})});
}:{
 useQuery(input,options={}){return useQuery({queryKey:[name,input],...options,queryFn:()=>fetch(name,input)})},
 useMutation(options={}){return useMutation({...options,mutationFn:()=>{throw Error('unexpected mutation '+name)}})},
}});`;
const navigation = `
import {useSyncExternalStore} from 'react';
const subscribe=listener=>{window.addEventListener('popstate',listener);return()=>window.removeEventListener('popstate',listener)};
const pathname=()=>window.location.pathname;
export const usePathname=()=>useSyncExternalStore(subscribe,pathname,()=>'/lab/backtest');
export const useRouter=()=>({push(path){window.history.pushState(null,'',path);window.dispatchEvent(new PopStateEvent('popstate'))}});
`;
const bundle = await build({
  stdin: {
    contents: `import React,{useEffect} from 'react';import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {usePathname,useRouter} from 'next/navigation';
import {useWorkbenchState} from './src/components/workbench/use-workbench-state';
import {WorkbenchSidebar} from './src/components/workbench/workbench-sidebar';
import {useScreenResults} from './src/components/screening/use-screen-results';
import {useSecurityNames} from './src/components/market/use-security-names';
import {useTaskVisible} from './src/components/workbench/use-task-visible';
import {api} from '~/trpc/react';
import {useScreenSession} from './src/lib/stores/screen-session';
import {PanelCache} from './src/components/workbench/keep-alive';
window.shellRenders=0;window.screenMounts=0;
const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,refetchOnWindowFocus:false}}});
window.client=client;window.session=useScreenSession;
function Screening({notify}){
 const state=useScreenResults(notify);
 const names=useSecurityNames();
 useEffect(()=>{window.screenMounts++},[]);
 return <section><output data-testid='screen'>{JSON.stringify({id:state.screenId,page:state.screenPage,query:state.screenQuery,sort:state.screenSort,job:state.screenJob?.id??null,result:state.screenResult?.jobId??null})}</output>
 <output data-testid='name'>{names.data?.sh600000??''}</output><button onClick={()=>state.setScreenPage(state.screenPage+1)}>下一页</button></section>;
}
function Coverage(){const visible=useTaskVisible();api.status.useQuery(undefined,{enabled:visible});return <div>coverage consumer</div>}
function Shell(){window.shellRenders++;const state=useWorkbenchState();const path=usePathname();const router=useRouter();window.navigate=router.push;
 const panels=Object.fromEntries(['/lab/backtest','/system/tasks','/scan?tab=rps','/intel','/system/notifications','/lab/reports','/lab/analysis','/system'].map(path=>[path,<div>{path}</div>]));
 panels['/scan?tab=formula']=<Screening notify={state.notify}/>;
 panels['/system']=<Coverage/>;
 return <><WorkbenchSidebar active={path}/><output data-testid='route'>{path}</output><PanelCache active={path} panels={panels}/></>;
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
        // Render activity values without navigation styling; the production
        // route suite verifies the actual Sidebar and links.
        b.onResolve({ filter: /^\.\/sidebar$/ }, () => ({
          path: "sidebar",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /^~\/trpc\/react$/ }, () => ({
          path: "api",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /^next\/navigation$/ }, () => ({
          path: "navigation",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents:
            path === "api"
              ? transport
              : path === "sidebar"
                ? `import React from 'react';export function Sidebar({badges}){return React.createElement('output',{'data-testid':'badges'},JSON.stringify(badges));}`
                : navigation,
          loader: "js",
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
        document.querySelector('[data-testid="route"]').textContent === path,
      path,
    );
    await idle();
  };
  await page.waitForFunction(() =>
    window.requests.some((r) => r.name === "taskOverview"),
  );
  await idle();
  assert.equal(
    JSON.parse(await page.getByTestId("badges").textContent())["/system/tasks"]
      .count,
    2,
    "sidebar must include the active task outside the recent-80 window",
  );
  assert.equal(
    await page.evaluate(() => window.requests.some((r) => r.name === "jobs")),
    false,
    "navigation only needs aggregate metadata, not recent task rows",
  );
  const activityShellRenders = await page.evaluate(() => window.shellRenders);
  // Actual polling (no invalidation) must update the badge without rendering
  // the shell or requesting a screening result on an unrelated route.
  await page.evaluate(() => {
    window.jobs.unshift({
      id: "background-task",
      type: "scan",
      status: "running",
      updatedAt: 1,
    });
  });
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector('[data-testid="badges"]').textContent)[
        "/system/tasks"
      ].count === 3,
  );
  await page.evaluate(async () => {
    window.failedDeliveries = 3;
    await window.client.invalidateQueries({
      queryKey: ["monitorWorkspaceSummary"],
    });
  });
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector('[data-testid="badges"]').textContent)[
        "/system/notifications"
      ].count === 3,
  );
  assert.equal(
    await page.evaluate(() => window.shellRenders),
    activityShellRenders,
    "job progress and failed-delivery counts must not rerender the shell",
  );

  // Both observed running->completed and completed->new-completed scans refresh
  // coverage. Unrelated task progress must not repeatedly invalidate status.
  // Only a visible coverage consumer fetches; the shell no longer owns status.
  await navigate("/system");
  for (const [id, version] of [
    ["background-task", 2],
    ["quick-scan", 2],
    ["quick-scan", 3],
  ]) {
    await page.evaluate(
      async ({ id, version }) => {
        window.requests.length = 0;
        window.jobs = window.jobs.filter((job) => job.id !== id);
        window.jobs.push({
          id,
          type: "scan",
          status: "completed",
          updatedAt: version,
        });
        await window.client.invalidateQueries({ queryKey: ["taskOverview"] });
      },
      { id, version },
    );
    await page.waitForFunction(() =>
      window.requests.some((r) => r.name === "status"),
    );
    assert.equal(
      await page.evaluate(
        () => window.requests.filter((r) => r.name === "status").length,
      ),
      1,
    );
  }
  await page.evaluate(async () => {
    window.requests.length = 0;
    window.jobs.find((job) => job.id === "formula-running").updatedAt++;
    await window.client.invalidateQueries({ queryKey: ["taskOverview"] });
  });
  await idle();
  assert.equal(
    await page.evaluate(() => window.requests.some((r) => r.name === "status")),
    false,
    "unrelated progress must not refresh coverage",
  );
  assert.equal(
    await page.evaluate(() =>
      window.requests.some((r) =>
        ["screenResults", "jobSummary", "securityNames"].includes(r.name),
      ),
    ),
    false,
    "cold non-screen route must not load formula results",
  );

  await navigate("/scan?tab=formula");
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector('[data-testid="screen"]').textContent)
        .result === "formula-latest",
  );
  await idle();
  await page.getByTestId("name").filter({ hasText: "初始名称" }).waitFor();
  const beforeNames = await page.evaluate(() => window.shellRenders);
  await page.evaluate(async () => {
    window.names = { sh600000: "更新名称" };
    await window.client.invalidateQueries({ queryKey: ["securityNames"] });
  });
  await page.getByTestId("name").filter({ hasText: "更新名称" }).waitFor();
  assert.equal(
    await page.evaluate(() => window.shellRenders),
    beforeNames,
    "directory updates must not rerender the shell",
  );
  // Headless Chrome keeps focus emulated across tabs. Supply a controlled
  // document signal to exercise the actual visibility subscription, not OS focus.
  await page.evaluate(() => {
    window.fixtureFocused = false;
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => window.fixtureFocused,
    });
    window.dispatchEvent(new Event("blur"));
  });
  await page.waitForTimeout(50);
  await page.evaluate(async () => {
    window.requests.length = 0;
    window.names = { sh600000: "重新聚焦名称" };
    await window.client.invalidateQueries({ queryKey: ["securityNames"] });
    await window.client.invalidateQueries({ queryKey: ["jobs"] });
    await window.client.invalidateQueries({ queryKey: ["taskOverview"] });
    await window.client.invalidateQueries({
      queryKey: ["monitorWorkspaceSummary"],
    });
  });
  await page.waitForTimeout(2300);
  assert.equal(
    await page.evaluate(() =>
      window.requests.some((r) =>
        [
          "securityNames",
          "jobs",
          "taskOverview",
          "monitorWorkspaceSummary",
        ].includes(r.name),
      ),
    ),
    false,
    "unfocused consumers must not refetch or poll invalidated activity/directory queries",
  );
  await page.evaluate(() => {
    window.fixtureFocused = true;
    window.dispatchEvent(new Event("focus"));
  });
  await page.getByTestId("name").filter({ hasText: "重新聚焦名称" }).waitFor();
  await page.evaluate(() => {
    delete document.hasFocus;
  });
  const shellBefore = await page.evaluate(() => {
    window.requests.length = 0;
    return window.shellRenders;
  });
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.waitForFunction(() =>
    window.requests.some(
      (r) => r.name === "screenResults" && r.input.page === 1,
    ),
  );
  await idle();
  assert.equal(
    await page.evaluate(() => window.shellRenders),
    shellBefore,
    "screen pagination must not rerender the shell",
  );
  assert.deepEqual(
    await page.evaluate(() => [...new Set(window.requests.map((r) => r.name))]),
    ["screenResults"],
  );

  await navigate("/system/tasks");
  await page.evaluate(async () => {
    window.requests.length = 0;
    window.session.getState().selectJob("formula-running");
    await window.client.invalidateQueries({ queryKey: ["jobSummary"] });
    await window.client.invalidateQueries({ queryKey: ["screenResults"] });
    window.names = { sh600000: "返回后名称" };
    await window.client.invalidateQueries({ queryKey: ["securityNames"] });
  });
  await page.waitForTimeout(2300);
  assert.equal(
    await page.evaluate(() =>
      window.requests.some((r) =>
        ["screenResults", "jobSummary", "securityNames"].includes(r.name),
      ),
    ),
    false,
    "hidden query invalidation and identity changes must not start requests or polling",
  );
  await navigate("/scan?tab=formula");
  await page.getByTestId("name").filter({ hasText: "返回后名称" }).waitFor();
  await page.waitForFunction(() =>
    window.requests.some(
      (r) => r.name === "jobSummary" && r.input.id === "formula-running",
    ),
  );
  await page.evaluate(() =>
    window.session.getState().selectJob("formula-other"),
  );
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector('[data-testid="screen"]').textContent)
        .result === "formula-other",
  );
  await page.evaluate(() => {
    const session = window.session.getState();
    session.setScreenPage(2);
    session.setScreenQuery("银行");
    session.setScreenSort("score");
  });
  await idle();
  for (const path of [
    "/system/tasks",
    "/scan?tab=rps",
    "/intel",
    "/system/notifications",
    "/lab/reports",
    "/lab/analysis",
    "/system",
  ])
    await navigate(path);
  assert.equal(
    await page.getByTestId("screen").count(),
    0,
    "screen should actually be evicted by the cache",
  );
  await navigate("/scan?tab=formula");
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector('[data-testid="screen"]').textContent)
        .result === "formula-other",
  );
  assert.equal(await page.evaluate(() => window.screenMounts), 2);
  assert.deepEqual(JSON.parse(await page.getByTestId("screen").textContent()), {
    id: "formula-other",
    page: 2,
    query: "银行",
    sort: "score",
    job: "formula-other",
    result: "formula-other",
  });

  await page.evaluate(() => window.session.getState().selectJob("missing"));
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector('[data-testid="screen"]').textContent)
        .job === null,
  );
  assert.equal(
    JSON.parse(await page.getByTestId("screen").textContent()).result,
    null,
    "missing explicit task must not fall back to the latest result",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: isolated activity polling/badges, consecutive scan completion refresh, unfocused polling stop, page-owned names/results, pagination, cache eviction and explicit task identity",
  );
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
