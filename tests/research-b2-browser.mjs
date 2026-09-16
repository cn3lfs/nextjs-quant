import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ResearchStrategyFields,applyResearchManagement} from './src/components/research-strategy-fields';
import {researchSpecSchema} from './src/lib/strategy-research';
import {riskRouteNames} from './src/lib/research-risk-routing';
import {riskProfiles,riskPresetIds,riskPresetTemplate} from './src/lib/research-risk-presets';
import {volatilityStopIds,volatilityStopProfiles} from './src/lib/research-volatility-stops';
import {contextRiskIds,contextRiskProfiles} from './src/lib/research-context-risk';
import {growthIntradayLabels,growthIntradayIds} from './src/lib/research-growth-intraday';
function Fixture(){const base=()=>researchSpecSchema.parse({strategy:'dual-breakout',start:'2021-01-01',end:'2021-12-31',validationStart:'2021-10-01'});const [spec,setSpec]=useState(base);
window.reset=()=>{window.saved=null;setSpec(base())};window.showManagement=()=>setSpec(applyResearchManagement(base(),riskPresetTemplate('rk-risk1')));
window.currentSpec=spec;window.routes=Object.entries(riskRouteNames).flatMap(([id,label])=>['primary','alternative'].filter(branch=>branch==='primary'||!['unmonitored','records100'].includes(id)).map(branch=>({id,branch,label:'路由'+label+'·'+(branch==='primary'?'首选':'备选')})));
window.managementRows=[...riskPresetIds.map(id=>({id,label:riskProfiles[id].label,key:'riskPreset'})),...contextRiskIds.filter(id=>id.startsWith('rk-')).map(id=>({id,label:contextRiskProfiles[id][1],key:'contextRisk'})),...growthIntradayIds.filter(id=>id.startsWith('RK-')).map(id=>({id,label:growthIntradayLabels[id],key:'growthIntraday'}))];
return <main className="mx-auto max-w-2xl space-y-4 p-6"><ResearchStrategyFields spec={spec} onChange={setSpec}/><button onClick={()=>window.saved=researchSpecSchema.parse(spec)}>保存固定配置</button></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
const css = await postcss([tailwind()]).process(
  await readFile("src/styles/globals.css", "utf8"),
  { from: resolve("src/styles/globals.css") },
);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (r) => r.abort());
  await page.setContent(
    `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css.css}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script>`,
  );
  await page.getByRole("combobox", { name: "研究策略" }).waitFor();
  const save = async () => {
    await page
      .getByRole("button", { name: "保存固定配置", exact: true })
      .click();
    return page.evaluate(() => window.saved);
  };
  const narrow = async (name) =>
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `390px overflow ${name}`,
    );
  const routes = await page.evaluate(() => window.routes);
  for (const row of routes) {
    await page.evaluate(() => window.reset());
    await page.getByRole("button", { name: row.label, exact: true }).click();
    const saved = await save();
    assert.equal(saved.riskRoute.scenario, row.id);
    assert.equal(saved.riskRoute.branch, row.branch);
    await narrow(row.label);
  }
  for (const variant of [
    "timing-v1",
    "atr-resize-v1",
    "naive-3-to-8-control",
  ]) {
    await page.evaluate(() => window.reset());
    await page
      .getByRole("button", {
        name:
          "诊断" +
          {
            "timing-v1": "入场时机修正",
            "atr-resize-v1": "ATR校准并缩放仓位",
            "naive-3-to-8-control": "3%放宽8%不缩股反例",
          }[variant],
        exact: true,
      })
      .click();
    const saved = await save();
    assert.equal(saved.stopDiagnosis.variant, variant);
    assert.equal(saved.stopDiagnosis.records.length, 0);
    assert.equal(saved.riskRoute, undefined);
    await narrow(variant);
  }
  for (const kind of [
    "cycle-switch",
    "add-raise",
    "add-reduce",
    "held-reduce",
  ]) {
    await page.evaluate(() => window.reset());
    await page
      .getByRole("button", {
        name:
          "修复" +
          {
            "cycle-switch": "预定换周期",
            "add-raise": "加仓后抬线",
            "add-reduce": "加仓后减仓",
            "held-reduce": "既有持仓减仓",
          }[kind],
        exact: true,
      })
      .click();
    const input = page.getByRole("textbox", { name: "预登记持仓情景" });
    const value = JSON.parse(await input.inputValue());
    value.budget = 900;
    await input.fill(JSON.stringify(value));
    await input.blur();
    const saved = await save();
    assert.equal(saved.riskRepair.kind, kind);
    assert.equal(saved.riskRepair.budget, 900);
    await narrow(kind);
  }
  const rows = await page.evaluate(() => window.managementRows);
  for (const row of rows) {
    await page.evaluate(() => window.showManagement());
    await page
      .getByRole("button", { name: "应用" + row.label, exact: true })
      .click();
    const saved = await save();
    assert.equal(saved.management[row.key], row.id);
    await narrow(row.id);
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      batch: "B2",
      routes: routes.length,
      diagnosis: 3,
      repairs: 4,
      management: rows.length,
      pageErrors: errors.length,
      narrowWidth: 390,
      networkRequestsAllowed: 0,
    }),
  );
} finally {
  await browser.close();
}
