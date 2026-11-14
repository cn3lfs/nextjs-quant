import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const bundle = await build({
  stdin: {
    contents: `import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';
import {PanelCache,usePanelVisible} from './src/components/workbench/keep-alive';
window.mounts={};
function Panel({id}) {const visible=usePanelVisible();useEffect(()=>{window.mounts[id]=(window.mounts[id]??0)+1},[]);return <output data-panel={id} data-visible={visible}>{id}</output>}
const panels=Object.fromEntries(['/market','/a','/b','/c','/d','/e'].map(id=>[id,<Panel id={id}/>]));
function App(){const [active,setActive]=useState('/market');window.navigate=setActive;return <><output id="active">{active}</output><PanelCache active={active} panels={panels}/></>};
createRoot(document.getElementById('root')).render(<App/>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  jsx: "automatic",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
});
const server = createServer((request, response) => {
  response.setHeader(
    "Content-Type",
    request.url === "/bundle.js"
      ? "text/javascript"
      : "text/html;charset=utf-8",
  );
  response.end(
    request.url === "/bundle.js"
      ? bundle.outputFiles[0].text
      : '<div id="root"></div><script src="/bundle.js"></script>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const navigate = async (path) => {
    await page.evaluate((path) => window.navigate(path), path);
    await page.waitForFunction(
      (path) => document.querySelector("#active").textContent === path,
      path,
    );
  };
  for (const path of ["/a", "/b", "/c", "/d", "/e"]) await navigate(path);
  assert.equal(await page.locator("[data-panel]").count(), 6);
  const before = await page.evaluate(() => ({ ...window.mounts }));
  for (const path of [
    "/tasks",
    "/trade-ledger",
    "/stock-pool",
    "/reports/report/example",
  ])
    await navigate(path);
  assert.equal(
    await page.locator("[data-panel]").count(),
    6,
    "framework routes must not evict cached panels",
  );
  assert.equal(
    await page.locator('[data-panel][data-visible="true"]').count(),
    0,
  );
  for (const path of Object.keys(before)) await navigate(path);
  assert.deepEqual(await page.evaluate(() => window.mounts), before);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: framework routes hide cached panels without taking slots, eviction or remount",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
