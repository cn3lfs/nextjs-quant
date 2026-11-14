/** Actual chart and React effects; API fixture records requests without data IO. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";

const stub = `import {useState,useEffect} from 'react';
import fixture from './tests/fixtures/breakout-valid.json';
import {analyzeBreakout} from 'trading-strategies/research/breakout/breakout';
export const bars=fixture.bars;
const breakout=analyzeBreakout(bars,0,true);
window.requests=[];window.queryOptions={};
const query=name=>({useQuery(input,options={}){
  const key=JSON.stringify(input),enabled=options.enabled!==false;
  const [data,setData]=useState();
  window.queryOptions[name]={input,enabled};
  useEffect(()=>{
    if(!enabled)return;
    window.requests.push({name,id:input?.snapshotId,painted:!!document.querySelector('canvas')});
    setData(name==='breakout'?breakout:name==='czsc'?{status:'ok',families:[]}:undefined);
  },[key,enabled]);
  return {data: input?.snapshotId==='broken'?undefined:data,error:input?.snapshotId==='broken'?new Error('fixture failure'):null,isPending:data===undefined,refetch(){}};
}});
export const api=new Proxy({}, {get:(_,name)=>query(name)});`;
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {CzscMarketChart} from './src/components/market/chart';
import {PanelVisibility} from './src/components/workbench/keep-alive';
import {bars} from '~/trpc/react';
function App(){const[id,setId]=useState('a'),[visible,setVisible]=useState(true),[annotations,setAnnotations]=useState(true);
window.chartFixture={setId,setVisible,setAnnotations};
return <PanelVisibility visible={visible}><div hidden={!visible}><CzscMarketChart bars={bars} period='day' snapshotId={id} annotations={annotations} height={450}/></div></PanelVisibility>}
createRoot(document.getElementById('root')).render(<App/>);`,
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
      name: "isolated-api",
      setup(b) {
        b.onResolve({ filter: /^~\/trpc\/react$/ }, () => ({
          path: "api",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: stub,
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
  const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() =>
    window.requests?.some((r) => r.name === "breakout" && r.id === "a"),
  );
  assert.equal((await page.locator("canvas").count()) > 0, true);
  await page.evaluate(() => {
    window.originalCanvas = document.querySelector("canvas");
  });
  assert.equal(
    await page.evaluate(() =>
      window.requests
        .filter((r) => ["czsc", "breakout"].includes(r.name))
        .every((r) => r.painted),
    ),
    true,
  );
  const breakout = page.getByRole("checkbox", { name: "双突破", exact: true });
  const czsc = page.getByRole("checkbox", { name: "缠论结构", exact: true });
  await breakout.uncheck();
  await czsc.uncheck();
  // Waiting for paints avoids mistaking a deferred request for a suppressed one.
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
        ),
    );
  await settle();
  assert.equal(
    await page.evaluate(() => window.queryOptions.breakout.enabled),
    false,
    "unchecked breakout must disable its query",
  );
  assert.equal(
    await page.evaluate(() => window.queryOptions.czsc.enabled),
    false,
    "unchecked Chan overlay must disable its query",
  );
  await page.evaluate(() => window.chartFixture.setId("b"));
  await settle();
  assert.equal(
    await page.evaluate(
      () => window.requests.filter((r) => r.id === "b").length,
    ),
    0,
  );
  await breakout.check();
  await page.waitForFunction(() =>
    window.requests.some((r) => r.name === "breakout" && r.id === "b"),
  );
  assert.equal(
    await page.evaluate(() =>
      window.requests.some((r) => r.name === "czsc" && r.id === "b"),
    ),
    false,
  );
  await czsc.check();
  await page.waitForFunction(() =>
    window.requests.some((r) => r.name === "czsc" && r.id === "b"),
  );
  await page.evaluate(() => {
    window.chartFixture.setVisible(false);
    window.chartFixture.setId("c");
  });
  await settle();
  assert.equal(
    await page.evaluate(() => window.requests.some((r) => r.id === "c")),
    false,
  );
  assert.equal(
    await page.evaluate(() => window.queryOptions.czscSchema.enabled),
    false,
  );
  await page.evaluate(() => window.chartFixture.setVisible(true));
  await page.waitForFunction(() =>
    window.requests.some((r) => r.name === "breakout" && r.id === "c"),
  );
  await page.evaluate(() => {
    window.chartFixture.setAnnotations(false);
    window.chartFixture.setId("d");
  });
  await settle();
  assert.equal(
    await page.evaluate(() => window.requests.some((r) => r.id === "d")),
    false,
  );
  await page.evaluate(() => {
    window.chartFixture.setAnnotations(true);
    window.chartFixture.setId("broken");
  });
  await page
    .getByText("双突破计算失败：fixture failure", { exact: true })
    .waitFor();
  await breakout.uncheck();
  assert.equal(
    await page
      .getByText("双突破计算失败：fixture failure", { exact: true })
      .count(),
    0,
  );
  assert.deepEqual(errors, []);
  assert.equal(
    await page.evaluate(
      () => document.querySelector("canvas") === window.originalCanvas,
    ),
    true,
    "annotation changes must not recreate the price chart",
  );
  console.log(
    "Chart paints before analysis; toggles, hidden panels and unsupported scopes suppress requests; re-enabling resumes only selected overlays.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
