/** Actual export controls with synthetic reads and controllable cache cleanup. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, expect } from "@playwright/test";

const api = `
const reports={
 'report-a':{id:'report-a',versionNumber:3,importedAt:1,sourcePath:'fixture-a',size:1,observedAt:1,
  report:{title:'合成报告 A',reportDate:'2026-11-01',hash:'a'.repeat(64),warnings:[],markdown:'fixture A'}},
 'report-b':{id:'report-b',versionNumber:7,importedAt:1,sourcePath:'fixture-b',size:1,observedAt:1,
  report:{title:'合成报告 B',reportDate:'2026-11-02',hash:'b'.repeat(64),warnings:[],markdown:'fixture B'}},
};
const candidate={symbol:'sh600000',sectionId:'s',direction:'bullish',priority:0,
 basis:'explicit-recommendation',rps:null,evidence:'合成样本'};
const sample=(date,reportId,extra={})=>({version:'cls-sample-1',date,fixedAt:1,reportId,
 reportHash:'a'.repeat(64),previousTradingDay:'2019-12-31',calendarSource:'fixture',
 poolHash:'fixture',candidates:[],selected:null,reason:null,...extra});
const samples={
 '2020-01-01':sample('2020-01-01','report-a',{candidates:[candidate],selected:candidate,reportAvailable:true}),
 '2020-01-02':sample('2020-01-02','report-b',{reason:'合成无样本，非真实交易数据',reportAvailable:true}),
 '2020-01-03':sample('2020-01-03','report-a',
   {reason:'原始报告及复盘证据已由用户清理，保留日期占位',reportAvailable:false}),
};
const data={tradeWorkspaceEnvironment:{today:'2026-11-13',mockEnabled:false},
 tradeWorkspacePage:{version:'fixture',summary:{count:0,buys:0,sells:0,fees:0},items:[],nextCursor:null}};
function queryValue(name,input){
 if(name==='clsReviewExport')return reports[input]??null;
 if(name==='clsReviewSample')return samples[input]??null;
 if(name==='clsReviewReportSamples')return [];
 if(name==='clsReviewSampleEligibility')return {allowed:false,reason:'合成选样不可用'};
 if(name==='clsReviewVerificationPage')return window.versions||{items:[],hasMore:false,nextCursor:null};
 if(name==='clsReviewVerificationDetail')return null;
 if(name==='clsReviewSummary')return [];
 if(name==='clsReviewReportPage')return {items:[],hasMore:false,nextCursor:null};
 return data[name];
}
const verification=(input)=>({version:'cls-verification-1',date:input.date,checkedAt:input.checkedAt||1,
 source:{root:'fixture-root',benchmark:'fixture-bench',adjustment:'none'},
 bars:[],benchmark:[],calendar:[input.date],warnings:['合成核对证据'],outcomes:[],hash:input.hash});
function detailValue(input){
 const mode=window.evidenceMode||'ok';
 if(mode==='null')return null;
 if(mode==='wrong')return verification({date:'2020-01-03',hash:'d'.repeat(64),checkedAt:1});
 return verification(input);
}
function verifyResult(date){
 const mode=window.verifyMode||'ok';
 const now=window.verifyNow||1700000000000;
 if(mode==='wrongDate')return {date:'2020-01-04',hash:'e'.repeat(64),checkedAt:now};
 if(mode==='badHash')return {date,hash:'XYZ',checkedAt:now};
 if(mode==='badTime')return {date,hash:'f'.repeat(64),checkedAt:0};
 if(mode==='overflowTime')return {date,hash:'f'.repeat(64),checkedAt:Number.MAX_VALUE};
 return {date,hash:'c'.repeat(64),checkedAt:now};
}
const utils=new Proxy({}, {get:(_,name)=>({
 fetch:async(id)=>{window.fetchCalls++;window.fetchIds.push(id);
  if(window.holdFetch)await new Promise((resolve)=>{window.releaseFetch=resolve});
  if(window.fetchFailure)throw Error('合成导出失败');
  if(name!=='clsReviewExportAll')return {filename:'fixture.json',mime:'application/json',content:'{}',count:0};
  if(window.exportMode==='empty')return {report:null};
  if(window.exportMode==='mismatch')return {report:reports['report-b']};
  return {report:reports[id]??null};},
 reset:()=>{window.resetCalls++;return new Promise((resolve,reject)=>{window.resolveReset=resolve;window.rejectReset=reject})},
 invalidate:async()=>{},setData:()=>{},
})});
export const api=new Proxy({}, {get:(_,name)=>name==='useUtils'?()=>utils:{
 useQuery:(input,options)=>{
  const enabled=!options||options.enabled!==false;
  if(name==='clsReviewVerificationDetail'){
   if(enabled)(window.detailQueries||(window.detailQueries=[])).push({date:input.date,hash:input.hash});
   const mode=window.evidenceMode||'ok';
   return {data:enabled&&mode!=='error'?detailValue(input):undefined,
    isLoading:enabled&&mode==='loading',isFetching:enabled&&mode==='loading',
    error:enabled&&mode==='error'?{message:'合成证据读取失败'}:null,
    refetch:async()=>{window.detailRefetches=(window.detailRefetches||0)+1;}};
  }
  if(name==='clsReviewVerificationPage')
   return {data:enabled?queryValue(name,input):undefined,isLoading:false,isFetching:false,error:null,refetch:async()=>{}};
  return {data:queryValue(name,input),isLoading:false,isFetching:false,error:null,
   refetch:async()=>{}};
 },
 useMutation:(options)=>{
  if(name!=='clsReviewVerify')
   return {isPending:false,mutate:()=>{throw Error('Unexpected mutation')}};
  return {isPending:false,error:null,mutate:(date)=>{
   options?.onMutate?.();
   window.verifyCalls=(window.verifyCalls||0)+1;
   window.verifyDates=[...(window.verifyDates||[]),date];
   const finish=()=>options?.onSuccess?.(verifyResult(date),date,undefined);
   window.releaseVerify=finish;
   if(!window.holdVerify)queueMicrotask(finish);
  }};
 },
}});`;
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';
import {ClsReviewWorkspace} from './src/components/news/cls-review-workspace';
import {TradeLedgerPanel} from './src/components/portfolio/trade-ledger-panel';
window.fetchCalls=0;window.resetCalls=0;window.fetchIds=[];window.exportMode='ok';window.holdFetch=false;
window.downloads=0;window.revoked=0;window.holdVerify=false;window.evidenceMode='ok';window.verifyMode='ok';
window.verifyNow=1700000000000;window.detailQueries=[];window.detailRefetches=0;window.verifyCalls=0;
window.verifyDates=[];window.versions={items:[],hasMore:false,nextCursor:null};
HTMLAnchorElement.prototype.click=function(){window.downloads++};
URL.createObjectURL=()=> 'blob:fixture';URL.revokeObjectURL=()=>{window.revoked++};
createRoot(document.getElementById('root')).render(location.pathname==='/intel/review'?<ClsReviewWorkspace/>:<TradeLedgerPanel/>);`,
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
        if (process.argv.includes("--negative-control")) {
          b.onLoad(
            { filter: /(?:cls-review-workspace|trade-ledger-panel)\.tsx$/ },
            (args) => {
              const source = readFileSync(args.path, "utf8");
              const contents = source.replace(
                /await (utils\.(?:clsReviewExportAll|tradeWorkspaceExport)\.reset\([^)]+\));/,
                "$1;",
              );
              assert.notEqual(
                contents,
                source,
                "negative control must remove the cleanup await",
              );
              return {
                contents,
                loader: "tsx",
                resolveDir: dirname(args.path),
              };
            },
          );
        }
        b.onResolve({ filter: /^~\/trpc\/react$/ }, () => ({
          path: "api",
          namespace: "fixture",
        }));
        b.onResolve(
          { filter: /^~\/app\/(?:accounts|trade-ledger)\/actions$/ },
          () => ({
            path: "actions",
            namespace: "fixture",
          }),
        );
        b.onResolve({ filter: /\/use-task-visible$/ }, () => ({
          path: "visible",
          namespace: "fixture",
        }));
        b.onResolve(
          {
            filter: /^\.\/cls-review-(report-list|import|schedule|facts)$/,
          },
          (args) => ({ path: args.path, namespace: "fixture" }),
        );
        b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          loader: "js",
          contents:
            args.path === "api"
              ? api
              : args.path === "actions"
                ? [
                    "saveTrade",
                    "saveBonusListing",
                    "toggleMock",
                    "createMockAccount",
                    "reconcileAccount",
                    "previewOrder",
                    "confirmOrder",
                    "updateStop",
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
                : args.path === "visible"
                  ? "export const useTaskVisible=()=>true;export const useScreenVisible=()=>true;"
                  : [
                      "ClsReviewReportList",
                      "ClsReviewImport",
                      "ClsReviewSchedule",
                      "ClsReviewText",
                      "ClsReviewFacts",
                      "ClsReviewPrices",
                    ]
                      .map((name) => `export const ${name}=()=>null;`)
                      .join("\n"),
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
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const [path, label] of [
    ["/intel/review?clsReport=report-a&clsTab=info", "导出报告与全部关联复盘"],
    ["/accounts?view=history", "导出筛选全集 JSON"],
  ]) {
    const review = path.startsWith("/intel/review"),
      cleanupText = review
        ? "「合成报告 A」导出缓存清理失败，请刷新页面后重试。"
        : "导出缓存清理失败，请刷新页面后重试。",
      failureText = review
        ? "导出「合成报告 A」失败：合成导出失败"
        : "合成导出失败";
    const page = await browser.newPage(),
      errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(error.message);
    });
    await page.route("**/*", (route) =>
      route.request().url().startsWith(base) ? route.continue() : route.abort(),
    );
    await page.goto(base + path);
    const button = page.getByRole("button", { name: label, exact: true });
    await expect(button).toBeEnabled();
    for (const outcome of ["resolve", "reject", "both-fail"]) {
      const before = await page.evaluate(() => window.resetCalls);
      await page.evaluate((fail) => {
        window.fetchFailure = fail;
      }, outcome === "both-fail");
      await button.click();
      await page.waitForFunction((n) => window.resetCalls === n, before + 1);
      // The CLS control changes its text while pending.
      const pending = review
        ? page.getByRole("button", { name: "正在导出…", exact: true })
        : button;
      await expect(pending).toBeDisabled();
      await page.evaluate((resolve) => {
        if (resolve) window.resolveReset();
        else window.rejectReset(Error("fixture cleanup rejection"));
      }, outcome === "resolve");
      await expect(button).toBeEnabled();
      if (outcome === "reject")
        await expect(
          page.getByText(cleanupText, { exact: true }),
        ).toBeVisible();
      if (outcome === "both-fail")
        await expect(
          page.getByText(failureText, { exact: true }),
        ).toBeVisible();
    }
    assert.deepEqual(
      await page.evaluate(() => ({
        downloads: window.downloads,
        revoked: window.revoked,
      })),
      { downloads: 2, revoked: 2 },
    );
    assert.deepEqual(errors, []);
    await page.close();
  }

  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.route("**/*", (route) =>
    route.request().url().startsWith(base) ? route.continue() : route.abort(),
  );
  await page.goto(base + "/intel/review?clsReport=report-a&clsTab=info");
  const button = page.getByRole("button", {
      name: "导出报告与全部关联复盘",
      exact: true,
    }),
    receipt = page.getByText(/最近一次已发起下载/);
  await expect(button).toBeEnabled();
  const counters = () =>
    page.evaluate(() => ({
      fetch: window.fetchCalls,
      reset: window.resetCalls,
      downloads: window.downloads,
    }));

  // Report A stays in flight while the user switches to B via popstate. The
  // page starts with no receipt, so the one that appears must be A's.
  let before = await counters();
  await page.evaluate(() => {
    window.holdFetch = true;
  });
  await button.click();
  await page.waitForFunction((n) => window.fetchCalls > n, before.fetch);
  await page.evaluate(() => {
    history.pushState(null, "", "/intel/review?clsReport=report-b&clsTab=info");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForFunction(() =>
    location.search.includes("clsReport=report-b"),
  );
  await page.evaluate(() => {
    window.holdFetch = false;
    window.releaseFetch();
  });
  await page.waitForFunction((n) => window.resetCalls > n, before.reset);
  await page.evaluate(() => window.resolveReset());
  await expect(button).toBeEnabled();
  assert.deepEqual(await page.evaluate(() => window.fetchIds.slice()), [
    "report-a",
  ]);
  await expect(receipt).toContainText("合成报告 A");
  await expect(receipt).toContainText(
    "cls-review-2026-11-01-v3-aaaaaaaaaa.json",
  );

  // Switch the selection back to A before the remaining exports.
  await page.evaluate(() => {
    history.pushState(null, "", "/intel/review?clsReport=report-a&clsTab=info");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForFunction(() =>
    location.search.includes("clsReport=report-a"),
  );

  // Same-tick double activation issues exactly one fetch and one cleanup.
  before = await counters();
  await page.evaluate(() => {
    const target = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "导出报告与全部关联复盘",
    );
    target.click();
    target.click();
  });
  await page.waitForFunction((n) => window.resetCalls > n, before.reset);
  await page.evaluate(() => window.resolveReset());
  await expect(button).toBeEnabled();
  assert.deepEqual(
    await page.evaluate(() => ({
      fetch: window.fetchCalls,
      reset: window.resetCalls,
    })),
    { fetch: before.fetch + 1, reset: before.reset + 1 },
  );
  await expect(receipt).toContainText("合成报告 A");
  await expect(receipt).toContainText(
    "cls-review-2026-11-01-v3-aaaaaaaaaa.json",
  );

  // A mismatched response is rejected before any Blob or download.
  before = await counters();
  await page.evaluate(() => {
    window.exportMode = "mismatch";
  });
  await button.click();
  await page.waitForFunction((n) => window.resetCalls > n, before.reset);
  await page.evaluate(() => window.resolveReset());
  await expect(button).toBeEnabled();
  await expect(
    page.getByText(
      "导出「合成报告 A」失败：服务端返回的报告与请求不一致，未发起下载",
      { exact: true },
    ),
  ).toBeVisible();
  assert.equal(
    (await counters()).downloads,
    before.downloads,
    "mismatched report must not download",
  );
  await expect(receipt).toContainText("合成报告 A");
  await expect(receipt).toContainText(
    "cls-review-2026-11-01-v3-aaaaaaaaaa.json",
  );

  // An empty response is rejected without touching the receipt.
  before = await counters();
  await page.evaluate(() => {
    window.exportMode = "empty";
  });
  await button.click();
  await page.waitForFunction((n) => window.resetCalls > n, before.reset);
  await page.evaluate(() => window.resolveReset());
  await expect(button).toBeEnabled();
  await expect(
    page.getByText("导出「合成报告 A」失败：报告已不存在，未发起下载", {
      exact: true,
    }),
  ).toBeVisible();
  assert.equal((await counters()).downloads, before.downloads);
  await expect(receipt).toContainText("合成报告 A");

  // A later failure does not erase the previous successful receipt.
  before = await counters();
  await page.evaluate(() => {
    window.exportMode = "ok";
    window.fetchFailure = true;
  });
  await button.click();
  await page.waitForFunction((n) => window.resetCalls > n, before.reset);
  await page.evaluate(() => window.resolveReset());
  await expect(button).toBeEnabled();
  await expect(
    page.getByText("导出「合成报告 A」失败：合成导出失败", { exact: true }),
  ).toBeVisible();
  await expect(receipt).toContainText("合成报告 A");
  await expect(receipt).toContainText(
    "cls-review-2026-11-01-v3-aaaaaaaaaa.json",
  );
  await page.evaluate(() => {
    window.fetchFailure = false;
  });

  // A cleanup failure after a successful download keeps that receipt too.
  before = await counters();
  await button.click();
  await page.waitForFunction((n) => window.resetCalls > n, before.reset);
  await page.evaluate(() =>
    window.rejectReset(Error("fixture cleanup rejection")),
  );
  await expect(button).toBeEnabled();
  await expect(
    page.getByText("「合成报告 A」导出缓存清理失败，请刷新页面后重试。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(receipt).toContainText("合成报告 A");
  await expect(receipt).toContainText(
    "cls-review-2026-11-01-v3-aaaaaaaaaa.json",
  );
  assert.equal((await counters()).downloads, before.downloads + 1);
  assert.deepEqual(errors, []);
  await page.close();

  // Real ClsReviewPrices with simulated reads: the cross-report day jump.
  const jumpPage = await browser.newPage(),
    jumpErrors = [];
  jumpPage.on("pageerror", (error) => {
    jumpErrors.push(error.message);
    console.error(error.message);
  });
  await jumpPage.route("**/*", (route) =>
    route.request().url().startsWith(base) ? route.continue() : route.abort(),
  );
  const dayInput = jumpPage.locator('input[type="date"]');
  const search = () => jumpPage.evaluate(() => location.search);
  await jumpPage.goto(
    base +
      "/intel/review?clsReport=report-b&clsTab=prices&clsSample=2020-01-01",
  );
  await expect(
    jumpPage.getByRole("heading", { name: "合成报告 B" }),
  ).toBeVisible();
  await expect(dayInput).toHaveValue("2020-01-01");
  await expect(
    jumpPage.getByText("归属：另一报告", { exact: true }),
  ).toBeVisible();
  const jump = jumpPage.getByRole("button", {
    name: "查看样本所属报告",
    exact: true,
  });
  await expect(jump).toBeEnabled();
  await jump.click();
  await expect(
    jumpPage.getByRole("heading", { name: "合成报告 A" }),
  ).toBeVisible();
  await expect(
    jumpPage.getByText("归属：当前报告", { exact: true }),
  ).toBeVisible();
  await expect(dayInput).toHaveValue("2020-01-01");
  await expect(jump).toHaveCount(0);
  assert.match(await search(), /clsReport=report-a/);
  assert.match(await search(), /clsTab=prices/);
  assert.match(await search(), /clsSample=2020-01-01/);
  // Back restores B on the original day; Forward returns to A on the same day.
  await jumpPage.goBack();
  await expect(
    jumpPage.getByRole("heading", { name: "合成报告 B" }),
  ).toBeVisible();
  await expect(dayInput).toHaveValue("2020-01-01");
  assert.match(await search(), /clsReport=report-b/);
  assert.match(await search(), /clsSample=2020-01-01/);
  await jumpPage.goForward();
  await expect(
    jumpPage.getByRole("heading", { name: "合成报告 A" }),
  ).toBeVisible();
  await expect(dayInput).toHaveValue("2020-01-01");
  // A deep-link refresh restores the day.
  await jumpPage.reload();
  await expect(
    jumpPage.getByRole("heading", { name: "合成报告 A" }),
  ).toBeVisible();
  await expect(dayInput).toHaveValue("2020-01-01");

  // A cleared owner shows the placeholder and hides both actions.
  await jumpPage.goto(
    base +
      "/intel/review?clsReport=report-b&clsTab=prices&clsSample=2020-01-03",
  );
  await expect(
    jumpPage.getByText("所属报告已清理，样本日期占位保留。", { exact: true }),
  ).toBeVisible();
  await expect(jump).toHaveCount(0);
  await expect(
    jumpPage.getByRole("button", { name: "读取行情并核对", exact: true }),
  ).toHaveCount(0);

  // A day anchor without an exact report, or outside the prices tab, is dropped
  // from both the address and the date field.
  await jumpPage.goto(
    base + "/intel/review?clsTab=prices&clsSample=2020-01-02",
  );
  await expect(
    jumpPage.getByText("请选择报告，查看对应原文、事实核对和样本。", {
      exact: true,
    }),
  ).toBeVisible();
  await jumpPage.waitForFunction(() => !location.search.includes("clsSample="));
  assert.doesNotMatch(await search(), /clsSample=/);

  await jumpPage.goto(
    base + "/intel/review?clsReport=report-b&clsTab=info&clsSample=2020-01-02",
  );
  await expect(
    jumpPage.getByRole("heading", { name: "合成报告 B" }),
  ).toBeVisible();
  await jumpPage.waitForFunction(() => !location.search.includes("clsSample="));
  assert.doesNotMatch(await search(), /clsSample=/);
  await jumpPage
    .getByRole("button", { name: "固定样本与价格观察", exact: true })
    .click();
  await expect(dayInput).toHaveValue("");
  assert.doesNotMatch(await search(), /clsSample=/);

  // Manual per-day queries never write clsSample; only the explicit jump does.
  await jumpPage.goto(base + "/intel/review?clsReport=report-b&clsTab=prices");
  await expect(dayInput).toHaveValue("");
  await dayInput.fill("2020-01-02");
  await jumpPage
    .getByRole("button", { name: "查询样本日期", exact: true })
    .click();
  await expect(
    jumpPage.getByText("归属：当前报告", { exact: true }),
  ).toBeVisible();
  await expect(
    jumpPage.getByText("无选中证券 · 待核对 · 合成无样本，非真实交易数据"),
  ).toBeVisible();
  assert.doesNotMatch(await search(), /clsSample=/);
  await dayInput.fill("2020-01-01");
  await jumpPage
    .getByRole("button", { name: "查询样本日期", exact: true })
    .click();
  await expect(
    jumpPage.getByText("归属：另一报告", { exact: true }),
  ).toBeVisible();
  assert.doesNotMatch(await search(), /clsSample=/);
  await jumpPage
    .getByRole("button", { name: "查看样本所属报告", exact: true })
    .click();
  await expect(
    jumpPage.getByRole("heading", { name: "合成报告 A" }),
  ).toBeVisible();
  await jumpPage.goBack();
  await expect(
    jumpPage.getByRole("heading", { name: "合成报告 B" }),
  ).toBeVisible();
  await expect(dayInput).toHaveValue("2020-01-01");
  // An ordinary tab switch clears the explicit anchor from the address.
  await jumpPage.goForward();
  await expect(
    jumpPage.getByRole("heading", { name: "合成报告 A" }),
  ).toBeVisible();
  assert.match(await search(), /clsSample=2020-01-01/);
  await jumpPage.getByRole("button", { name: "报告原文", exact: true }).click();
  await jumpPage.waitForFunction(() => !location.search.includes("clsSample="));
  // Returning to the report list clears the explicit day and the selection.
  await jumpPage.goBack();
  await expect(
    jumpPage.getByRole("heading", { name: "合成报告 B" }),
  ).toBeVisible();
  await expect(dayInput).toHaveValue("2020-01-01");
  await jumpPage
    .getByRole("button", { name: "返回报告列表", exact: true })
    .click();
  await jumpPage.waitForFunction(
    () =>
      !location.search.includes("clsSample=") &&
      !location.search.includes("clsReport="),
  );
  await expect(
    jumpPage.getByText("请选择报告，查看对应原文、事实核对和样本。", {
      exact: true,
    }),
  ).toBeVisible();
  assert.deepEqual(jumpErrors, []);
  await jumpPage.close();

  // Real ClsReviewPrices with deferred synthetic verification: the receipt is
  // bound to the submitted day and only a valid response replaces it, while the
  // evidence panel reads exactly the opened date/hash identity.
  const pricePage = await browser.newPage(),
    priceErrors = [];
  pricePage.on("pageerror", (error) => {
    priceErrors.push(error.message);
    console.error(error.message);
  });
  await pricePage.route("**/*", (route) =>
    route.request().url().startsWith(base) ? route.continue() : route.abort(),
  );
  const prices = pricePage.locator('section[aria-label="固定样本与价格观察"]'),
    priceDay = prices.locator('input[type="date"]'),
    receiptText = prices.getByText(/最近一次成功核对/);
  await pricePage.goto(base + "/intel/review?clsReport=report-a&clsTab=prices");
  await priceDay.fill("2020-01-01");
  await prices
    .getByRole("button", { name: "查询样本日期", exact: true })
    .click();
  await expect(
    prices.getByText("归属：当前报告", { exact: true }),
  ).toBeVisible();
  await pricePage.evaluate(() => {
    window.holdVerify = true;
    window.detailQueries = [];
  });
  await prices
    .getByRole("button", { name: "读取行情并核对", exact: true })
    .click();
  await pricePage.waitForFunction(() => window.verifyCalls === 1);
  await expect(receiptText).toHaveCount(0);
  // Changing the queried day while the request is in flight must not move the
  // receipt to the new day.
  await priceDay.fill("2020-01-02");
  await prices
    .getByRole("button", { name: "查询样本日期", exact: true })
    .click();
  await expect(
    prices.getByText("归属：另一报告", { exact: true }),
  ).toBeVisible();
  await pricePage.evaluate(() => window.releaseVerify());
  await expect(receiptText).toContainText("2020-01-01");
  await expect(receiptText).toContainText("cccccccccc");
  const savedAt = await pricePage.evaluate(() =>
    new Date(window.verifyNow).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
    }),
  );
  await expect(receiptText).toContainText(`保存于 ${savedAt}`);
  await expect(priceDay).toHaveValue("2020-01-02");
  // A confirmed receipt alone never opens or reads the detail.
  assert.deepEqual(await pricePage.evaluate(() => window.detailQueries), []);

  // The receipt button reads exactly the saved date and full hash.
  await prices
    .getByRole("button", { name: "查看本次核对证据", exact: true })
    .click();
  await expect(
    prices.getByText(/所查核对：日期 2020-01-01 · 版本 cccccccccc/),
  ).toBeVisible();
  assert.deepEqual(
    (await pricePage.evaluate(() => window.detailQueries)).at(-1),
    { date: "2020-01-01", hash: "c".repeat(64) },
  );
  await expect(prices.locator("pre")).toContainText("c".repeat(64));
  await expect(prices.locator("pre")).toContainText("fixture-root");

  // A read error shows only the error and retries the same identity.
  await pricePage.evaluate(() => {
    window.evidenceMode = "error";
  });
  await prices
    .getByRole("button", { name: "收起核对证据", exact: true })
    .click();
  await prices
    .getByRole("button", { name: "查看本次核对证据", exact: true })
    .click();
  await expect(prices.getByText("合成证据读取失败")).toBeVisible();
  await expect(prices.getByText(/该版本已不存在/)).toHaveCount(0);
  const beforeRetry = await pricePage.evaluate(
    () => window.detailRefetches || 0,
  );
  await prices.getByRole("button", { name: "重试读取", exact: true }).click();
  await pricePage.waitForFunction(
    (n) => (window.detailRefetches || 0) > n,
    beforeRetry,
  );

  // Only an explicit null is reported as gone.
  await pricePage.evaluate(() => {
    window.evidenceMode = "null";
  });
  await prices
    .getByRole("button", { name: "收起核对证据", exact: true })
    .click();
  await prices
    .getByRole("button", { name: "查看本次核对证据", exact: true })
    .click();
  await expect(
    prices.getByText("该版本已不存在，可能所属报告已清理。", { exact: true }),
  ).toBeVisible();

  // A response for another identity is never rendered as this evidence.
  await pricePage.evaluate(() => {
    window.evidenceMode = "wrong";
  });
  await prices
    .getByRole("button", { name: "收起核对证据", exact: true })
    .click();
  await prices
    .getByRole("button", { name: "查看本次核对证据", exact: true })
    .click();
  await expect(
    prices.getByText("核对证据身份不一致，未显示；请重新打开。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(prices.locator("pre")).toHaveCount(0);

  // The in-page history entry opens the exact selected version identity.
  await pricePage.evaluate(() => {
    window.evidenceMode = "ok";
    window.versions = {
      items: [
        {
          id: "v1",
          hash: "1".repeat(64),
          checkedAt: 1700000000001,
          date: "2020-01-01",
          source: { root: "history-one", benchmark: "b", adjustment: "none" },
          outcomes: [],
          warnings: [],
        },
        {
          id: "v2",
          hash: "2".repeat(64),
          checkedAt: 1700000000002,
          date: "2020-01-01",
          source: { root: "history-two", benchmark: "b", adjustment: "none" },
          outcomes: [],
          warnings: [],
        },
      ],
      hasMore: true,
      nextCursor: "cursor-2",
    };
  });
  await prices
    .getByRole("button", { name: "收起核对证据", exact: true })
    .click();
  await priceDay.fill("2020-01-01");
  await prices
    .getByRole("button", { name: "查询样本日期", exact: true })
    .click();
  await expect(
    prices.getByRole("combobox", { name: "价格核对版本" }),
  ).toContainText("1111111111");
  await prices
    .getByRole("button", { name: "读取完整核对证据", exact: true })
    .click();
  await expect(
    prices.getByText(/所查核对：日期 2020-01-01 · 版本 1111111111/),
  ).toBeVisible();
  assert.equal(
    (await pricePage.evaluate(() => window.detailQueries)).at(-1).hash,
    "1".repeat(64),
  );
  await expect(prices.locator("pre")).toContainText("1".repeat(64));
  // Paging the version list clears the open evidence instead of retargeting it.
  await prices.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(prices.getByText(/所查核对/)).toHaveCount(0);
  // Choosing another version clears it too.
  await prices
    .getByRole("button", { name: "读取完整核对证据", exact: true })
    .click();
  await expect(prices.getByText(/所查核对/)).toBeVisible();
  await prices.getByRole("combobox", { name: "价格核对版本" }).click();
  await pricePage.getByRole("option", { name: /2222222222/ }).click();
  await expect(prices.getByText(/所查核对/)).toHaveCount(0);

  // Identity failures keep the previous receipt and stay apart from feedback.
  await pricePage.evaluate(() => {
    window.verifyMode = "wrongDate";
    window.holdVerify = true;
  });
  await priceDay.fill("2020-01-02");
  await prices
    .getByRole("button", { name: "查询样本日期", exact: true })
    .click();
  await expect(
    prices.getByText("归属：另一报告", { exact: true }),
  ).toBeVisible();
  const verifyBefore = await pricePage.evaluate(() => window.verifyCalls);
  await prices
    .getByRole("button", { name: "读取行情并核对", exact: true })
    .click();
  await pricePage.waitForFunction((n) => window.verifyCalls > n, verifyBefore);
  await pricePage.evaluate(() => window.releaseVerify());
  await expect(
    prices.getByText(
      /核对回执身份校验失败：返回日期 2020-01-04 与提交日期 2020-01-02 不一致/,
    ),
  ).toBeVisible();
  await expect(receiptText).toContainText("2020-01-01");
  await expect(receiptText).toContainText("cccccccccc");
  // The rejected identity must not also show a generic success broadcast.
  await expect(prices.getByText(/价格核对已完成/)).toHaveCount(0);

  await pricePage.evaluate(() => {
    window.verifyMode = "badHash";
  });
  const badHashBefore = await pricePage.evaluate(() => window.verifyCalls);
  await prices
    .getByRole("button", { name: "读取行情并核对", exact: true })
    .click();
  await pricePage.waitForFunction((n) => window.verifyCalls > n, badHashBefore);
  await pricePage.evaluate(() => window.releaseVerify());
  await expect(
    prices.getByText(/核对回执身份校验失败：返回版本摘要格式无效/),
  ).toBeVisible();
  await expect(receiptText).toContainText("cccccccccc");

  await pricePage.evaluate(() => {
    window.verifyMode = "badTime";
  });
  const badTimeBefore = await pricePage.evaluate(() => window.verifyCalls);
  await prices
    .getByRole("button", { name: "读取行情并核对", exact: true })
    .click();
  await pricePage.waitForFunction((n) => window.verifyCalls > n, badTimeBefore);
  await pricePage.evaluate(() => window.releaseVerify());
  await expect(
    prices.getByText(/核对回执身份校验失败：返回保存时间无效/),
  ).toBeVisible();
  await expect(receiptText).toContainText("cccccccccc");

  // A finite value beyond the JS date range is not a saved time either.
  await pricePage.evaluate(() => {
    window.verifyMode = "overflowTime";
  });
  const overflowBefore = await pricePage.evaluate(() => window.verifyCalls);
  await prices
    .getByRole("button", { name: "读取行情并核对", exact: true })
    .click();
  await pricePage.waitForFunction((n) => window.verifyCalls > n, overflowBefore);
  await pricePage.evaluate(() => window.releaseVerify());
  await expect(
    prices.getByText(/核对回执身份校验失败：返回保存时间无效/),
  ).toBeVisible();
  await expect(receiptText).toContainText("2020-01-01");
  await expect(receiptText).toContainText("cccccccccc");
  await expect(prices.getByText(/价格核对已完成/)).toHaveCount(0);

  // The next verification clears the local identity error.
  await pricePage.evaluate(() => {
    window.verifyMode = "ok";
  });
  const okBefore = await pricePage.evaluate(() => window.verifyCalls);
  await prices
    .getByRole("button", { name: "读取行情并核对", exact: true })
    .click();
  await pricePage.waitForFunction((n) => window.verifyCalls > n, okBefore);
  await expect(prices.getByText(/核对回执身份校验失败/)).toHaveCount(0);
  await pricePage.evaluate(() => window.releaseVerify());
  await expect(receiptText).toContainText("2020-01-02");

  // An ordinary day change also clears an open evidence panel.
  await prices
    .getByRole("button", { name: "查看本次核对证据", exact: true })
    .click();
  await expect(prices.getByText(/所查核对/)).toBeVisible();
  await priceDay.fill("2020-01-03");
  await prices
    .getByRole("button", { name: "查询样本日期", exact: true })
    .click();
  await expect(
    prices.getByText("所属报告已清理，样本日期占位保留。", { exact: true }),
  ).toBeVisible();
  await expect(prices.getByText(/所查核对/)).toHaveCount(0);
  assert.deepEqual(priceErrors, []);
  await pricePage.close();

  console.log(
    JSON.stringify({
      ok: true,
      components: 2,
      cleanupScenarios: 6,
      exportScenarios: 6,
    }),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
