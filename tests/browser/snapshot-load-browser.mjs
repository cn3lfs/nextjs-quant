/** Actual hook and TanStack mutations; deferred responses expose selection races. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {useSnapshotLoad} from './src/components/market/use-snapshot-load';
const client=new QueryClient({defaultOptions:{mutations:{retry:false}}});
function App(){const [selected,setSelected]=useState('none');
const load=useSnapshotLoad({onSuccess:s=>setSelected(s.symbol),onError:e=>window.notices.push(e.message)});
window.loader=load; window.view={selected,pending:load.isPending,error:load.error?.message??null};
return <div>{selected}</div>}
window.requests=[];window.notices=[];
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
      name: "deferred-transport",
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
  await page.goto("http://127.0.0.1/snapshot-fixture");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => window.loader);
  const start = async (symbol) => {
    const count = await page.evaluate((symbol) => {
      const count = window.requests.length;
      window.loader.mutate({ symbol, period: "day", source: "local" });
      return count;
    }, symbol);
    await page.waitForFunction(
      (count) => window.requests.length === count + 1,
      count,
    );
    return count;
  };
  const accept = async () => {
    await page.evaluate(() =>
      window.loader.acceptSnapshot({
        id: "saved-candidate",
        symbol: "sh600000",
        period: "day",
        bars: [],
      }),
    );
    await page.waitForFunction(
      () =>
        window.view.selected === "sh600000" &&
        !window.view.pending &&
        !window.view.error,
    );
  };
  const failed = await start("sh600519");
  await page.evaluate(
    (index) => window.requests[index].reject(Error("old source missing")),
    failed,
  );
  await page.waitForFunction(() => window.view.error === "old source missing");
  await accept();
  const delayed = await start("sh600001");
  await accept();
  await page.evaluate(
    (index) =>
      window.requests[index].resolve({
        id: "late",
        symbol: "sh600001",
        bars: [],
      }),
    delayed,
  );
  // Two paints flush the mutation notification and React render without a timer race.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.deepEqual(await page.evaluate(() => window.view), {
    selected: "sh600000",
    pending: false,
    error: null,
  });
  const lateFailure = await start("sh600002");
  await accept();
  await page.evaluate(
    (index) => window.requests[index].reject(Error("late failure")),
    lateFailure,
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.deepEqual(await page.evaluate(() => window.notices), [
    "old source missing",
  ]);
  assert.deepEqual(await page.evaluate(() => window.view), {
    selected: "sh600000",
    pending: false,
    error: null,
  });
  const latest = await start("sh600003");
  await page.evaluate(
    (index) =>
      window.requests[index].resolve({
        id: "current",
        symbol: "sh600003",
        bars: [],
      }),
    latest,
  );
  await page.waitForFunction(
    () => window.view.selected === "sh600003" && !window.view.pending,
  );
  console.log(
    "snapshot selection: stale error, late success/failure and next request passed",
  );
} finally {
  await browser.close();
}
