/** Before/after component comparison over the same live isolated read APIs.
 * Historical source is supplied explicitly, never checked back into the repository.
 * Current shared CSS/components are used for both; this is not the old complete app build.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = process.env.BASE ?? "http://127.0.0.1:3223";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const old = process.env.NEWS_BASELINE_FILE;
assert.ok(old, "Supply the saved pre-change NewsPanel source");
const stub = `
import {useState,useEffect} from 'react';
import SuperJSON from 'superjson';
const passive=data=>({data,isLoading:false,isFetching:false,refetch(){}});
const mutation=()=>({isPending:false,mutate(){throw Error('No mutations in performance comparison')}});
function query(proc,input,options={}){
 const key=JSON.stringify(input),enabled=options.enabled!==false;
 const [state,setState]=useState({data:undefined,isLoading:true,isFetching:true}),[refresh,setRefresh]=useState(0);
 useEffect(()=>{if(!enabled)return;let active=true;setState(s=>({...s,isFetching:true}));
 fetch('/fixture?proc='+proc+'&input='+encodeURIComponent(SuperJSON.stringify({...input,cutoff:Date.parse('2025-01-07T16:00:00+08:00')})))
 .then(r=>r.json()).then(raw=>{if(active){const data=SuperJSON.deserialize(raw.result.data);setState({data,isLoading:false,isFetching:false});window.lastResultKey=key;window.reads++;}});
 return()=>{active=false};},[proc,key,enabled,refresh]);
 return {...state,refetch(){setRefresh(n=>n+1)}};
}
export const api={useUtils:()=>({newsAnalyses:{invalidate(){}},newsArchiveHistory:{invalidate(){}},newsAnalysis:{invalidate(){}}}),
 news:{useQuery:(input,options)=>query('news',input,options)},newsWorkspace:{useQuery:(input,options)=>query('newsWorkspace',input,options)},
 newsAnalyses:{useQuery:()=>passive([])},newsAnalysis:{useQuery:()=>passive(null)},job:{useQuery:()=>passive(null)},newsTaskState:{useQuery:()=>passive(null)},
 newsAnalysisContext:{useQuery:()=>passive({model:'fixture:no-network'})},
 aggregateNewsDay:{useMutation:mutation},analyzeNews:{useMutation:mutation},cancel:{useMutation:mutation}};`;
const bundles = {};
for (const mode of ["before", "after"]) {
  const result = await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {NewsPanel} from './src/components/news/news-panel';window.reads=0;createRoot(document.getElementById('root')).render(<NewsPanel/>);`,
      loader: "tsx",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: { "~": "./src" },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "read-api",
        setup(b) {
          b.onResolve({ filter: /^~\/trpc\/react$/ }, () => ({
            path: "trpc",
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: stub,
            loader: "js",
            resolveDir: process.cwd(),
          }));
          if (mode === "before")
            b.onLoad({ filter: /news-panel\.tsx$/ }, () => ({
              contents: readFileSync(old, "utf8"),
              loader: "tsx",
              resolveDir: resolve("src/components/news"),
            }));
        },
      },
    ],
  });
  bundles[mode] = result.outputFiles[0].text;
}
const chunks = resolve(".next/static/chunks"),
  css = readdirSync(chunks)
    .filter((f) => f.endsWith(".css"))
    .map((f) => readFileSync(join(chunks, f), "utf8"))
    .join("\n");
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/fixture") {
    const procedure = url.searchParams.get("proc");
    assert.ok(["news", "newsWorkspace"].includes(procedure));
    const reply = await fetch(
      base +
        "/api/trpc/" +
        procedure +
        "?input=" +
        encodeURIComponent(url.searchParams.get("input")),
      { headers: { origin: base, "x-quant-client": "workbench" } },
    );
    res.setHeader("content-type", "application/json");
    res.end(await reply.text());
    return;
  }
  if (url.pathname === "/style.css") {
    res.setHeader("content-type", "text/css");
    res.end(css);
    return;
  }
  if (url.pathname.endsWith(".js")) {
    res.setHeader("content-type", "text/javascript");
    res.end(bundles[url.pathname.includes("before") ? "before" : "after"]);
    return;
  }
  const mode = url.searchParams.get("mode") === "before" ? "before" : "after";
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/' +
      mode +
      '.js"></script>',
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  results = [];
const summarize = (values) => {
  values.sort((a, b) => a - b);
  return {
    n: values.length,
    p50: values[Math.floor(values.length * 0.5)],
    p95: values[Math.ceil(values.length * 0.95) - 1],
  };
};
try {
  for (const mode of ["before", "after"]) {
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const navigations = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      await page.goto(
        `http://127.0.0.1:${server.address().port}/news?mode=${mode}`,
      );
      await page.waitForFunction(() => window.reads === 1);
      navigations.push(performance.now() - start);
    }
    const filtering = [],
      paging = [];
    async function click(name) {
      await page.evaluate((name) => {
        window.started = performance.now();
        window.beforeReads = window.reads;
        [...document.querySelectorAll("button")]
          .find((b) => b.textContent === name)
          .click();
      }, name);
      await page.waitForFunction(() => window.reads > window.beforeReads);
      return page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                r(performance.now() - window.started),
              ),
            ),
          ),
      );
    }
    for (let i = 0; i < 30; i++) {
      await page
        .getByLabel("新闻关键词", { exact: true })
        .fill(i % 2 ? "" : "末尾关键词");
      filtering.push(await click("查询新闻"));
    }
    for (let i = 0; i < 30; i++)
      paging.push(
        await click(
          (i % 2 ? "上一页" : "下一页") + (mode === "after" ? "新闻" : ""),
        ),
      );
    assert.deepEqual(errors, []);
    results.push({
      mode,
      navigation: summarize(navigations),
      filter: summarize(filtering),
      page: summarize(paging),
      dom: await page.locator("*").count(),
      errors,
    });
    await page.close();
  }
  writeFileSync(
    join(tmpdir(), "logs", "quant-news", "browser-component-compare.json"),
    JSON.stringify(
      {
        results,
        note: "Saved old NewsPanel vs current; same current shared CSS/components; full old news and new summary from same10000 indexed source through a local proxy; no client query cache in either harness; 10nav/30filter/30page. Not a comparison of whole app versions.",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  server.close();
}
