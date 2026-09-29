/** Real Connections UI and TanStack Query with synthetic transport; no database or external calls.
 * CONNECTIONS_BASELINE=1 captures the pre-change behavior instead of asserting new UX.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const baseline = process.env.CONNECTIONS_BASELINE === "1";
const logDir = join(tmpdir(), "logs", "quant-connections");
mkdirSync(logDir, { recursive: true });
const stub = `
import {useQuery, useMutation, useQueryClient} from '@tanstack/react-query';
const fixtures = {newsBudget: {used: 0, limit: 8, day: '2026-09-28', exhausted: false}, researchSkills: [], securityNames: {}};
function query(name) {return {useQuery(input, options) {return useQuery({queryKey:[name], queryFn:async()=>{window.requests.push(name); return fixtures[name]}, retry:false, ...options})}}}
function mutation(name) {return {useMutation(options) {return useMutation({...options, mutationFn:async(input)=>{
 window.mutations.push({name,input});
 if(name === 'snapshot') return await new Promise(resolve=>(window.snapshotResolvers??={})[input.symbol]=()=>resolve({id:input.symbol,symbol:input.symbol,bars:[]}));
 if(name === 'checkConnection') {
  await new Promise(resolve=>window.resolveCheck=resolve);
  if(window.failCheck) throw Error('合成诊断请求失败');
  return {...input,checkedAt:Date.now(),elapsedMs:10,connection:'ok',data:'ok',freshness:'unknown',dataAsOf:'2026-09-25',referenceAsOf:null,referenceSource:'合成参考',sampleCount:2,message:'样本读取成功；仅代表所选证券与周期',nextAction:'核对交易日历'};
 }
 if(name !== 'saveSettings') throw Error('Unexpected side effect: '+name);
 await new Promise(resolve=>window.resolveSave=resolve);
 if(window.failSave) throw Error('合成保存失败，请重试');
 window.saved = input;
 return input;
}})}}}
export const api={...Object.fromEntries(Object.keys(fixtures).map(name=>[name,query(name)])),
 snapshot:mutation('snapshot'),saveSettings:mutation('saveSettings'),checkConnection:mutation('checkConnection'),saveChannel:mutation('saveChannel'),testChannel:mutation('testChannel'),
 useUtils(){const client=useQueryClient();return Object.fromEntries(['status','securityProfile','securityNames','securities','channels'].map(name=>[name,{invalidate(){window.invalidations.push(name);return client.invalidateQueries({queryKey:[name]})}}]))}
};`;
const bundle = await build({
  stdin: {
    contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Connections} from './src/components/workbench/connections';
import {PanelVisibility} from './src/components/workbench/keep-alive';
import {settingsSchema} from './src/lib/domain';
import {useSnapshotLoad} from './src/components/market/use-snapshot-load';
import {useSnapshotCache} from './src/lib/stores/snapshot-cache';
window.requests=[];window.mutations=[];window.invalidations=[];
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
function SnapshotProbe(){const options={onSuccess:s=>(window.published??=[]).push(s.symbol)};const stock=useSnapshotLoad(options),crypto=useSnapshotLoad(options),futures=useSnapshotLoad(options);window.startSnapshot=()=>{stock.mutate({symbol:'sh600000',period:'day',source:'local'});crypto.mutate({symbol:'cxBTCUSDT',period:'day'});futures.mutate({symbol:'fuGC00Y',period:'day'})};window.snapshotCacheSize=()=>useSnapshotCache.getState().entries.size;return null}
function App(){const [visible,setVisible]=useState(true); const [value,setValue]=useState(settingsSchema.parse({tdxRoot:'C:/fixture/tdx',autoAnalysis:false}));
window.setVisible=setVisible;window.setSettings=(patch)=>setValue(v=>({...v,...patch}));
return <QueryClientProvider client={client}><SnapshotProbe/><PanelVisibility visible={visible}><div hidden={!visible}><Connections value={value} channels={[]} coverage={null} notify={message=>window.lastNotice=message}/></div></PanelVisibility></QueryClientProvider>}
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
      name: "fixtures",
      setup(b) {
        if (process.env.CONNECTIONS_BASELINE_FILE)
          b.onLoad({ filter: /workbench[\\/]connections\.tsx$/ }, () => ({
            contents: readFileSync(
              process.env.CONNECTIONS_BASELINE_FILE,
              "utf8",
            ),
            loader: "tsx",
            resolveDir: resolve("src/components/workbench"),
          }));
        b.onResolve({ filter: /^~\/trpc\/react$/ }, () => ({
          path: "trpc",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: stub,
          loader: "js",
          resolveDir: process.cwd(),
        }));
        b.onLoad({ filter: /crypto-connections\.tsx$/ }, () => ({
          contents: "export function CryptoConnections(){return null}",
          loader: "tsx",
        }));
      },
    },
  ],
});
const cssPath = resolve("src/styles/globals.css");
const css = await postcss([tailwind()]).process(readFileSync(cssPath, "utf8"), {
  from: cssPath,
});
const server = createServer((req, res) => {
  const asset =
    req.url === "/bundle.js" ? "js" : req.url === "/style.css" ? "css" : "html";
  res.setHeader(
    "Content-Type",
    {
      js: "text/javascript",
      css: "text/css",
      html: "text/html; charset=utf-8",
    }[asset],
  );
  res.end(
    asset === "js"
      ? bundle.outputFiles[0].text
      : asset === "css"
        ? css.css
        : '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div class="page" id="root"></div><script src="/bundle.js"></script>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const root = page.getByLabel("通达信安装目录", { exact: true });
  await root.waitFor();
  const save = page.getByRole("button", { name: "保存设置", exact: true });
  const initialDisabled = await save.isDisabled();
  const savePanel = await save.evaluate((el) =>
    el.closest("section")?.getAttribute("aria-label"),
  );
  await root.fill("C:/fixture/edited");
  await page.evaluate(() => window.setVisible(false));
  const before = await page.evaluate(() => window.requests.length);
  await page.clock.runFor(610000);
  const hiddenRequests = await page.evaluate(
    (n) => window.requests.slice(n),
    before,
  );
  await page.evaluate(() => window.setVisible(true));
  await page.clock.resume();
  assert.equal(
    await root.inputValue(),
    "C:/fixture/edited",
    "Same-session draft survives route hide",
  );
  await page.screenshot({
    path: join(logDir, baseline ? "before.png" : "after.png"),
    fullPage: true,
  });
  if (!baseline) {
    assert.equal(initialDisabled, true, "Unchanged settings must not save");
    assert.equal(hiddenRequests.length, 0, "Hidden settings must not poll");
    await page.evaluate(() => window.startSnapshot());
    await save.click();
    await root.fill("C:/fixture/newer");
    await page.evaluate(() => window.resolveSave());
    await page.waitForFunction(() => window.lastNotice === "设置已保存");
    await page.evaluate(() =>
      Object.values(window.snapshotResolvers).forEach((resolve) => resolve()),
    );
    await page.waitForTimeout(30);
    assert.equal(
      await page.evaluate(() => (window.published ?? []).includes("sh600000")),
      false,
      "Old configuration response cannot publish after save",
    );
    assert.deepEqual(await page.evaluate(() => [...window.published].sort()), [
      "cxBTCUSDT",
      "fuGC00Y",
    ]);
    assert.equal(await page.evaluate(() => window.snapshotCacheSize()), 2);
    assert.equal(
      await root.inputValue(),
      "C:/fixture/newer",
      "Late success preserves newer edit",
    );
    assert.equal(await save.isDisabled(), false, "New edit remains dirty");
    await page.evaluate(() => (window.failSave = true));
    await save.click();
    await page.evaluate(() => window.resolveSave());
    await page.getByRole("alert").filter({ hasText: "合成保存失败" }).waitFor();
    assert.equal(await root.inputValue(), "C:/fixture/newer");
    await page.evaluate(() => (window.failSave = false));
    await save.click();
    await page.evaluate(() => window.resolveSave());
    await page.waitForFunction(
      () => window.saved.tdxRoot === "C:/fixture/newer",
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-settings-state]")
          ?.getAttribute("data-settings-state") === "saved",
    );
    // Clean remote changes are adopted; dirty local fields survive updates.
    await page.evaluate(() =>
      window.setSettings({ tdxRoot: "C:/fixture/remote", analysisLimit: 4 }),
    );
    await page.waitForFunction(() =>
      document.querySelector('input[value="C:/fixture/remote"]'),
    );
    await root.fill("C:/fixture/draft");
    await page.evaluate(() => window.setSettings({ analysisLimit: 6 }));
    assert.equal(await root.inputValue(), "C:/fixture/draft");
    await page.getByRole("button", { name: "撤销修改" }).click();
    assert.equal(await root.inputValue(), "C:/fixture/remote");
    const mutationsBeforeInvalid = await page.evaluate(
      () => window.mutations.length,
    );
    await root.fill("");
    await save.click();
    await page.getByText("请输入通达信安装目录。", { exact: true }).waitFor();
    assert.equal(await root.getAttribute("aria-invalid"), "true");
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "setting-tdxRoot",
    );
    assert.equal(
      await page.evaluate(() => window.mutations.length),
      mutationsBeforeInvalid,
    );
    await page.getByRole("button", { name: "撤销修改" }).click();
    const diagnostic = page.getByRole("button", { name: "检查已保存配置" });
    await diagnostic.focus();
    await page.keyboard.press("Enter");
    await page.getByLabel("样本证券", { exact: true }).fill("sz000001");
    await page.evaluate(() => window.resolveCheck());
    await page
      .getByText("以下为旧配置或旧选择的检查结果，请重新检查。")
      .waitFor();
    await diagnostic.click();
    await page.evaluate(() => window.resolveCheck());
    await page
      .getByText("以下为旧配置或旧选择的检查结果，请重新检查。")
      .waitFor({ state: "hidden" });
    await page.getByText("时点：无法确认", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByText("以下为旧配置或旧选择的检查结果，请重新检查。")
        .count(),
      0,
    );
    await page.evaluate(() => (window.failCheck = true));
    await diagnostic.click();
    await page.evaluate(() => window.resolveCheck());
    await page
      .getByRole("alert")
      .filter({ hasText: "合成诊断请求失败" })
      .waitFor();
    assert.equal(
      await page.getByText("连接：可访问", { exact: true }).count(),
      0,
      "Transport failure cannot leave an old green result",
    );
    await page.evaluate(() => (window.failCheck = false));
    await diagnostic.click();
    await page.evaluate(() => window.resolveCheck());
    await page.getByText("连接：可访问", { exact: true }).waitFor();
    await page.setViewportSize({ width: 640, height: 800 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "Narrow layout does not overflow",
    );
    await page.screenshot({ path: join(logDir, "narrow.png"), fullPage: true });
  }
  assert.deepEqual(errors, []);
  const result = {
    mode: baseline ? "baseline" : "optimized",
    initialDisabled,
    savePanel,
    hiddenRequests,
    errors,
  };
  writeFileSync(
    join(logDir, baseline ? "baseline.json" : "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
