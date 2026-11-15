/** Actual export controls with synthetic reads and controllable cache cleanup. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, expect } from "@playwright/test";

const api = `
const report={versionNumber:1,importedAt:1,sourcePath:'fixture',size:1,observedAt:1,
 report:{title:'合成报告',reportDate:'2026-11-13',hash:'a'.repeat(64),warnings:[],markdown:'fixture'}};
const data={clsReviewExport:report,tradeWorkspaceEnvironment:{today:'2026-11-13',mockEnabled:false},
 tradeWorkspacePage:{version:'fixture',summary:{count:0,buys:0,sells:0,fees:0},items:[],nextCursor:null}};
const utils=new Proxy({}, {get:(_,name)=>({
 fetch:async()=>{window.fetchCalls++;if(window.fetchFailure)throw Error('合成导出失败');
  return name==='clsReviewExportAll'?{report}:{filename:'fixture.json',mime:'application/json',content:'{}',count:0};},
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
window.fetchCalls=0;window.resetCalls=0;window.downloads=0;window.revoked=0;
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
        b.onResolve({ filter: /^~\/app\/trade-ledger\/actions$/ }, () => ({
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
    ["/intel/review?clsReport=fixture&clsTab=info", "导出报告与全部关联复盘"],
    ["/accounts?view=history", "导出筛选全集 JSON"],
  ]) {
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
      const pending = path.startsWith("/intel/review")
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
          page.getByText("导出缓存清理失败，请刷新页面后重试。", {
            exact: true,
          }),
        ).toBeVisible();
      if (outcome === "both-fail")
        await expect(
          page.getByText("合成导出失败", { exact: true }),
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
  console.log(JSON.stringify({ ok: true, components: 2, cleanupScenarios: 6 }));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
