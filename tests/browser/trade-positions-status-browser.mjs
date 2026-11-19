/** Real trade ledger panel: position status segment, paging, empty states and view memory. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium, expect } from "@playwright/test";

const css = await postcss([tailwind()]).process(
  readFileSync("src/styles/globals.css", "utf8"),
  { from: resolve("src/styles/globals.css") },
);

const api = `
import {useEffect,useState} from 'react';
const summary={holdings:21,trades:24,linkedTrades:0,marketValue:210,
 knownMarketValue:210,missingQuotes:0,floating:0,unknownFloating:0,sellable:0};
const row=(symbol,quantity)=>({symbol,quantity,sellable:quantity,averageCost:10,
 adjustedCost:10,quote:{price:10,date:'2026-11-18'},floating:0,realized:0,
 stop:null,stopDistancePct:null,adjustmentCount:0,
 adjustmentStatus:'成本已按 GBBQ 核对'});
const rows=[
 ...Array.from({length:21},(_,i)=>row('sh600'+String(100+i).padStart(3,'0'),100)),
 ...['sh601100','sh601101','sh601102'].map((symbol)=>row(symbol,0)),
];
window.positionRequests=[];
function compute(name,input){
 if(name==='tradeWorkspaceEnvironment')return {today:'2026-11-19',mockEnabled:false};
 if(name==='tradeWorkspacePositions'){
  const status=(input&&input.status)||'all',
   page=(input&&input.page)||1,
   query=((input&&input.query)||'').toLowerCase();
  const matching=rows
   .filter((p)=>status==='all'?true:status==='open'?p.quantity>0:p.quantity===0)
   .filter((p)=>p.symbol.toLowerCase().includes(query));
  return {today:'2026-11-18',calendarSource:'fixture',version:'fixture',
   summary,count:matching.length,page,
   items:matching.slice((page-1)*20,page*20),
   hasMore:page*20<matching.length};
 }
 return undefined;
}
function useFixtureQuery(name,input,options){
 const enabled=!options||options.enabled!==false;
 const key=name+':'+JSON.stringify(input??null);
 const [state,setState]=useState({key:null,data:undefined,fetching:enabled});
 const [nonce,setNonce]=useState(0);
 useEffect(()=>{
  if(!enabled)return;
  if(name==='tradeWorkspacePositions')
   window.positionRequests.push({name,input:input??null});
  if(window.deferPositions&&name==='tradeWorkspacePositions'){
   window.releasePositions=()=>setState({key,data:compute(name,input),fetching:false});
   setState({key,data:undefined,fetching:true});
   return;
  }
  setState({key,data:compute(name,input),fetching:false});
 },[key,enabled,nonce]);
 const current=state.key===key;
 return {data:current?state.data:undefined,
  isFetching:current?state.fetching:enabled,
  error:null,refetch:()=>setNonce((value)=>value+1)};
}
const read=async()=>({});
const utils=new Proxy({}, {get:()=>({invalidate:read,refetch:read,reset:read,
 fetch:async()=>({filename:'fixture.json',mime:'application/json',content:'{}',count:0})})});
export const api=new Proxy({}, {get:(_,name)=>name==='useUtils'
 ? ()=>utils
 : {useQuery:(input,options)=>useFixtureQuery(name,input,options),
    useMutation:()=>({isPending:false,error:null,mutate:()=>{}})}});`;

const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';
import {TradeLedgerPanel} from './src/components/portfolio/trade-ledger-panel';
createRoot(document.getElementById('root')).render(<TradeLedgerPanel/>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  alias: { "~": "./src" },
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  plugins: [
    {
      name: "fixtures",
      setup(b) {
        b.onResolve({ filter: /^~\/trpc\/react$/ }, () => ({
          path: "api",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /^~\/app\/accounts\/actions$/ }, () => ({
          path: "actions",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /\/use-task-visible$/ }, () => ({
          path: "visible",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          loader: "js",
          resolveDir: process.cwd(),
          contents:
            args.path === "api"
              ? api
              : args.path === "actions"
                ? [
                    "saveTrade",
                    "updateStop",
                    "saveBonusListing",
                    "toggleMock",
                    "createMockAccount",
                    "reconcileAccount",
                    "previewOrder",
                    "confirmOrder",
                    "readMockDiagnostics",
                    "recoverMockAccount",
                    "readMockMarkets",
                    "readMockFunds",
                    "readMockTrades",
                  ]
                    .map(
                      (name) =>
                        `export function ${name}(){throw Error('Unexpected account action')}`,
                    )
                    .join("\n")
                : "export const useTaskVisible=()=>true;",
        }));
      },
    },
  ],
});
const server = createServer((request, response) => {
  if (request.url === "/app.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(bundle.outputFiles[0].text);
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end('<div id="root"></div><script src="/app.js"></script>');
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const latest = (page) => page.evaluate(() => window.positionRequests.at(-1));
const waitForStatus = (page, status, pageNumber = 1) =>
  page.waitForFunction(
    ([status, pageNumber]) => {
      const last = window.positionRequests
        .filter((request) => request.name === "tradeWorkspacePositions")
        .at(-1);
      return last?.input?.status === status && last?.input?.page === pageNumber;
    },
    [status, pageNumber],
  );
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(base) ? route.continue() : route.abort(),
  );
  await page.goto(base + "/accounts?view=positions");
  await page.addStyleTag({ content: css.css });
  await waitForStatus(page, "all");
  await expect(
    page.getByRole("radio", { name: "全部", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("heading", { name: "sh600100 · 持有" }),
  ).toBeVisible();
  assert.deepEqual(await latest(page), {
    name: "tradeWorkspacePositions",
    input: { page: 1, query: "", status: "all" },
  });

  // Paging then changing status starts the new status at page one.
  await page.getByRole("button", { name: "下一页持仓", exact: true }).click();
  await waitForStatus(page, "all", 2);
  await page.getByRole("radio", { name: "已清仓", exact: true }).click();
  await waitForStatus(page, "closed", 1);
  await expect(
    page.getByRole("heading", { name: "sh601100 · 已清仓" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /sh6001\d\d · 持有/ }),
  ).toHaveCount(0);
  await expect(page.getByText("第2页", { exact: true })).toHaveCount(0);

  // Keyboard arrow keys move between the three statuses.
  await page.getByRole("radio", { name: "已清仓", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await waitForStatus(page, "all");
  await expect(
    page.getByRole("radio", { name: "全部", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("ArrowLeft");
  await waitForStatus(page, "closed");
  await expect(
    page.getByRole("radio", { name: "已清仓", exact: true }),
  ).toBeChecked();

  // A pending status must not keep showing the previous status' rows.
  await page.evaluate(() => {
    window.deferPositions = true;
  });
  await page.getByRole("radio", { name: "持有", exact: true }).click();
  await waitForStatus(page, "open");
  await expect(
    page.getByRole("status").filter({ hasText: "正在核对完整持仓" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "sh601100 · 已清仓" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.deferPositions = false;
    window.releasePositions();
  });
  await expect(
    page.getByRole("heading", { name: "sh600100 · 持有" }),
  ).toBeVisible();

  // Every status has its own empty state, combined with the confirmed search.
  await page.getByLabel("持仓证券检索").fill("zzz");
  await page.getByRole("button", { name: "查询持仓", exact: true }).click();
  await page.waitForFunction(() => {
    const last = window.positionRequests
      .filter((request) => request.name === "tradeWorkspacePositions")
      .at(-1);
    return last?.input?.query === "zzz" && last?.input?.status === "open";
  });
  await expect(
    page.getByText("没有持有中的证券；可切换全部或检查检索词。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "全部", exact: true }).click();
  await expect(
    page.getByText("暂无持仓或没有匹配的证券。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "已清仓", exact: true }).click();
  await expect(
    page.getByText("没有已清仓的证券；可切换全部或检查检索词。", {
      exact: true,
    }),
  ).toBeVisible();

  // The status joins the existing view memory and survives a reload.
  await page.waitForFunction(() => {
    try {
      return (
        JSON.parse(sessionStorage.getItem("trade-workspace-view") ?? "null")
          ?.positionStatus === "closed"
      );
    } catch {
      return false;
    }
  });
  await page.reload();
  await waitForStatus(page, "closed");
  await expect(
    page.getByRole("radio", { name: "已清仓", exact: true }),
  ).toBeChecked();

  // A stored view from before this field exists falls back to all.
  await page.evaluate(() => {
    const url = new URL(location.href);
    sessionStorage.setItem(
      "trade-workspace-view",
      JSON.stringify({
        url: url.pathname + url.search,
        pages: [null],
        adjustmentPages: [null],
        positionPage: 1,
        positionQuery: "",
      }),
    );
  });
  await page.reload();
  await waitForStatus(page, "all");
  await expect(
    page.getByRole("radio", { name: "全部", exact: true }),
  ).toBeChecked();

  // 1024: the search row may wrap, never overflow, and all options stay visible.
  await page.addStyleTag({ content: css.css });
  await page.setViewportSize({ width: 1024, height: 900 });
  const layout = await page.evaluate(() => {
    const group = document.querySelector(
      '[role="radiogroup"][aria-label="持仓状态"]',
    );
    const form = group.closest("form");
    return {
      formWrap: getComputedStyle(form).flexWrap,
      groupWrap: getComputedStyle(group).flexWrap,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      options: [...group.querySelectorAll('button[role="radio"]')].map(
        (button) => ({ text: button.textContent, width: button.offsetWidth }),
      ),
    };
  });
  assert.equal(layout.formWrap, "wrap");
  assert.equal(layout.groupWrap, "wrap");
  assert.ok(layout.overflow <= 0, `horizontal overflow ${layout.overflow}px`);
  assert.deepEqual(
    layout.options.map((option) => option.text),
    ["全部", "持有", "已清仓"],
  );
  assert.ok(layout.options.every((option) => option.width > 0));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      scenarios: [
        "default-all",
        "page-reset",
        "keyboard",
        "pending-no-stale",
        "three-empty-states",
        "view-memory",
        "legacy-default",
        "1024-wrap",
      ],
    }),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
