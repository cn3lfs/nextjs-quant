/** Real state/load hooks: explicit chart ownership and saved-candidate cold entry. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const bundle = await build({
  stdin: {
    contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {useMarketState} from './src/components/market/use-market-state';
const client=new QueryClient({defaultOptions:{mutations:{retry:false}}});
function App(){window.market=useMarketState('local');return <output>{window.market.loaded?.id??'no snapshot'}</output>}
window.requests=[];
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
      name: "deferred-snapshot-transport",
      setup(b) {
        b.onLoad({ filter: /trpc[\\/]react\.tsx$/ }, () => ({
          loader: "tsx",
          contents: `import {useMutation} from '@tanstack/react-query';
export const api={snapshot:{useMutation:()=>useMutation({mutationFn:input=>new Promise((resolve,reject)=>window.requests.push({input,resolve,reject}))})}};`,
        }));
      },
    },
  ],
});
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://127.0.0.1/screen");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => window.market);
  assert.equal(await page.evaluate(() => window.requests.length), 0);
  await page.evaluate(() =>
    window.market.load.acceptSnapshot({
      id: "saved-candidate",
      symbol: "sh600000",
      period: "5m",
      bars: [],
    }),
  );
  await page.waitForFunction(
    () => window.market.loaded?.id === "saved-candidate",
  );
  await page.evaluate(() => {
    history.pushState(null, "", "/scan");
    window.market.enterMarket(null);
  });
  assert.equal(await page.evaluate(() => window.requests.length), 0);
  // Reading a bare chart route must not write history and cancel another
  // navigation being committed by Next. Explicit selections below still do.
  assert.equal(new URL(page.url()).search, "");
  assert.equal(await page.evaluate(() => window.market.period), "5m");
  await page.evaluate(() => window.market.setMarketSource("tencent"));
  await page.waitForFunction(() => window.market.marketSource === "tencent");
  await page.evaluate(() => window.market.selectMarketSymbol("sh600040"));
  await page.waitForFunction(() => window.requests.length === 1);
  assert.deepEqual(await page.evaluate(() => window.requests[0].input), {
    symbol: "sh600040",
    period: "5m",
    source: "tencent",
  });
  await page.evaluate(() => window.market.enterMarket("sh600040"));
  assert.equal(await page.evaluate(() => window.requests.length), 1);
  // A new candidate also takes ownership from an unresolved request.
  await page.evaluate(() => {
    window.market.load.acceptSnapshot({
      id: "next-candidate",
      symbol: "sh600001",
      period: "day",
      bars: [],
    });
    window.requests[0].resolve({
      id: "late",
      symbol: "sh600040",
      period: "5m",
      bars: [],
    });
  });
  await page.waitForFunction(
    () => window.market.loaded?.id === "next-candidate",
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await page.evaluate(() => window.market.loaded.id),
    "next-candidate",
  );
  assert.equal(new URL(page.url()).searchParams.get("symbol"), "sh600001");
  await page.evaluate(() => window.market.selectMarketSymbol("sh600002"));
  await page.waitForFunction(() => window.requests.length === 2);
  await page.evaluate(() =>
    window.requests[1].reject(new Error("failed chart")),
  );
  await page.waitForFunction(
    () => window.market.load.error?.message === "failed chart",
  );
  await page.evaluate(() =>
    window.market.load.acceptSnapshot({
      id: "recovery-candidate",
      symbol: "sh600001",
      period: "day",
      bars: [],
    }),
  );
  await page.waitForFunction(
    () => window.market.loaded?.id === "recovery-candidate",
  );
  assert.equal(await page.evaluate(() => window.market.load.error), null);
  assert.equal(await page.evaluate(() => window.market.load.isPending), false);
  // Navigate back before a different security's request resolves. The old
  // displayed snapshot alone must not let the in-flight request keep ownership.
  await page.evaluate(() => window.market.selectMarketSymbol("sh600002"));
  await page.waitForFunction(() => window.requests.length === 3);
  await page.evaluate(() => window.market.enterMarket("sh600001"));
  await page.waitForFunction(() => window.requests.length === 4);
  assert.equal(
    await page.evaluate(() => window.requests[3].input.symbol),
    "sh600001",
  );
  await page.evaluate(() =>
    window.requests[2].resolve({
      id: "wrong-late",
      symbol: "sh600002",
      period: "day",
      bars: [],
    }),
  );
  await page.waitForTimeout(100);
  assert.equal(
    await page.evaluate(() => window.market.loaded.symbol),
    "sh600001",
  );
  await page.evaluate(() =>
    window.requests[3].resolve({
      id: "restored",
      symbol: "sh600001",
      period: "day",
      bars: [],
    }),
  );
  await page.waitForFunction(() => window.market.loaded.id === "restored");
  await page.evaluate(() =>
    window.market.load.acceptSnapshot({
      id: "adjusted-candidate",
      symbol: "sh600001",
      period: "day",
      adjustment: "forward",
      bars: [],
    }),
  );
  await page.waitForFunction(() => window.market.adjustment === "forward");
  assert.equal(new URL(page.url()).searchParams.get("adjustment"), "forward");
  console.log(
    "Market state: no implicit IO, exact cold candidate, source/period preservation, no duplicate navigation, late response rejected",
  );
} finally {
  await browser.close();
}
