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
const data={clsReviewExport:reports['report-a'],tradeWorkspaceEnvironment:{today:'2026-11-13',mockEnabled:false},
 tradeWorkspacePage:{version:'fixture',summary:{count:0,buys:0,sells:0,fees:0},items:[],nextCursor:null}};
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
 useQuery:()=>({data:data[name],isLoading:false,isFetching:false,refetch:async()=>{}}),
 useMutation:()=>({isPending:false,mutate:()=>{throw Error('Unexpected mutation')}}),
}});`;
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';
import {ClsReviewWorkspace} from './src/components/news/cls-review-workspace';
import {TradeLedgerPanel} from './src/components/portfolio/trade-ledger-panel';
window.fetchCalls=0;window.resetCalls=0;window.fetchIds=[];window.exportMode='ok';window.holdFetch=false;
window.downloads=0;window.revoked=0;
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
        b.onResolve({ filter: /^~\/app\/(?:accounts|trade-ledger)\/actions$/ }, () => ({
          path: "actions",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /\/use-task-visible$/ }, () => ({
          path: "visible",
          namespace: "fixture",
        }));
        b.onResolve(
          {
            filter:
              /^\.\/cls-review-(report-list|import|schedule|text|facts|prices)$/,
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
  assert.deepEqual(
    await page.evaluate(() => window.fetchIds.slice()),
    ["report-a"],
  );
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
