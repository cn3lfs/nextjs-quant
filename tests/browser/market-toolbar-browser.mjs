/** Real navigation, chart canvas and popovers; only data transport is synthetic. */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium, expect } from "@playwright/test";

const output = process.env.MARKET_TOOLBAR_OUTPUT;
if (output) mkdirSync(output, { recursive: true });
const stub = `import {defaultChartView} from '~/lib/chart/chart-view';
const bars=Array.from({length:120},(_,i)=>({date:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),open:100+i/10,close:101+i/10,high:103+i/10,low:98+i/10,volume:1000,amount:100000}));
export const snapshot={id:'fixture',symbol:'sh600000',bars,period:'day',adjustment:'none',source:'fixture',sourceNote:'合成行情，仅测试布局',sourceErrors:['受控来源缺失'],hash:'fixture',createdAt:0,historyExhausted:true};
const view={...defaultChartView,mainIndicators:['ma'],subchart:['volume']};
const fixed={chartBars:snapshot,chartSharedDrawings:[],czsc:{status:'no-structure',families:[]},securityNames:{sh600000:'浦发银行'}};
const query=name=>({useQuery:()=>({data:name==='chartView'?(window.savedView??view):fixed[name],isLoading:false,isFetching:false,isPending:false,error:name==='rpsCurve'?new Error('受控断线'):null,refetch(){window.rpsRetries=(window.rpsRetries??0)+1}})});
export const api=new Proxy({useUtils:()=>({chartView:{setData(){}},chartSharedDrawings:{invalidate(){return Promise.resolve()}}}),saveChartView:{useMutation:options=>({mutate(input){window.savedView=input.view;options?.onSuccess?.(input.view)},error:null})},useQueries:()=>[]},{get:(target,name)=>name in target?target[name]:query(name)});`;
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {Sidebar} from './src/components/workbench/sidebar';import {navGroups} from './src/components/workbench/navigation';
import {ChartWorkspace} from './src/components/market/chart-workspace';import {snapshot} from '~/trpc/react';
import {PanelVisibility} from './src/components/workbench/keep-alive';
window.expectedPages=navGroups.flatMap(group=>group.items.filter(item=>!item.hidden).map(item=>({href:item.href,label:item.label})));
function App(){const[active,setActive]=useState('/market'),[period,setPeriod]=useState('day'),[visible,setVisible]=useState(true);window.setActive=setActive;window.setPeriod=setPeriod;window.setVisible=setVisible;
return <div className='app-shell'><Sidebar active={active} badges={{'/tasks':{count:2,bad:true}}}/><main className='main'><div className='page'><h1>行情图表</h1><PanelVisibility visible={visible}><div hidden={!visible}><ChartWorkspace snapshot={snapshot} period={period} adjustment='none'/></div></PanelVisibility></div></main></div>}
createRoot(document.getElementById('root')).render(<App/>);`,
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
      name: "controlled-transport",
      setup(b) {
        b.onLoad({ filter: /trpc[\\/]react\.tsx$/ }, () => ({
          contents: stub,
          loader: "tsx",
          resolveDir: process.cwd(),
        }));
        b.onResolve({ filter: /^next\/link$/ }, () => ({
          path: "link",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `import React from 'react';export default function Link({href,onClick,scroll,prefetch,...props}){return <a {...props} href={href} onClick={event=>{event.preventDefault();onClick?.(event);window.setActive(href)}}/>}`,
          loader: "tsx",
          resolveDir: process.cwd(),
        }));
        if (process.env.NAV_COLLAPSE_NEGATIVE === "1")
          b.onLoad({ filter: /workbench[\\/]sidebar\.tsx$/ }, (args) => {
            const source = readFileSync(args.path, "utf8");
            const changed = source.replace(
              /\[group.label, true\]/,
              "[group.label, false]",
            );
            assert.notEqual(changed, source);
            return {
              contents: changed,
              loader: "tsx",
              resolveDir: resolve("src/components/workbench"),
            };
          });
      },
    },
  ],
});
const css = await postcss([tailwind()]).process(
  readFileSync("src/styles/globals.css", "utf8"),
  { from: resolve("src/styles/globals.css") },
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta charset="utf-8"><div id="root"></div>',
    }),
  );
  await page.goto("http://127.0.0.1/market");
  await page.addStyleTag({ content: css.css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const chart = page.getByRole("application");
  await chart.waitFor();
  const expected = await page.evaluate(() => window.expectedPages);
  await page
    .getByRole("alert")
    .filter({ hasText: "数据源提示：受控来源缺失" })
    .waitFor();
  await page.getByRole("button", { name: "数据说明", exact: true }).click();
  assert.equal(
    await page
      .getByRole("dialog", { name: "数据说明", exact: true })
      .innerText(),
    "合成行情，仅测试布局",
  );
  await page.keyboard.press("Escape");
  const nav = page.getByRole("navigation", { name: "工作台导航", exact: true });
  for (const item of expected)
    assert.equal(
      await nav.locator(`a[href="${item.href}"]`).isVisible(),
      true,
      `${item.label} must be discoverable without opening a group`,
    );
  assert.equal(
    await page.getByRole("button", { name: "展开全部页面导航" }).isVisible(),
    false,
  );
  assert.ok((await chart.boundingBox()).height >= 900 * 0.55);
  const indicator = page.getByRole("button", { name: /^指标设置/ });
  assert.equal(await page.getByRole("group", { name: "主图指标" }).count(), 0);
  await indicator.focus();
  await page.keyboard.press("Enter");
  const settings = page.getByRole("dialog", { name: "指标设置", exact: true });
  await settings.waitFor();
  await settings.getByRole("button", { name: "MA 参数", exact: true }).click();
  const parameters = page.getByRole("dialog", { name: "MA 参数", exact: true });
  const firstPeriod = parameters.getByRole("spinbutton").first();
  await firstPeriod.fill("0");
  assert.notEqual(await parameters.getByRole("status").innerText(), "");
  await firstPeriod.fill("8");
  assert.equal(await parameters.getByRole("status").innerText(), "");
  await parameters.getByRole("button", { name: "完成", exact: true }).click();
  await parameters.waitFor({ state: "hidden" });
  await settings.getByRole("button", { name: "RPS", exact: true }).click();
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "hidden" });
  await expect(indicator).toBeFocused();
  await page.getByText("RPS读取失败：受控断线", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("RPS参考阈值").count(), 0);
  await page.getByRole("button", { name: "重试RPS", exact: true }).click();
  assert.equal(await page.evaluate(() => window.rpsRetries), 1);
  await page.getByRole("button", { name: "RPS 设置", exact: true }).click();
  await page.getByLabel("RPS参考阈值").fill("95");
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () =>
      window.savedView?.rps.threshold === 95 &&
      window.savedView.parameters.ma[0] === 8 &&
      window.savedView.subchart.includes("rps"),
  );
  const metrics = [];
  await page
    .getByTestId("chart-legend")
    .getByRole("button", { name: /^MA\(/ })
    .click();
  await settings.waitFor();
  await parameters.waitFor();
  assert.equal(
    await parameters.getByRole("spinbutton").first().inputValue(),
    "8",
  );
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "hidden" });
  const drawing = page.getByRole("button", { name: /^画线：/ });
  await drawing.click();
  const drawingSettings = page.getByRole("dialog", { name: "画线工具设置" });
  await drawingSettings
    .getByRole("button", { name: "水平线", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await drawingSettings.waitFor({ state: "hidden" });
  assert.equal(await drawing.innerText(), "画线：水平线");
  await expect(drawing).toBeFocused();
  await page.keyboard.press("Escape");
  assert.equal(await drawing.innerText(), "画线：浏览");
  for (const width of [1440, 1024, 640]) {
    if (width === 1024) {
      await page.getByRole("button", { name: "发现", exact: true }).click();
      assert.equal(await nav.locator('a[href="/market"]').isVisible(), false);
    }
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(100);
    for (const testId of ["chart-primary-controls", "chart-secondary-controls"])
      assert.equal(
        await page
          .getByTestId(testId)
          .evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        true,
        `${testId} must not hide controls in a horizontal strip at ${width}`,
      );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    for (const name of [/^指标设置/, /^画线：/, /^叠加对比/, "RPS 设置"]) {
      await page.getByRole("button", { name }).click();
      const popup = page.locator("[data-radix-popper-content-wrapper]").last();
      await popup.waitFor();
      const box = await popup.boundingBox();
      assert.ok(
        box.x >= 0 && box.x + box.width <= width + 1,
        `Popup must fit ${width}`,
      );
      await page.keyboard.press("Escape");
      await popup.waitFor({ state: "hidden" });
    }
    if (width <= 1024) {
      for (const item of expected)
        assert.equal(
          await nav.locator(`a[href="${item.href}"]`).isVisible(),
          true,
          `Compact navigation keeps ${item.label} visible`,
        );
      const trigger = page.getByRole("button", { name: "展开全部页面导航" });
      await trigger.click();
      const menu = page.getByRole("navigation", { name: "全部页面导航" });
      await menu.waitFor();
      for (const item of expected) {
        const link = menu.locator(`a[href="${item.href}"]`);
        assert.equal(await link.isVisible(), true);
        assert.equal(
          await link.locator("span").isVisible(),
          true,
          `Readable label ${item.label}`,
        );
      }
      if (output)
        await page.screenshot({
          path: join(output, `navigation-${width}.png`),
        });
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
      await expect(trigger).toBeFocused();
      await trigger.click();
      await page
        .getByRole("navigation", { name: "全部页面导航" })
        .locator('a[href="/tasks"]')
        .click();
      await menu.waitFor({ state: "hidden" });
      assert.equal(
        await page.evaluate(() =>
          document
            .querySelector('.sidebar a[aria-current="page"]')
            .getAttribute("href"),
        ),
        "/tasks",
      );
    }
    metrics.push({ width, chart: await chart.boundingBox() });
    if (output)
      await page.screenshot({
        path: join(output, `market-toolbar-${width}.png`),
        fullPage: true,
      });
  }
  for (const name of [
    /^指标设置/,
    /^画线：/,
    /^叠加对比/,
    "RPS 设置",
    "数据说明",
  ]) {
    await page.getByRole("button", { name }).click();
    await page.getByRole("dialog").first().waitFor();
    await page.evaluate(() => window.setVisible(false));
    await page.getByRole("dialog").first().waitFor({ state: "hidden" });
    await page.evaluate(() => window.setVisible(true));
    await chart.waitFor();
    assert.equal(
      await page.getByRole("dialog").count(),
      0,
      "Returning to a cached chart must not reopen its portal",
    );
  }
  await page.evaluate(() => window.setPeriod("week"));
  await page
    .getByText("RPS仅支持日线，当前周期不可用", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "RPS 设置", exact: true }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  if (output)
    writeFileSync(
      join(output, "result.json"),
      JSON.stringify({ passed: true, metrics, errors }, null, 2),
    );
  console.log(
    "PASS navigation labels/focus, responsive popovers, saved RPS options, visible failures, no horizontal overflow",
  );
} finally {
  await browser.close();
}
