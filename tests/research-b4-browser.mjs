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
import {ResearchStrategyFields} from './src/components/research-strategy-fields';
import {researchStrategyIds,researchStrategies} from './src/lib/research-strategies';
import {researchSpecSchema} from './src/lib/strategy-research';
function Fixture(){const [spec,setSpec]=useState(()=>researchSpecSchema.parse({strategy:'wy-dual-rs',start:'2021-01-01',end:'2021-12-31',validationStart:'2021-10-01'}));
window.currentSpec=spec;window.rows=researchStrategyIds.filter(id=>id.startsWith('wy-')||id.startsWith('chan-')).map(id=>({id,label:researchStrategies[id].label}));
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
  const select = async (id) => {
    const row = rows.find((r) => r.id === id);
    assert.ok(row, id);
    await page.getByRole("combobox", { name: "研究策略" }).click();
    await page.getByRole("option", { name: row.label, exact: true }).click();
  };
  for (const row of rows) {
    await select(row.id);
    assert.equal((await save()).strategy, row.id);
    await narrow(row.id);
  }
  const at = "2021-03-02T15:00:00+08:00";
  const bar = {
    date: "2021-03-02",
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 100,
    amount: 1000,
  };
  const stock = {
    id: "fixed",
    symbol: "sh600000",
    period: "day",
    source: "fixed",
    adjustment: "none",
    createdAt: 1,
    hash: "fixed",
    bars: [bar],
  };
  const raw = {
    symbol: "sh600000",
    date: bar.date,
    source: "fixed",
    availableAt: at,
    weeklyAvailableAt: at,
    stock,
    calendar: {
      days: [bar.date],
      closedDays: [],
      source: "fixed",
      hash: "fixed",
      availableAt: at,
    },
    benchmarks: [
      {
        snapshot: { ...stock, symbol: "sh000300" },
        identity: {
          role: "market",
          stock: "sh600000",
          benchmark: "sh000300",
          name: "fixture",
          source: "fixed",
          effectiveFrom: "2021-01-01",
          effectiveTo: "2021-12-31",
          availableAt: at,
          capturedAt: at,
        },
        availableAt: at,
      },
    ],
    assessment: {
      phase: "accumulation",
      quality: "multi",
      tr: 80,
      vsa: 80,
      mtf: 80,
      rs: 80,
      market: 80,
      source: "fixed",
      availableAt: at,
    },
  };
  const fill = async (name, value) => {
    await page
      .getByRole("textbox", { name, exact: true })
      .fill(JSON.stringify(value));
    await page.getByRole("textbox", { name, exact: true }).press("Tab");
  };
  for (const id of [
    "wy-week-day-hour",
    "wy-dual-rs",
    "wy-score-half-kelly",
    "chan-consolidation-weekly-native",
  ]) {
    await select(id);
    await fill("威科夫结构原始证据", [raw]);
    assert.deepEqual((await save()).wyckoffStructureInputs, [raw]);
    await narrow(id);
  }
  await select("wy-daily-hourly");
  const hours = [1, 2, 3, 4, 5, 8].flatMap((d) =>
    ["10:30", "11:30", "14:00", "15:00"].map((t) => ({
      ...bar,
      date: `2021-03-${String(d).padStart(2, "0")}T${t}:00+08:00`,
    })),
  );
  const hourly = {
    symbol: "sh600000",
    date: "2021-03-08",
    source: "fixed",
    availableAt: "2021-03-08T15:00:00+08:00",
    adjustment: "none",
    hours,
  };
  await fill("威科夫小时历史证据", [hourly]);
  assert.deepEqual((await save()).wyckoffHourlyInputs, [hourly]);
  await fill("威科夫小时历史证据", []);
  assert.deepEqual((await save()).wyckoffHourlyInputs, []);
  await page.getByRole("textbox", { name: "威科夫小时历史证据" }).fill("");
  await page.getByRole("textbox", { name: "威科夫小时历史证据" }).press("Tab");
  assert.equal((await save()).wyckoffHourlyInputs, undefined);
  await select("wy-no-supply");
  const vsa = {
    symbol: "sh600000",
    date: bar.date,
    source: "fixed",
    availableAt: at,
    limit: false,
    corporateAction: false,
    openingCrash: false,
    specialDate: false,
    marketCapYuan: 1e10,
  };
  await fill("VSA历史证据", [vsa]);
  assert.deepEqual((await save()).wyckoffInputs, [vsa]);
  await page.getByRole("combobox", { name: "研究策略" }).click();
  await page
    .getByRole("option", { name: "双均线趋势 · 既有规则", exact: true })
    .click();
  const switched = await save();
  for (const key of [
    "wyckoffInputs",
    "wyckoffHourlyInputs",
    "wyckoffStructureInputs",
  ])
    assert.equal(switched[key], undefined);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      presets: rows.length,
      jsonInputs: 3,
      structurePaths: 4,
      emptyVsOmitted: true,
      clearedInputs: true,
      narrowWidth: 390,
      pageErrors: errors.length,
    }),
  );
} finally {
  await browser.close();
}
