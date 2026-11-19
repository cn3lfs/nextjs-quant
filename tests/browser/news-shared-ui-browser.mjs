/** Actual components with synthetic tRPC data; no external requests or model calls.
 * node tests/news-shared-ui-browser.mjs
 * NEWS_BASELINE_FILE can point to the pre-change news-panel.tsx for comparison.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const baseline = process.env.NEWS_BASELINE_FILE;
const oldStub = `
import { useEffect } from 'react';
const data = {count: 100, latestPublishedAt: 1, items: [{id: 'fixture', title: '合成新闻', content: '仅供交互验证', publishedAt: 1, collectedAt: 1}]};
const utils = {newsAnalyses: {invalidate() {}}};
const query = (data) => ({data, isLoading: false, isFetching: false, refetch() {}});
const mutation = () => ({isPending: false, mutate() {throw Error('Unexpected mutation')}});
export const api = {
 useUtils: () => utils,
 newsAnalyses: {useQuery: () => query([])},
 newsAnalysis: {useQuery: () => query(null)},
 job: {useQuery: () => query(undefined)},
 aggregateNewsDay: {useMutation: mutation}, analyzeNews: {useMutation: mutation}, cancel: {useMutation: mutation},
 news: {useQuery(input) {
  const key = JSON.stringify(input);
  useEffect(() => {window.newsRequests.push(input)}, [key]);
  return {...query(data), refetch() {window.newsRequests.push(input)}};
 }}
};`;
const stub = baseline
  ? oldStub
  : `
import {useEffect,useState} from 'react';
const query=data=>({data,isLoading:false,isFetching:false,refetch(){}});
const mutation=()=>{const [isPending,setPending]=useState(false);return {isPending,mutate(input){setPending(true);(window.analysisInputs??=[]).push(input)}}};
const taskListeners=new Set();
window.setNewsTask=value=>{window.newsTask=value;for(const listener of taskListeners)listener()};
const useNewsTask=()=>{
 const [,force]=useState(0);
 useEffect(()=>{const listener=()=>force(value=>value+1);taskListeners.add(listener);return()=>{taskListeners.delete(listener)}},[]);
 return window.newsTask??null;
};
export const api={
 useUtils:()=>({newsArchiveHistory:{invalidate(){window.newsInvalidations.push('archive')}},newsAnalysis:{invalidate(){window.newsInvalidations.push('analysis')}},newsTaskState:{invalidate(){}}}),
 newsAnalysisContext:{useQuery:()=>query({model:'fixture:no-network'})},
 newsTaskState:{useQuery(id){const value=useNewsTask();return {...query(value&&value.id===id?value:null),isLoading:false,refetch(){}}}},
 newsAnalysis:{useQuery:()=>query(null)},
 newsResumePreflight:{useQuery:()=>query(null)},
 newsOriginal:{useQuery:()=>query(null)},
 newsArchiveHistory:{useQuery:()=>query({total:0,rows:[]})},
 aggregateNewsDay:{useMutation:mutation},
 analyzeNews:{useMutation:mutation},cancel:{useMutation:mutation},
 newsWorkspace:{useQuery(input,options){
  const key=JSON.stringify(input),enabled=options.enabled;
  useEffect(()=>{if(enabled)window.newsRequests.push(input)},[key,enabled]);
  return {...query({total:100,latestPublishedAt:1,source:'a'.repeat(64),fingerprint:'b'.repeat(64),nextCursor:{time:1,id:1,filter:'c'.repeat(64)},items:[{id:1,title:'合成新闻',preview:'仅供交互验证',publishedAt:1,collectedAt:1}]}),refetch(){window.newsRequests.push(input)}};
 }}
};`;
const bundle = await build({
  stdin: {
    contents: `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {NewsPanel} from './src/components/news/news-panel';
import {DataTable} from './src/components/ui/data-table';
window.newsRequests = [];
window.newsInvalidations = [];
const columns = [{accessorKey: 'value', header: '数值'}];
function App() {
 const [sorting, setSorting] = useState([]);
 return <><NewsPanel/><DataTable label="排序验证" columns={columns} data={[{id: 'a', value: 2}, {id: 'b', value: 1}]} rowCount={2} pagination={{pageIndex: 0, pageSize: 10}} sorting={sorting} onSortingChange={setSorting} onPaginationChange={()=>{}} getRowId={r=>r.id}/><output aria-label="排序状态">{JSON.stringify(sorting)}</output></>;
}
createRoot(document.getElementById('root')).render(<App/>);`,
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
        b.onResolve({ filter: /^~\/trpc\/react$/ }, () => ({
          path: "trpc",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: stub,
          loader: "js",
          resolveDir: process.cwd(),
        }));
        if (baseline)
          b.onLoad({ filter: /news-panel\.tsx$/ }, () => ({
            contents: readFileSync(baseline, "utf8"),
            loader: "tsx",
            resolveDir: resolve("src/components/news"),
          }));
      },
    },
  ],
});
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/bundle.js" ? "text/javascript" : "text/html; charset=utf-8",
  );
  res.end(
    req.url === "/bundle.js"
      ? bundle.outputFiles[0].text
      : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>',
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${base}${baseline ? "/news" : "/intel"}`);
  await page.waitForFunction(() => window.newsRequests.length === 1);
  await page.evaluate(() => {
    window.newsRequests = [];
  });
  const input = page.getByLabel("新闻关键词");
  await input.pressSequentially("market", { delay: 30 });
  const typingRequests = await page.evaluate(() => window.newsRequests.length);
  if (!baseline) {
    assert.equal(typingRequests, 0, "typing must not query partial keywords");
    assert.equal(
      await page
        .getByRole("button", {
          name: "AI 分类与影响分析（本页全部）",
          exact: true,
        })
        .isEnabled(),
      false,
      "unsubmitted filters cannot start analysis of the previous query",
    );
    await input.press("Enter");
    await page.waitForFunction(() => window.newsRequests.length === 1);
    assert.equal(
      await page.evaluate(() => window.newsRequests[0].query),
      "market",
    );
    await page
      .getByRole("button", { name: "下一页新闻", exact: true })
      .first()
      .click();
    await page.waitForFunction(
      () => window.newsRequests.at(-1).cursor?.id === 1,
    );
    await input.fill("新的关键词");
    await page.getByRole("button", { name: "查询新闻", exact: true }).click();
    await page.waitForFunction(
      () => window.newsRequests.at(-1).query === "新的关键词",
    );
    assert.equal(
      await page.evaluate(() => window.newsRequests.at(-1).cursor),
      undefined,
    );
    await page.evaluate(() => {
      window.newsRequests = [];
    });
    await page.getByRole("button", { name: "刷新至当前时间" }).click();
    await page.waitForFunction(() => window.newsRequests.length === 1);
    const sort = page.getByRole("button", { name: /数值/ });
    await sort.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="排序状态"]').textContent !== "[]",
    );
    const first = await page.getByLabel("排序状态").textContent();
    await page.keyboard.press("Space");
    assert.notEqual(await page.getByLabel("排序状态").textContent(), first);
    const table = page.getByRole("table", { name: "排序验证" });
    assert.ok(await table.getAttribute("aria-describedby"));
    assert.deepEqual(
      await table.locator("tbody td").allTextContents(),
      ["2", "1"],
      "server order must remain intact",
    );
    await page.getByRole("button", { name: "下一页新闻", exact: true }).click();
    await page.waitForFunction(
      () => window.newsRequests.at(-1).cursor?.id === 1,
    );
    await page
      .getByRole("button", {
        name: "AI 分类与影响分析（本页全部）",
        exact: true,
      })
      .dblclick();
    const calls = await page.evaluate(() => window.analysisInputs);
    assert.equal(
      calls.length,
      1,
      "double click must submit once while pending",
    );
    assert.equal(calls[0].pageSelection.cursor.id, 1);
    assert.equal(calls[0].pageSelection.fingerprint, "b".repeat(64));

    const savedId = `news-analysis-${"d".repeat(64)}`,
      recoveredId = `news-analysis-${"e".repeat(64)}`,
      submitted = JSON.stringify({
        cutoff: Math.floor(Date.now() / 60000) * 60000 - 3600000,
        query: "已提交条件",
        historical: true,
      });
    await page.goto(
      `${base}/intel?newsJob=job-1&newsQuery=${encodeURIComponent(submitted)}`,
    );
    await page.waitForFunction(() => window.newsRequests.length === 1);
    await page.getByRole("button", { name: "下一页新闻", exact: true }).click();
    await page.waitForFunction(
      () => window.newsRequests.at(-1).cursor?.id === 1,
    );
    await page.evaluate(() => {
      window.setNewsTask({
        id: "job-1",
        status: "running",
        phase: "合成运行",
        progress: 40,
        analysisId: null,
      });
    });
    await page.waitForFunction(() =>
      document.body.textContent.includes("合成运行"),
    );
    assert.equal(
      await page
        .getByRole("button", { name: "查看分析结果", exact: true })
        .count(),
      0,
      "running tasks must not offer a result link",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "查看已保存结果", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page.evaluate(() =>
        new URL(location.href).searchParams.has("analysis"),
      ),
      false,
      "running tasks must not open an archive automatically",
    );
    await page.getByRole("button", { name: "阅读原文", exact: true }).click();
    await page.getByRole("heading", { name: "新闻原文" }).waitFor();
    const originalUrl = await page.evaluate(() => location.href);
    await page.evaluate((analysisId) => {
      window.setNewsTask({
        id: "job-1",
        status: "completed",
        phase: "合成完成",
        progress: 100,
        analysisId,
      });
    }, savedId);
    await page
      .getByRole("button", { name: "查看分析结果", exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(() => location.href),
      originalUrl,
      "completion must not replace the original reading context",
    );
    assert.deepEqual(
      await page.evaluate(() => window.newsInvalidations),
      ["archive", "analysis"],
      "a completed task invalidates archive caches once",
    );
    await page.evaluate((analysisId) => {
      window.setNewsTask({
        id: "job-1",
        status: "completed",
        phase: "合成完成",
        progress: 100,
        analysisId,
      });
    }, savedId);
    await page.waitForTimeout(50);
    assert.deepEqual(
      await page.evaluate(() => window.newsInvalidations),
      ["archive", "analysis"],
      "the same id/status must not invalidate twice",
    );
    await page
      .getByRole("button", { name: "查看分析结果", exact: true })
      .click();
    await page.getByRole("heading", { name: "新闻分析依据" }).waitFor();
    const opened = await page.evaluate(() => {
      const url = new URL(location.href),
        newsQuery = url.searchParams.get("newsQuery");
      return {
        analysis: url.searchParams.get("analysis"),
        job: url.searchParams.get("newsJob"),
        query: JSON.parse(newsQuery).query,
        cursor: newsQuery.includes("cursor"),
        pages: JSON.parse(sessionStorage.getItem(`news-pages:${newsQuery}`)),
      };
    });
    assert.equal(opened.analysis, savedId);
    assert.equal(opened.job, "job-1");
    assert.equal(opened.query, "已提交条件");
    assert.equal(opened.cursor, false);
    assert.equal(opened.pages.length, 2, "the paging cursor is preserved");
    assert.equal(
      await page
        .getByRole("button", { name: "查看分析结果", exact: true })
        .count(),
      0,
      "an open archive hides its own result link",
    );
    await page
      .getByRole("button", { name: "返回新闻列表", exact: true })
      .click();
    await page.getByText("第2页", { exact: false }).waitFor();
    assert.equal(
      await page.getByLabel("新闻关键词").inputValue(),
      "已提交条件",
    );
    await page.evaluate(() => {
      window.setNewsTask({
        id: "job-1",
        status: "failed",
        phase: "合成失败",
        progress: 100,
        error: "合成错误",
        analysisId: null,
      });
    });
    await page.waitForFunction(() =>
      document.body.textContent.includes("合成失败"),
    );
    assert.equal(
      await page
        .getByRole("button", { name: "查看分析结果", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "查看已保存结果", exact: true })
        .count(),
      0,
      "failed tasks without an archive result must not guess an id",
    );
    assert.equal(
      await page.getByText("部分完成的成功批次可在分析历史查看。").count(),
      1,
    );
    assert.equal(
      await page.evaluate(() =>
        new URL(location.href).searchParams.has("analysis"),
      ),
      false,
      "a failed task must not navigate",
    );
    await page.evaluate(() => {
      window.setNewsTask({
        id: "job-1",
        status: "completed",
        phase: "合成异常ID",
        progress: 100,
        analysisId: "not-an-archive-id",
      });
    });
    await page.waitForFunction(() =>
      document.body.textContent.includes("合成异常ID"),
    );
    assert.equal(
      await page
        .getByRole("button", { name: "查看分析结果", exact: true })
        .count(),
      0,
      "an invalid analysis id must not become a result link",
    );
    await page.evaluate((analysisId) => {
      window.setNewsTask({
        id: "job-1",
        status: "cancelled",
        phase: "合成取消",
        progress: 0,
        analysisId,
      });
    }, recoveredId);
    await page
      .getByRole("button", { name: "查看已保存结果", exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(() =>
        new URL(location.href).searchParams.has("analysis"),
      ),
      false,
      "a cancelled task with a saved result must wait for an explicit click",
    );
    await page
      .getByRole("button", { name: "查看已保存结果", exact: true })
      .click();
    await page.getByRole("heading", { name: "新闻分析依据" }).waitFor();
    assert.equal(
      await page.evaluate(() =>
        new URL(location.href).searchParams.get("analysis"),
      ),
      recoveredId,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ baseline: !!baseline, typingRequests, ok: true, errors }),
  );
} finally {
  await browser?.close();
  server.close();
}
