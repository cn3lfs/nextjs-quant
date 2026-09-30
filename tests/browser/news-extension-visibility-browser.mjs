/** Actual extension components: a model response finishing after tab hide must not refetch history. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const stub = `
const query=data=>({data,isFetching:false,isLoading:false,refetch(){window.manualReads++;}});
const unused=()=>({isPending:false,mutate(){throw Error('Unexpected action')}});
export const api={useUtils:()=>({job:{invalidate(){}}}),
newsThemes:{useQuery:()=>query(null)},themePrices:{useQuery:()=>query(null)},
analyzeNewsThemes:{useMutation:options=>({isPending:false,mutate(){options.onSuccess({id:'fixture'})}})},
checkThemePrices:{useMutation:unused},cancel:{useMutation:unused},
job:{useQuery:input=>query(input.id?window.task:null)}};`;
const result = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {NewsThemesPanel} from './src/components/news/news-themes-panel';window.manualReads=0;window.task={status:'running'};function App(){const [tick,setTick]=useState(0);window.redraw=()=>setTick(tick+1);return <NewsThemesPanel id="fixture-analysis"/>}createRoot(document.getElementById('root')).render(<App/>);`,
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
      name: "controlled-response",
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
      ? result.outputFiles[0].text
      : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>',
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page
    .getByRole("button", { name: "AI 提炼跨行业主题", exact: true })
    .click();
  await page
    .getByRole("button", { name: "取消主题研究", exact: true })
    .waitFor();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    window.task = {
      status: "completed",
      result: {
        id: "fixture-theme",
        model: "fixture",
        sources: [],
        aggregation: { conflicts: [] },
        ranked: [],
        result: {
          summary: { text: "合成完成结果", citations: [] },
          themes: [],
          background: [],
          risks: [],
          missing: [],
        },
      },
    };
    window.redraw();
  });
  await page.getByText(/合成完成结果/).waitFor();
  assert.equal(await page.evaluate(() => window.manualReads), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      lateCompletionWhileHidden: true,
      historyRefetches: 0,
      errors,
    }),
  );
} finally {
  await browser.close();
  server.close();
}
