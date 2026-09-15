import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ChartWorkspace} from './src/components/chart-workspace'; import {snapshot} from '~/trpc/react'; createRoot(document.getElementById('root')).render(<ChartWorkspace snapshot={snapshot} period="day" adjustment="none"/>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "isolated-chart-data",
      setup(b) {
        b.onLoad({ filter: /trpc[\\/]react\.tsx$/ }, () => ({
          loader: "ts",
          contents: `
      import {defaultChartView} from '../lib/chart-view';
      const bars = Array.from({length: 80}, (_,i) => ({date: new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10), open: 100+i/10, close:101+i/10, high:103+i/10, low:98+i/10, volume:100, amount:10000}));
      export const snapshot = {id:'fixture', symbol:'sh600000', bars, period:'day', adjustment:'none', source:'fixture', hash:'fixture', createdAt:0, historyExhausted:true};
      const view = {...defaultChartView, mainIndicators:[], subchart:['volume']};
      const query = data => ({useQuery: () => ({data, refetch:()=>{}})});
      export const api = {chartView:query(view),chartBars:query(snapshot),rpsCurve:query(undefined),chartPosition:query(undefined),czsc:query(undefined),breakout:query(undefined),useUtils:()=>({chartView:{setData:()=>{}}}),saveChartView:{useMutation:()=>({mutate: input=>{window.savedView=input.view;}})}};
    `,
        }));
      },
    },
  ],
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://127.0.0.1/chart-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://127.0.0.1/chart-fixture");
  await page.evaluate(() => {
    window.drawStrokes = [];
    const stroke = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function (...args) {
      if (this.strokeStyle === "#2563eb")
        window.drawStrokes.push(this.getLineDash());
      return stroke.apply(this, args);
    };
    const rect = CanvasRenderingContext2D.prototype.strokeRect;
    CanvasRenderingContext2D.prototype.strokeRect = function (...args) {
      if (this.strokeStyle === "#2563eb")
        window.drawStrokes.push(this.getLineDash());
      return rect.apply(this, args);
    };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const plot = page.getByRole("application");
  await plot.waitFor();
  const box = await plot.boundingBox();
  const move = async (x, y) => {
    await page.evaluate(() => {
      window.drawStrokes = [];
    });
    await page.mouse.move(box.x + x, box.y + y);
    await page.waitForTimeout(100);
  };
  const choose = async (name) => {
    const summary = page.locator("summary").filter({ hasText: "画线：" });
    if (!(await summary.evaluate((e) => e.parentElement.open)))
      await summary.click();
    await page.getByRole("button", { name, exact: true }).click();
  };
  for (const [name, count] of [
    ["水平线", 1],
    ["趋势线", 2],
    ["矩形", 3],
    ["斐波那契", 4],
  ]) {
    await choose(name);
    await move(350, 120);
    if (name !== "水平线") {
      await page.mouse.click(box.x + 350, box.y + 120);
      await move(650, 210);
    }
    assert(
      (await page.evaluate(() => window.drawStrokes)).some(
        (d) => d.join(",") === "6,4",
      ),
      name + " dashed preview",
    );
    assert(
      await page
        .locator("summary")
        .filter({ hasText: `已画图形（${count - 1}）` })
        .count(),
      "preview must not persist",
    );
    await page.mouse.click(
      box.x + (name === "水平线" ? 350 : 650),
      box.y + (name === "水平线" ? 120 : 210),
    );
    await page.waitForTimeout(120);
    assert(
      await page
        .locator("summary")
        .filter({ hasText: `已画图形（${count}）` })
        .count(),
      name + " completion",
    );
    await move(680, 230);
    assert(
      !(await page.evaluate(() => window.drawStrokes)).some((d) => d.length),
      name + " solid after completion",
    );
  }
  await choose("趋势线");
  await move(300, 120);
  await page.mouse.click(box.x + 300, box.y + 120);
  await move(600, 200);
  await page.keyboard.press("Escape");
  await move(620, 210);
  assert(
    !(await page.evaluate(() => window.drawStrokes)).some((d) => d.length),
    "Escape clears draft",
  );
  assert(
    await page.locator("summary").filter({ hasText: "已画图形（4）" }).count(),
  );
  await choose("水平线");
  await move(300, 150);
  await move(300, 420);
  assert(
    !(await page.evaluate(() => window.drawStrokes)).some((d) => d.length),
    "subpane clears preview",
  );
  await page.mouse.click(box.x + 300, box.y + 420);
  await page.waitForTimeout(100);
  assert(
    await page.locator("summary").filter({ hasText: "已画图形（4）" }).count(),
    "subpane click ignored",
  );
  await choose("浏览");
  await page.getByRole("button", { name: "保存视图", exact: true }).click();
  const before = await page.evaluate(() => window.savedView.drawings);
  assert.equal(before.length, 4);
  assert(
    before.some((d) => d.a.offset !== 0),
    "free offset survives save",
  );
  const form = page.locator("form").filter({
    has: page.getByRole("spinbutton", { name: "趋势线 a 价格", exact: true }),
  });
  await form
    .getByRole("spinbutton", { name: "趋势线 a 价格", exact: true })
    .fill("105.1234");
  await form.getByRole("button", { name: "更新图形", exact: true }).click();
  await page.getByRole("button", { name: "保存视图", exact: true }).click();
  const edited = await page.evaluate(() => window.savedView.drawings[1]);
  assert.equal(edited.a.price, 105.1234);
  assert.equal(
    edited.a.offset,
    before[1].a.offset,
    "price edit keeps free offset",
  );
  await form.getByLabel("趋势线 a 日期", { exact: true }).fill("2026-01-20");
  await form.getByRole("button", { name: "更新图形", exact: true }).click();
  await page.getByRole("button", { name: "保存视图", exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.savedView.drawings[1].a.offset),
    undefined,
    "explicit date edit resets offset",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser passed: four tools preview/complete, no draft persistence, Escape, subpane exclusion, no page errors.",
  );
} finally {
  await browser.close();
}
