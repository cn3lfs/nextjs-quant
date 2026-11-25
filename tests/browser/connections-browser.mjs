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
const logDir =
  process.env.TASK_SHOT_DIR ?? join(tmpdir(), "logs", "quant-connections");
mkdirSync(logDir, { recursive: true });
const stub = `
import {useQuery, useMutation, useQueryClient} from '@tanstack/react-query';
const fixtures = {newsBudget: {used: 0, limit: 8, day: '2026-09-28', exhausted: false}, researchSkills: [], securityNames: {}, alertStatus: {subscriptions: [], strategies: []}, workspacePreferences: {closeToTray: false}, thsdkStatus: {enabled: false, configured: true, dllKnownVersion: '2.0.2', allowAutoFallback: false, authMode: 'account', guestModeEnabled: false, hasSavedCredentials: false, state: 'disabled', activeMode: null, authGeneration: 0, configRevision: 'rev-0', lastErrorCode: null, lastErrorMessage: null, circuitOpenUntil: null, updatedAt: 0}};
function query(name) {return {useQuery(input, options) {return useQuery({queryKey:[name], queryFn:async()=>{window.requests.push(name); return fixtures[name]}, retry:false, ...options})}}}
function mutation(name) {return {useMutation(options) {return useMutation({...options, mutationFn:async(input)=>{
 window.mutations.push({name,input});
 if(name === 'snapshot') return await new Promise(resolve=>(window.snapshotResolvers??={})[input.symbol]=()=>resolve({id:input.symbol,symbol:input.symbol,bars:[]}));
 if(name === 'checkConnection') {
  const patch = await new Promise(resolve=>window.checkQueue.push(resolve));
  if(window.failCheck) throw Error('合成诊断请求失败');
  return {...input,checkedAt:Date.now(),elapsedMs:10,connection:'ok',data:'ok',freshness:'unknown',dataAsOf:'2026-09-25',referenceAsOf:null,referenceSource:'合成参考',sampleCount:2,message:'样本读取成功；仅代表所选证券与周期',nextAction:'核对交易日历',...patch};
 }
 if(name === 'checkNewsSources') {
  await new Promise(resolve=>window.resolveNewsCheck=resolve);
  if(window.failNewsCheck) throw Error('合成新闻检查失败');
  return {configuration:input,checkedAt:Date.now(),database:{ok:Boolean(input.clsDbPath),message:input.clsDbPath?'合成数据库可读':'尚未配置财联社数据库'},python:{ok:true,message:'Python 3.12.0'}};
 }
 if(name !== 'saveSettings') throw Error('Unexpected side effect: '+name);
 await new Promise(resolve=>window.resolveSave=resolve);
 if(window.failSave) throw Error('合成保存失败，请重试');
 window.saved = input;
 return input;
}})}}}
export const api={...Object.fromEntries(Object.keys(fixtures).map(name=>[name,query(name)])),
 snapshot:mutation('snapshot'),saveSettings:mutation('saveSettings'),saveWorkspacePreferences:mutation('saveWorkspacePreferences'),checkConnection:mutation('checkConnection'),checkNewsSources:mutation('checkNewsSources'),saveChannel:mutation('saveChannel'),testChannel:mutation('testChannel'),saveAlertSubscription:mutation('saveAlertSubscription'),
 thsdkSaveConfig:mutation('thsdkSaveConfig'),thsdkSaveCredentials:mutation('thsdkSaveCredentials'),thsdkForgetCredentials:mutation('thsdkForgetCredentials'),thsdkLoginAccount:mutation('thsdkLoginAccount'),thsdkLoginGuest:mutation('thsdkLoginGuest'),thsdkStartQrcode:mutation('thsdkStartQrcode'),thsdkPollQrcode:mutation('thsdkPollQrcode'),thsdkCancelQrcode:mutation('thsdkCancelQrcode'),thsdkLogout:mutation('thsdkLogout'),
 useUtils(){const client=useQueryClient();return Object.fromEntries(['status','securityProfile','securityNames','securities','channels','alertStatus','workspacePreferences','thsdkStatus'].map(name=>[name,{invalidate(){window.invalidations.push(name);return client.invalidateQueries({queryKey:[name]})},setData(_k,v){return client.setQueryData([name],v)}}]))}
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
window.checkQueue=[];
window.resolveCheck=(value={})=>{window.checkQueue.shift()?.(value)};
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
function SnapshotProbe(){const options={onSuccess:s=>(window.published??=[]).push(s.symbol)};const stock=useSnapshotLoad(options),crypto=useSnapshotLoad(options),futures=useSnapshotLoad(options);window.startSnapshot=()=>{stock.mutate({symbol:'sh600000',period:'day',source:'local'});crypto.mutate({symbol:'cxBTCUSDT',period:'day'});futures.mutate({symbol:'fuGC00Y',period:'day'})};window.snapshotCacheSize=()=>useSnapshotCache.getState().entries.size;return null}
function App(){const [mounted,setMounted]=useState(true);window.setMounted=setMounted;const [visible,setVisible]=useState(true); const [value,setValue]=useState(settingsSchema.parse({tdxRoot:'C:/fixture/tdx'}));
window.setVisible=setVisible;window.setSettings=(patch)=>setValue(v=>({...v,...patch}));
return <QueryClientProvider client={client}><SnapshotProbe/><PanelVisibility visible={visible}><div hidden={!visible}>${process.env.FORM_LIFECYCLE_NEGATIVE === "1" ? "<div hidden={!mounted}>" : "{mounted && <div>"}<Connections value={value} channels={[]} coverage={null} notify={message=>window.lastNotice=message}/>${process.env.FORM_LIFECYCLE_NEGATIVE === "1" ? "</div>" : "</div>}"}</div></PanelVisibility></QueryClientProvider>}
createRoot(document.getElementById('root')).render(<App/>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  alias: { "~": "./src" },
  // Next replaces build-time environment flags; this standalone bundle has no
  // Next compiler. Keep the real Link component and supply the same boundary.
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
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
        // Unrelated panel whose polling query would pollute the visibility
        // assertions; the diagnostics under test do not depend on it.
        b.onLoad({ filter: /binance-history\.tsx$/ }, () => ({
          contents: "export function BinanceHistory(){return null}",
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
        : // Match Workbench's Topbar + page flow: settings' sticky top-14 offset
          // otherwise overlaps the section radios in a headerless fixture.
          '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><header class="topbar"><div class="topbar-title"><h1>数据与连接</h1></div></header><div class="page" id="root"></div><script src="/bundle.js"></script>',
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
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error(e.stack ?? e.message);
  });
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const root = page.getByLabel("通达信安装目录", { exact: true });
  await root.waitFor();
  assert.equal(
    await page.getByText("五分钟 CSV 导入", { exact: true }).count(),
    0,
  );
  assert.equal(await page.getByText(/微盛 CSV 数据目录/).count(), 0);
  assert.equal(await page.getByText(/五分钟导入按下方流程操作/).count(), 0);
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
    const beforeRemount = await page.evaluate(() => window.mutations.length);
    await page.evaluate(() => window.setMounted(false));
    await root.waitFor({ state: "hidden" });
    await page.evaluate(() => window.setMounted(true));
    await root.waitFor();
    assert.equal(
      await root.inputValue(),
      "C:/fixture/newer",
      "memory draft survives a normal route remount",
    );
    assert.equal(
      await page.getByRole("alert").filter({ hasText: "合成保存失败" }).count(),
      0,
      "route-local save error resets after leaving",
    );
    assert.equal(
      await page.evaluate(() => window.mutations.length),
      beforeRemount,
      "returning never replays a submit",
    );
    await page.evaluate(() => (window.failSave = false));
    await save.click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("button")].find((button) =>
          button.textContent.includes("保存设置"),
        )?.disabled,
    );
    assert.equal(
      await save.isDisabled(),
      true,
      "submission disables the current form",
    );
    const pendingCount = await page.evaluate(() => window.mutations.length);
    await page.evaluate(() => window.setMounted(false));
    await root.waitFor({ state: "hidden" });
    await page.evaluate(() => window.setMounted(true));
    await root.waitFor();
    assert.equal(await root.inputValue(), "C:/fixture/newer");
    assert.equal(
      await save.isDisabled(),
      false,
      "pending feedback is local to the unmounted page",
    );
    assert.equal(
      await page.evaluate(() => window.mutations.length),
      pendingCount,
    );
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
      window.setSettings({
        tdxRoot: "C:/fixture/remote",
        autoNewsDailyBatches: 4,
      }),
    );
    await page.waitForFunction(() =>
      document.querySelector('input[value="C:/fixture/remote"]'),
    );
    await root.fill("C:/fixture/draft");
    await page.evaluate(() => window.setSettings({ autoNewsDailyBatches: 6 }));
    assert.equal(await root.inputValue(), "C:/fixture/draft");
    await page.getByRole("button", { name: "撤销修改" }).click();
    assert.equal(await root.inputValue(), "C:/fixture/remote");
    const mutationsBeforeInvalid = await page.evaluate(
      () => window.mutations.length,
    );
    await root.fill("relative/tdx");
    await save.click();
    await page
      .getByText("请检查此项的格式或允许范围。", { exact: true })
      .waitFor();
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
    await root.fill("");
    await save.click();
    await page.evaluate(() => window.resolveSave());
    await page.waitForFunction(() => window.saved.tdxRoot === "");
    assert.equal(await root.inputValue(), "");
    await page.evaluate(() => window.setSettings(window.saved));
    assert.equal(
      await page
        .getByRole("button", { name: "扫描已保存目录", exact: true })
        .isDisabled(),
      true,
    );
    await page.screenshot({
      path: join(logDir, "unconfigured.png"),
      fullPage: true,
    });
    // The remaining diagnostic race cases use a configured source. The real
    // server's unconfigured failure is covered by connection-check.test.ts.
    await page.evaluate(() =>
      window.setSettings({ tdxRoot: "C:/fixture/remote" }),
    );
    await page.getByText("连接诊断 · 基于已保存设置", { exact: true }).click();
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
    // Same saved configuration, symbol and period across two sources form one
    // comparison, each row keeping its own last completed check.
    const diagnostics = page.getByRole("region", { name: "连接与数据检查" });
    const compareRegion = diagnostics.getByRole("region", {
      name: "同范围来源对照",
    });
    const compareRows = compareRegion.locator("tbody tr");
    const symbolInput = page.getByLabel("样本证券", { exact: true });
    const sourceSelect = page.getByRole("combobox", { name: "检查来源" });
    const periodSelect = page.getByRole("combobox", { name: "检查周期" });
    const choose = async (select, name) => {
      await select.click();
      await page.getByRole("option", { name, exact: true }).click();
    };
    await choose(sourceSelect, "tstdx");
    await diagnostic.click();
    await page.evaluate(() =>
      window.resolveCheck({
        dataAsOf: "2026-09-24",
        checkedAt: 1763000001000,
        connection: "error",
        data: "empty",
      }),
    );
    await compareRegion.waitFor();
    assert.equal(await compareRows.count(), 2);
    assert.equal(
      await compareRegion.getByText("通达信本地", { exact: true }).count(),
      1,
    );
    assert.equal(
      await compareRegion.getByText("tstdx", { exact: true }).count(),
      1,
    );
    assert.equal(
      await compareRegion
        .getByText("可访问 · 样本可用", { exact: true })
        .count(),
      1,
    );
    assert.equal(
      await compareRegion.getByText("失败 · 样本为空", { exact: true }).count(),
      1,
    );
    assert.deepEqual(
      await compareRows.locator("td:nth-child(3)").allInnerTexts(),
      ["2026-09-25", "2026-09-24"],
      "Each source keeps its own market last time",
    );
    const compareTimes = await compareRows
      .locator("td:nth-child(4)")
      .allInnerTexts();
    assert.equal(
      new Set(compareTimes).size,
      2,
      "Each source keeps its own check time",
    );
    // Scope changes hide the comparison; restoring the scope shows it again.
    await choose(periodSelect, "五分钟");
    assert.equal(
      await page.getByText("同范围来源对照", { exact: true }).count(),
      0,
    );
    await choose(periodSelect, "日线");
    await compareRegion.waitFor();
    await symbolInput.fill("sh600000");
    assert.equal(
      await page.getByText("同范围来源对照", { exact: true }).count(),
      0,
    );
    await symbolInput.fill("sz000001");
    await compareRegion.waitFor();
    await page.evaluate(() =>
      window.setSettings({ tdxRoot: "C:/fixture/compare-other" }),
    );
    await page.waitForFunction(
      () => !document.body.innerText.includes("同范围来源对照"),
    );
    await page.evaluate(() =>
      window.setSettings({ tdxRoot: "C:/fixture/remote" }),
    );
    await compareRegion.waitFor();
    assert.equal(await compareRows.count(), 2);
    // A late but legal response keeps its own request identity and is shown
    // stale by the current card, then becomes comparable again when restored.
    await choose(sourceSelect, "东方财富");
    await diagnostic.click();
    assert.equal(
      await diagnostics.getByRole("button").isDisabled(),
      true,
      "Only one product check may be pending",
    );
    await symbolInput.fill("sh600000");
    await page.evaluate(() =>
      window.setSettings({ tdxRoot: "C:/fixture/late-other" }),
    );
    await page.waitForFunction(
      () => !document.body.innerText.includes("同范围来源对照"),
    );
    await page.evaluate(() =>
      window.resolveCheck({ dataAsOf: "2026-09-23", checkedAt: 1763000002000 }),
    );
    await page
      .getByText("以下为旧配置或旧选择的检查结果，请重新检查。")
      .waitFor();
    await page.getByText("检查范围与时间").click();
    await diagnostics.getByText(/东方财富 · sz000001/).waitFor();
    assert.equal(
      await diagnostics
        .getByText("行情最后时点：2026-09-23", { exact: true })
        .count(),
      1,
      "The late response keeps the identity it was requested with",
    );
    await symbolInput.fill("sz000001");
    await page.evaluate(() =>
      window.setSettings({ tdxRoot: "C:/fixture/remote" }),
    );
    await compareRegion.waitFor();
    await page
      .getByText("以下为旧配置或旧选择的检查结果，请重新检查。")
      .waitFor({ state: "hidden" });
    assert.equal(await compareRows.count(), 3);
    assert.equal(
      await compareRegion.getByText("东方财富", { exact: true }).count(),
      1,
    );
    assert.equal(
      await compareRegion.getByText("2026-09-23", { exact: true }).count(),
      1,
    );
    // A response with a different identity never overwrites the current card
    // or any stored receipt, and the dedicated notice clears on next action.
    await diagnostic.click();
    await page.evaluate(() =>
      window.resolveCheck({ source: "tencent", dataAsOf: "2026-09-30" }),
    );
    await diagnostics
      .getByText(
        "检查结果与发起请求的来源、证券、周期或已保存配置不一致，已忽略本次结果。",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await diagnostics.getByText("连接：可访问", { exact: true }).count(),
      0,
      "Mismatched identity leaves no current result",
    );
    assert.equal(await compareRows.count(), 3, "Mismatch adds no receipt");
    assert.equal(
      await compareRegion.getByText("腾讯自选股", { exact: true }).count(),
      0,
    );
    assert.equal(
      await compareRegion.getByText("2026-09-30", { exact: true }).count(),
      0,
    );
    await choose(sourceSelect, "腾讯自选股");
    assert.equal(
      await diagnostics.getByText(/检查结果与发起请求/).count(),
      0,
      "Next action clears the mismatch notice",
    );
    await choose(sourceSelect, "东方财富");
    // Transport failure clears only the current card; stored rows remain.
    await page.evaluate(() => (window.failCheck = true));
    await diagnostic.click();
    await page.evaluate(() => window.resolveCheck());
    await page
      .getByRole("alert")
      .filter({ hasText: "合成诊断请求失败" })
      .waitFor();
    assert.equal(
      await diagnostics.getByText("连接：可访问", { exact: true }).count(),
      0,
    );
    assert.equal(
      await compareRows.count(),
      3,
      "Transport failure keeps completed comparison rows",
    );
    await page.evaluate(() => (window.failCheck = false));
    // Rechecking a source replaces its row instead of adding another.
    await diagnostic.click();
    await page.evaluate(() =>
      window.resolveCheck({
        dataAsOf: "2026-09-22",
        checkedAt: 1763000003000,
      }),
    );
    await page.getByText("连接：可访问", { exact: true }).waitFor();
    assert.equal(await compareRows.count(), 3);
    assert.equal(
      await compareRegion.getByText("2026-09-22", { exact: true }).count(),
      1,
    );
    assert.equal(
      await compareRegion.getByText("2026-09-23", { exact: true }).count(),
      0,
      "Recheck replaces the source's previous receipt",
    );
    // Selection, configuration and draft changes never start a check.
    const checkCallsBeforePassive = await page.evaluate(
      () => window.mutations.filter((m) => m.name === "checkConnection").length,
    );
    await choose(periodSelect, "五分钟");
    await choose(periodSelect, "日线");
    await symbolInput.fill("sh600000");
    await symbolInput.fill("sz000001");
    await page.evaluate(() =>
      window.setSettings({ tdxRoot: "C:/fixture/passive" }),
    );
    await page.evaluate(() =>
      window.setSettings({ tdxRoot: "C:/fixture/remote" }),
    );
    await compareRegion.waitFor();
    assert.equal(
      await page.evaluate(
        () =>
          window.mutations.filter((m) => m.name === "checkConnection").length,
      ),
      checkCallsBeforePassive,
      "Selection, configuration and table changes never start a check",
    );
    await page.mouse.wheel(0, -10000);
    await page.waitForFunction(() => window.scrollY === 0);
    await page.getByRole("radio", { name: "新闻采集", exact: true }).click();
    const python = page.getByLabel("新闻 Python 可执行文件", { exact: true });
    assert.equal(await python.inputValue(), "python");
    const newsCheck = page.getByRole("button", {
      name: "检查已保存新闻配置",
      exact: true,
    });
    await newsCheck.click();
    await page.evaluate(() => window.resolveNewsCheck());
    await page.getByText("数据库：待处理", { exact: true }).waitFor();
    await page.getByText("Python：可用", { exact: true }).waitFor();
    await python.fill("C:/custom python/python.exe");
    assert.equal(
      await newsCheck.isDisabled(),
      true,
      "Unsaved news paths cannot be diagnosed as saved configuration",
    );
    await save.click();
    await python.fill("C:/newer/python.exe");
    await page.evaluate(() => window.resolveSave());
    await page.waitForFunction(
      () => window.saved.newsPythonExecutable === "C:/custom python/python.exe",
    );
    assert.equal(
      await python.inputValue(),
      "C:/newer/python.exe",
      "A late save preserves newer Python edits",
    );
    await page.evaluate(() => window.setSettings(window.saved));
    await page.getByRole("button", { name: "撤销修改" }).click();
    await page
      .getByText("新闻配置已变化，以下结果已过期，请重新检查。", {
        exact: true,
      })
      .waitFor();
    await newsCheck.click();
    await page.evaluate(() =>
      window.setSettings({ newsPythonExecutable: "C:/remote/python.exe" }),
    );
    await page.evaluate(() => window.resolveNewsCheck());
    await page
      .getByText("新闻配置已变化，以下结果已过期，请重新检查。", {
        exact: true,
      })
      .waitFor();
    await page.evaluate(() => (window.failNewsCheck = true));
    await newsCheck.click();
    await page.evaluate(() => window.resolveNewsCheck());
    await page
      .getByRole("alert")
      .filter({ hasText: "合成新闻检查失败" })
      .waitFor();
    assert.equal(
      await page.getByText("Python：可用", { exact: true }).count(),
      0,
      "Failed checks clear old successful results",
    );
    await page.evaluate(() => (window.failNewsCheck = false));
    await newsCheck.click();
    await page.evaluate(() => window.resolveNewsCheck());
    await page.getByText("Python：可用", { exact: true }).waitFor();
    await page.screenshot({
      path: join(logDir, "news-wide.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 640, height: 800 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "Narrow layout does not overflow",
    );
    await page.screenshot({ path: join(logDir, "narrow.png"), fullPage: true });
    await page.getByRole("radio", { name: "本地行情", exact: true }).click();
    const blocksLink = page.getByRole("link", {
      name: "在 RPS → 行业中管理成分来源和目录",
      exact: true,
    });
    await blocksLink.waitFor();
    assert.equal(await blocksLink.getAttribute("href"), "/scan?tab=rps");
    await compareRegion.waitFor();
    assert.equal(await compareRows.count(), 3);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "Comparison table stays inside the 640px page",
    );
    await page.screenshot({
      path: join(logDir, "local-narrow.png"),
      fullPage: true,
    });
  }
  await page.reload();
  await root.waitFor();
  assert.equal(
    await root.inputValue(),
    "C:/fixture/tdx",
    "refresh discards memory-only drafts",
  );
  assert.equal(
    await page.evaluate(() => window.mutations.length),
    0,
    "refresh never submits the old draft",
  );
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
