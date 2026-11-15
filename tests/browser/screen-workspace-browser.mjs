/** Actual formula/factor editors; local API fixture never reads data or starts work. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";

const apiFixture = `import {useEffect} from 'react';
window.requests=[];window.mutations=[];window.queryOptions={};window.started=[];
const utils={formulas:{invalidate:async()=>{}}};
export const api=new Proxy({}, {get:(_,name)=>name==='useUtils'?()=>utils:{
  useQuery(input,options={}){
    const enabled=options.enabled!==false,key=JSON.stringify(input);
    window.queryOptions[name]={enabled,poll:typeof options.refetchInterval==='function'?options.refetchInterval({state:{data:{status:'running'}}}):false};
    useEffect(()=>{if(enabled)window.requests.push({name,input})},[key,enabled]);
    return {data:name==='formulas'?[]:name==='job'&&input?.id?{id:input.id,status:'running'}:undefined,isLoading:false,isFetching:false,refetch(){}};
  },
  useMutation(options={}){
    const execute=async(input)=>{window.mutations.push({name,input});const result={...input,id:name==='factorEvaluate'?'factor-job':name==='saveFormula'?'00000000-0000-4000-8000-000000000001':'formula-job'};options.onSuccess?.(result);return result};
    return {isPending:false,mutate:execute,mutateAsync:execute};
  }
}});`;
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ScreenView} from './src/components/workbench/screen-view';
import {PanelVisibility} from './src/components/workbench/keep-alive';
function App(){const[visible,setVisible]=useState(true);window.setScreenVisible=setVisible;
const state={names:{},jobs:{data:[]},screened:{},reviews:{},screenReport:{},screenPage:0,excludedPage:0,errorPage:0,screenQuery:'',screenSort:'original',screenDirection:'desc',selectFormulaJob:id=>window.started.push(id)};
return <PanelVisibility visible={visible}><div hidden={!visible}><ScreenView state={state}/></div></PanelVisibility>}
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
      name: "isolated-screen-api",
      setup(b) {
        b.onResolve({ filter: /^~\/trpc\/react$/ }, () => ({
          path: "api",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /^next\/navigation$/ }, () => ({
          path: "router",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents:
            path === "api"
              ? apiFixture
              : "export const usePathname=()=>'/scan?tab=formula';export const useRouter=()=>({push(){throw new Error('unexpected navigation')}});",
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
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const formula = page.getByLabel("公式源码", { exact: true });
  const factor = page.getByLabel("因子公式", { exact: true });
  const run = page.getByRole("button", { name: "全市场执行公式", exact: true });
  const check = page.getByRole("button", {
    name: "语法检查与未来函数门禁",
    exact: true,
  });
  await formula.waitFor();
  assert.equal(await factor.isVisible(), false);
  for (const label of ["本地条件草案", "本地可复现条件", "生成条件草案"])
    assert.equal(await page.getByText(label, { exact: true }).count(), 0);
  assert.equal(await run.isDisabled(), true);
  await formula.fill("选股:C>MA(C,20);");
  await check.click();
  assert.equal(await run.isEnabled(), true);
  await page.getByRole("button", { name: "保存公式", exact: true }).click();
  await page.getByText("公式已保存", { exact: true }).waitFor();
  await page.getByRole("radio", { name: "单因子评估", exact: true }).click();
  await factor.waitFor();
  assert.equal(await formula.isVisible(), false);
  assert.equal(
    await page.evaluate(() => window.queryOptions.formulas.enabled),
    false,
    "hidden formula editor must not fetch",
  );
  await factor.fill("C/REF(C,5)-1;");
  await page.getByLabel("因子评估开始日期").fill("2026-01-01");
  await page.getByLabel("因子评估结束日期").fill("2026-10-30");
  await page.getByRole("button", { name: "评估因子", exact: true }).click();
  await page.waitForFunction(() => window.queryOptions.job.enabled);
  assert.equal(
    await page.evaluate(() => window.queryOptions.job.poll > 0),
    true,
  );
  await page.getByRole("radio", { name: "公式筛选", exact: true }).click();
  await formula.waitFor();
  assert.equal(await formula.inputValue(), "选股:C>MA(C,20);");
  assert.equal(
    await run.isEnabled(),
    true,
    "switching must preserve validation",
  );
  assert.equal(
    await page.evaluate(() => window.queryOptions.job.enabled),
    false,
    "hidden factor panel must not fetch",
  );
  assert.equal(await page.evaluate(() => window.queryOptions.job.poll), false);
  await run.click();
  await page.waitForFunction(() => window.started.length === 1);
  assert.deepEqual(await page.evaluate(() => window.started), ["formula-job"]);
  await formula.fill("选股:REF(C,-1)>C;");
  assert.equal(await run.isDisabled(), true);
  await check.click();
  assert.equal(await run.isDisabled(), true, "future input must stay blocked");
  await page.getByRole("radio", { name: "单因子评估", exact: true }).click();
  assert.equal(await factor.inputValue(), "C/REF(C,5)-1;");
  await page.evaluate(() => window.setScreenVisible(false));
  await page.waitForFunction(() => window.queryOptions.job.enabled === false);
  assert.equal(
    await page.evaluate(() => window.queryOptions.formulas.enabled),
    false,
  );
  await page.evaluate(() => window.setScreenVisible(true));
  await page.waitForFunction(() => window.queryOptions.job.enabled === true);
  const mutations = await page.evaluate(() => window.mutations);
  assert.deepEqual(
    mutations.map((m) => m.name),
    ["saveFormula", "factorEvaluate", "formulaScreen"],
  );
  assert.equal(mutations[2].input.source, "选股:C>MA(C,20);");
  assert.equal(mutations[2].input.id, "00000000-0000-4000-8000-000000000001");
  assert.deepEqual(errors, []);
  console.log(
    "Formula validation/save/run, factor drafts, result selection and hidden-query boundaries passed.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
