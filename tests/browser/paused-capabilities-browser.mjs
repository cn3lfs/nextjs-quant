/** Real controls with isolated data; never starts a backend or sends a mutation. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";

const stub = `
const config={enabled:true,noon:'11:20',late:'14:40',rpsPeriod:120,minimumRps:80,pool:null,source:'tdx-local',czscConfig:0};
const query=data=>({data,isFetching:false,isLoading:false,refetch(){}});
export const api=new Proxy({}, {get:(_,name)=>name==='useUtils'?()=>({}):{
  useQuery:()=>query(name==='intradaySummary'?{config,worker:{running:false,error:null},lastCheck:null}:undefined),
  useMutation:()=>({isPending:false,mutate(){window.mutations.push(name)}})
}});`;
const negative = process.argv.includes("--negative-control");
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';
import {IntradayControls} from './src/components/intraday/intraday-controls';
import {MonitorEditor} from './src/components/signals/monitor-editor';
import {newMonitorDraft} from './src/lib/strategy-facts/monitor-workspace-draft';
window.mutations=[];
createRoot(document.getElementById('root')).render(<><IntradayControls/><MonitorEditor draft={{...newMonitorDraft(),enabled:true}} channels={[]} watchlist={[]} busy={false} onChange={()=>{}} onSave={()=>window.mutations.push('save-subscription')} onClose={()=>{}}/></>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  alias: { "~": "./src" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "isolated-capability-fixture",
      setup(b) {
        b.onResolve({ filter: /^~\/trpc\/react$/ }, () => ({
          path: "api",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /intraday-history-panel$/ }, () => ({
          path: "history",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents:
            path === "api"
              ? stub
              : "export const IntradayHistoryPanel=()=>null;",
          loader: "js",
          resolveDir: process.cwd(),
        }));
        if (negative)
          b.onLoad(
            { filter: /[\\/]lib[\\/]common[\\/]capabilities\.ts$/ },
            ({ path }) => ({
              // In-memory violation proves the disabled-control assertion detects a bypass.
              contents: readFileSync(path, "utf8").replace(
                "return policy.operations.includes(operation);",
                "return true;",
              ),
              loader: "ts",
            }),
          );
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
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByText("编辑参数", { exact: true }).click();
  const run = page.getByRole("button", {
    name: "检查并执行当前时段",
    exact: true,
  });
  assert.equal(
    await run.isDisabled(),
    true,
    "paused manual execution must be disabled",
  );
  const intraday = page.getByRole("checkbox", {
    name: "自动预选订阅设置（调度暂停期间不生效）",
  });
  const monitor = page.getByRole("checkbox", {
    name: "自动监控订阅设置（调度暂停期间不生效）",
  });
  for (const control of [intraday, monitor]) {
    assert.equal(await control.isDisabled(), true);
    assert.equal(
      await control.isChecked(),
      true,
      "stored preference must remain unchanged",
    );
  }
  // Native disabled state prevents activation even from an explicit DOM click.
  await run.evaluate((button) => button.click());
  assert.deepEqual(await page.evaluate(() => window.mutations), []);
  await page.getByRole("button", { name: "保存订阅设置", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.mutations), [
    "save-subscription",
  ]);
  assert.deepEqual(errors, []);
  console.log(
    "Paused execution and enable controls disabled; saved preferences retained; configuration save remains available.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
