/** Actual route reconciliation + named session + loader, controlled transport only. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {usePathname} from 'next/navigation';
import {useMarketState} from './src/components/market/use-market-state';
import {MarketRouteSelection} from './src/components/market/market-route-selection';
import {useMarketSession} from './src/lib/stores/market-session';
const client=new QueryClient();window.calls=[];window.session=useMarketSession;
function App(){const state=useMarketState('local');window.market=state;const path=usePathname();
return <><output>{state.loaded?.symbol??'empty'}</output>{path==='/market'&&<MarketRouteSelection enterMarket={state.enterMarket}/>}</>}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><App/></QueryClientProvider>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  jsx: "automatic",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "local-transport",
      setup(b) {
        b.onResolve({ filter: /^next\/navigation$/ }, () => ({
          path: "navigation",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          loader: "js",
          resolveDir: process.cwd(),
          contents: `
import {useSyncExternalStore} from 'react';
const subscribe=f=>{window.addEventListener('popstate',f);return()=>window.removeEventListener('popstate',f)};
for(const key of ['pushState','replaceState']){const original=history[key].bind(history);history[key]=(...args)=>{original(...args);window.dispatchEvent(new PopStateEvent('popstate'))}}
export const usePathname=()=>useSyncExternalStore(subscribe,()=>location.pathname);
export const useSearchParams=()=>new URLSearchParams(useSyncExternalStore(subscribe,()=>location.search));`,
        }));
        b.onLoad({ filter: /trpc[\\/]react\.tsx$/ }, () => ({
          loader: "tsx",
          contents: `import {useMutation} from '@tanstack/react-query';
export const api={snapshot:{useMutation:()=>useMutation({mutationFn:async input=>{
window.calls.push(input);return {id:'snapshot-'+input.symbol,symbol:input.symbol,period:input.period,requestedSource:input.source,bars:[]};}})}};`,
        }));
      },
    },
  ],
});
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto(
    "http://127.0.0.1/market?symbol=sh600000&period=week&source=local&adjustment=forward",
  );
  const mount = () =>
    page.addScriptTag({ content: bundle.outputFiles[0].text });
  const idle = () =>
    page.waitForFunction(
      () => window.market?.loaded && !window.market.load.isPending,
    );
  await mount();
  await idle();
  assert.equal(await page.evaluate(() => window.calls.length), 1);
  const selection = () =>
    page.evaluate(() => {
      const s = window.session.getState();
      return [
        s.symbol,
        s.chartPeriod,
        s.marketSource,
        s.adjustment,
        s.marketView,
      ];
    });
  assert.deepEqual(await selection(), [
    "sh600000",
    "week",
    "local",
    "forward",
    "chart",
  ]);
  await page.evaluate(() => {
    history.pushState(
      null,
      "",
      "/market?symbol=sh600040&period=month&source=tencent&adjustment=backward&view=financial",
    );
  });
  await page.waitForFunction(() => window.market.loaded?.symbol === "sh600040");
  assert.deepEqual(await selection(), [
    "sh600040",
    "month",
    "tencent",
    "backward",
    "financial",
  ]);
  await page.goBack();
  await page.waitForFunction(() => window.market.symbol === "sh600000");
  await idle();
  assert.deepEqual(await selection(), [
    "sh600000",
    "week",
    "local",
    "forward",
    "chart",
  ]);
  await page.goForward();
  await page.waitForFunction(() => window.market.symbol === "sh600040");
  await idle();
  assert.deepEqual(await selection(), [
    "sh600040",
    "month",
    "tencent",
    "backward",
    "financial",
  ]);
  await page.reload();
  await mount();
  await idle();
  assert.deepEqual(await selection(), [
    "sh600040",
    "month",
    "tencent",
    "backward",
    "financial",
  ]);
  await page.evaluate(() => history.pushState(null, "", "/screen"));
  await page.waitForFunction(() => location.pathname === "/screen");
  const count = await page.evaluate(() => window.calls.length);
  await page.evaluate(() => {
    const s = window.session.getState();
    s.setSymbol("sh600001");
    s.setChartPeriod("5m");
    s.setMarketSource("local");
    s.setAdjustment("none");
  });
  await page.waitForTimeout(100);
  assert.equal(
    await page.evaluate(() => window.calls.length),
    count,
    "hidden selection updates must not request snapshots",
  );
  // A candidate selected by screening supersedes the previous chart and its URL.
  await page.evaluate(() => {
    window.session.getState().acceptSnapshot({
      id: "saved",
      symbol: "sh600001",
      period: "5m",
      bars: [],
    });
    history.pushState(null, "", "/market");
  });
  await page.waitForFunction(
    () =>
      window.market.loaded?.id === "saved" &&
      location.search.includes("base=5m"),
  );
  assert.equal(
    await page.evaluate(() => window.calls.length),
    count,
    "cold candidate must not be replaced by an automatic request",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: full selection URL, reload/back/forward, hidden no IO, exact saved 5m candidate",
  );
} finally {
  await browser.close();
}
