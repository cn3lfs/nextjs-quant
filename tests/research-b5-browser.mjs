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
import {researchSpecSchema} from './src/lib/research/strategy-research';
import {growthIntradayTemplate,growthIntradayLabels} from './src/lib/research/factors/research-growth-intraday';
import {openingIds} from './src/lib/research/technical/research-opening';
import {marketAdmissionIds} from './src/lib/research/risk/research-market-admission';
import {intradayExecutionIds} from './src/lib/research/technical/research-intraday-execution';
function Fixture(){const [spec,setSpec]=useState(()=>researchSpecSchema.parse({strategy:'dual-breakout',start:'2021-01-01',end:'2021-12-31',validationStart:'2021-10-01',risk:{fraction:0.02,maxWeight:0.2},management:growthIntradayTemplate('OP01')}));
window.currentSpec=spec;window.rows=[...openingIds,...marketAdmissionIds,...intradayExecutionIds,'SW02-last30'].map(id=>({id,label:growthIntradayLabels[id]}));
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
  const rows = await page.evaluate(() => window.rows);
  for (const row of rows) {
    await page
      .getByRole("button", { name: "应用" + row.label, exact: true })
      .click();
    const saved = await save();
    assert.equal(saved.management.growthIntraday, row.id);
    assert.equal(saved.strategy, "dual-breakout");
    assert.equal(saved.management.openingPlans, undefined);
    assert.equal(saved.management.marketAdmissionInputs, undefined);
    assert.equal(saved.management.intradayExecutionInputs, undefined);
    await narrow(row.id);
  }
  await page
    .getByRole("button", {
      name: "应用旧仓与今日新仓分批风险管理",
      exact: true,
    })
    .click();
  const plan = {
    symbol: "sh600000",
    date: "2021-03-02",
    source: "browser fixed evidence",
    version: "fixture-1",
    effectiveAt: "2021-03-01T14:00:00+08:00",
    availableAt: "2021-03-01T15:00:00+08:00",
    capturedAt: "2021-03-02T15:00:00+08:00",
    position: "trend",
    life: 90,
    observation: 100,
    resistance: 130,
    special: false,
  };
  await page
    .getByRole("textbox", { name: "前日冻结开盘计划" })
    .fill(JSON.stringify([plan]));
  await page.getByRole("textbox", { name: "前日冻结开盘计划" }).press("Tab");
  assert.deepEqual((await save()).management.openingPlans, [plan]);
  await page
    .getByRole("button", { name: "应用历史非ST准入", exact: true })
    .click();
  const status = {
    symbol: plan.symbol,
    date: plan.date,
    source: plan.source,
    version: plan.version,
    effectiveAt: plan.effectiveAt,
    availableAt: plan.availableAt,
    capturedAt: plan.capturedAt,
    st: false,
  };
  await page
    .getByRole("textbox", { name: "历史入场状态" })
    .fill(JSON.stringify([status]));
  await page.getByRole("textbox", { name: "历史入场状态" }).press("Tab");
  const admitted = await save();
  assert.deepEqual(admitted.management.marketAdmissionInputs, [status]);
  assert.equal(admitted.management.openingPlans, undefined);
  await page
    .getByRole("button", { name: "应用历史人工触发时点回放", exact: true })
    .click();
  const execution = { ...status, st: undefined, manualCoverage: true };
  await page
    .getByRole("textbox", { name: "盘中执行历史证据" })
    .fill(JSON.stringify([execution]));
  await page.getByRole("textbox", { name: "盘中执行历史证据" }).press("Tab");
  assert.equal(
    (await save()).management.intradayExecutionInputs[0].manualCoverage,
    true,
  );
  await page.getByRole("combobox", { name: "研究策略" }).click();
  await page
    .getByRole("option", { name: "双均线趋势 · 既有规则", exact: true })
    .click();
  const switched = await save();
  assert.equal(switched.management.growthIntraday, undefined);
  assert.equal(switched.management.intradayExecutionInputs, undefined);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      templates: rows.length,
      methods: 29,
      jsonInputs: 3,
      clearedInputs: true,
      narrowWidth: 390,
      pageErrors: errors.length,
    }),
  );
} finally {
  await browser.close();
}
