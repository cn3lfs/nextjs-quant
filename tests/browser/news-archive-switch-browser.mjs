/** 新闻档案切换：真实 NewsPanel + esbuild 假 transport，无服务端/数据库。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "@playwright/test";

const transport = `
  import {useQuery} from '@tanstack/react-query';
  const f=window.newsFixture={requests:[],originalRequests:[]};
  const scenario=new URL(location.href).searchParams.get('scenario')||'default';
  const primary={key:'primary',role:'all',label:'全部电报',primary:true,available:true,message:null};
  const complement={key:'complement',role:'red',label:'加红电报',primary:false,available:true,message:null};
  const archives=scenario==='unconfigured'
    ? {options:[{...primary,role:'unspecified',label:'当前资料（未注明）'}],unconfigured:[{role:'all',label:'全部电报'},{role:'red',label:'加红电报'}],note:null}
    : scenario==='conflict'
      ? {options:[primary,{...complement,available:false,message:'与主档案指向同一文件，不能作为独立来源。'}],unconfigured:[],note:'主档案与互补档案指向同一文件，只显示主档案；请修正配置。'}
      : {options:[primary,complement],unconfigured:[],note:null};
  const primaryArchive={key:'primary',role:'all',label:'全部电报',primary:true};
  const complementArchive={key:'complement',role:'red',label:'加红电报',primary:false};
  function pageData(input){
    const red=input.role==='red', second=!!input.cursor, start=second?51:1;
    const items=Array.from({length:50},(_,i)=>({
      id:start+i,
      publishedAt:new Date(1700000000000+(start+i)*1000).toISOString(),
      collectedAt:'2025-01-07T15:59:30+08:00',
      title:(red?'备标题':'主标题')+(start+i),
      preview:(red?'备正文':'主正文')+(start+i),
      contentLength:100,
      hash:(red?'b':'a').repeat(64)
    }));
    return {
      items,total:121,
      source:(red?'b':'a').repeat(64),
      fingerprint:(red?'c':'d').repeat(64),
      nextCursor:second?null:{time:1,id:50,filter:'e'.repeat(64)},
      cutoff:input.cutoff,from:input.cutoff-7*86400000,readAt:Date.now(),latestPublishedAt:null,
      archive:red?complementArchive:primaryArchive
    };
  }
  export const api={
    newsWorkspace:{useQuery(input,options){return useQuery({queryKey:['newsWorkspace',input],...options,queryFn:async()=>{f.requests.push(input);return pageData(input);}});}},
    newsAnalysisContext:{useQuery(_input,options){return useQuery({queryKey:['newsAnalysisContext'],...options,queryFn:async()=>({model:'fixture',archives})});}},
    newsTaskState:{useQuery(){return {data:null,isLoading:false,error:null,refetch(){}};}},
    newsOriginal:{useQuery(input,options){return useQuery({queryKey:['newsOriginal',input],...options,queryFn:async()=>{f.originalRequests.push(input);return {item:{id:input.id,title:'原文'+input.id,publishedAt:new Date().toISOString(),collectedAt:null,content:'正文内容',url:null,hash:'f'.repeat(64)},source:input.source,readAt:Date.now(),archive:input.filter.role==='red'?complementArchive:primaryArchive};}});}},
    analyzeNews:{useMutation(){return {mutate(){},isPending:false,error:null};}},
    cancel:{useMutation(){return {mutate(){},isPending:false,error:null};}},
    useUtils(){return {newsTaskState:{invalidate(){}},newsArchiveHistory:{invalidate(){}},newsAnalysis:{invalidate(){}}};}
  };
`;

const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {NewsPanel} from './src/components/news/news-panel';
    const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
    createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><NewsPanel/></QueryClientProvider>);`,
    loader: "tsx",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  jsx: "automatic",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  plugins: [
    {
      name: "news-transport",
      setup(build) {
        build.onLoad({ filter: /trpc[\\/]react\.tsx$/ }, () => ({
          contents: transport,
          loader: "tsx",
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});
const css = await postcss([tailwind()]).process(
  readFileSync("src/styles/globals.css", "utf8"),
  { from: resolve("src/styles/globals.css") },
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const open = async (scenario = "") => {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(document, "hasFocus", {
      value: () => true,
      configurable: true,
    });
  });
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<meta charset="utf-8"><div id="root" style="padding:16px"></div>',
    }),
  );
  await page.goto(
    `http://127.0.0.1/intel${scenario ? `?scenario=${scenario}` : ""}`,
  );
  await page.addStyleTag({ content: css.css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return { page, errors };
};
const query = (page) =>
  JSON.parse(new URL(page.url()).searchParams.get("newsQuery") ?? "{}");
const lastRequest = (page) =>
  page.evaluate(() => window.newsFixture.requests.at(-1));
try {
  const { page, errors } = await open();
  await page.getByRole("radiogroup", { name: "新闻档案来源" }).waitFor();
  await page.getByRole("radio", { name: "全部电报" }).waitFor();
  await page.getByText("主标题1", { exact: true }).waitFor();
  await page
    .getByText("主档案 · 全部电报 · 匹配 121 条", { exact: false })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "AI 分类与影响分析（本页全部）" })
      .isEnabled(),
    true,
  );

  // 切换加红：列表、URL、查询输入和分页游标一起切到互补档案。
  await page.getByRole("radio", { name: "加红电报" }).click();
  await page.getByText("备标题1", { exact: true }).waitFor();
  assert.equal(query(page).role, "red");
  assert.equal((await lastRequest(page)).role, "red");
  assert.equal((await lastRequest(page)).cursor, undefined);
  await page
    .getByText("互补档案 · 加红电报 · 匹配 121 条", { exact: false })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "备用档案仅供阅读与打开原文" })
      .isDisabled(),
    true,
  );
  await page.getByText("互补档案不提交模型分析", { exact: false }).waitFor();

  // 切回主档案：URL 不再带角色，查询输入同步。
  await page.getByRole("radio", { name: "全部电报" }).click();
  await page.getByText("主标题1", { exact: true }).waitFor();
  assert.equal(query(page).role, undefined);
  assert.equal((await lastRequest(page)).role, undefined);

  // 翻页后切换必须回到第一页，不沿用旧游标。
  await page.getByRole("button", { name: "下一页新闻" }).click();
  await page.getByText("主标题51", { exact: true }).waitFor();
  assert.ok((await lastRequest(page)).cursor);
  await page.getByRole("radio", { name: "加红电报" }).click();
  await page.getByText("备标题1", { exact: true }).waitFor();
  assert.equal((await lastRequest(page)).cursor, undefined);
  await page.getByRole("radio", { name: "全部电报" }).click();
  await page.getByText("主标题1", { exact: true }).waitFor();

  // 原文入口按当前档案读取；返回后切换不保留旧 newsId/newsSource。
  await page.getByRole("button", { name: "阅读原文" }).first().click();
  await page.getByText("新闻原文", { exact: true }).waitFor();
  const original = await page.evaluate(() =>
    window.newsFixture.originalRequests.at(-1),
  );
  assert.equal(original.filter.role, undefined);
  assert.equal(original.source, "a".repeat(64));
  await page.getByRole("button", { name: "返回新闻列表" }).click();
  await page.getByText("主标题1", { exact: true }).waitFor();
  await page.getByRole("radio", { name: "加红电报" }).click();
  await page.getByText("备标题1", { exact: true }).waitFor();
  const url = new URL(page.url());
  assert.equal(url.searchParams.get("newsId"), null);
  assert.equal(url.searchParams.get("newsSource"), null);
  assert.equal(query(page).role, "red");
  assert.deepEqual(errors, []);
  await page.close();

  // 未配置角色：明确提示，且不出现可切换的第二个来源。
  const unconfigured = await open("unconfigured");
  await unconfigured.page
    .getByText("当前档案：主档案 · 当前资料（未注明）", { exact: false })
    .waitFor();
  await unconfigured.page
    .getByText("未配置：全部电报、加红电报", { exact: false })
    .waitFor();
  assert.equal(
    await unconfigured.page
      .getByRole("radiogroup", { name: "新闻档案来源" })
      .count(),
    0,
  );
  assert.deepEqual(unconfigured.errors, []);
  await unconfigured.page.close();

  // 同一文件双角色：只保留一个可用来源，并说明冲突。
  const conflict = await open("conflict");
  await conflict.page
    .getByText("互补档案 · 加红电报：与主档案指向同一文件", { exact: false })
    .waitFor();
  await conflict.page
    .getByText("主档案与互补档案指向同一文件", { exact: false })
    .waitFor();
  assert.equal(
    await conflict.page
      .getByRole("radiogroup", { name: "新闻档案来源" })
      .count(),
    0,
  );
  assert.deepEqual(conflict.errors, []);
  await conflict.page.close();
  console.log(
    "新闻档案切换浏览器：主/互补切换、URL与查询同步、翻页重置、原文来源、未配置与同文件冲突提示通过",
  );
} finally {
  await browser.close();
}
