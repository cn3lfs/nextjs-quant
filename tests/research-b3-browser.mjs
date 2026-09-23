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
import {ResearchStrategyFields,selectResearchStrategy} from './src/components/research-strategy-fields';
import {researchStrategyIds,researchStrategies} from './src/lib/research/specs/research-strategies';
import {researchSpecSchema} from './src/lib/research/strategy-research';
import {swingCoreIds} from './src/lib/research/methods/swing/research-swing-core';
import {indicatorCombinationIds} from './src/lib/research/technical/research-indicator-combinations';
import {volumeAdaptedIds} from './src/lib/research/methods/volume/research-volume-adapted';
import {volumePollutionIds} from './src/lib/research/methods/volume/research-volume-pollution';
import {swingDisciplineIds,swingDisciplineLabels,swingDisciplineTemplate} from './src/lib/research/methods/swing/research-swing-discipline';
import {applyResearchManagement} from './src/components/research-strategy-fields';
function Fixture(){const [spec,setSpec]=useState(()=>researchSpecSchema.parse({strategy:'dual-breakout',start:'2024-01-01',end:'2024-12-31',validationStart:'2024-10-01'}));
window.b3Ids=[...swingCoreIds,...indicatorCombinationIds,...volumeAdaptedIds,...volumePollutionIds,'sw-system-combined'];window.disciplines=swingDisciplineIds.map(id=>({id,label:swingDisciplineLabels[id]}));window.showManagement=()=>setSpec(previous=>applyResearchManagement(previous,swingDisciplineTemplate('sw-stop2')));
window.registry=researchStrategyIds.map(id=>({id,label:researchStrategies[id].label}));window.currentSpec=spec;window.selectPreset=id=>setSpec(previous=>selectResearchStrategy(previous,id));
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
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) => route.abort());
  await page.setContent(
    `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css.css}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script>`,
  );
  await page.getByRole("combobox", { name: "研究策略" }).waitFor();
  const registry = await page.evaluate(() => window.registry);
  await page.getByRole("combobox", { name: "研究策略" }).click();
  assert.deepEqual(
    await page.getByRole("option").allTextContents(),
    registry.map((row) => row.label),
  );
  await page
    .getByRole("option", { name: "波段 · 四指标强中分级仓位", exact: true })
    .click();
  const ids = await page.evaluate(() => window.b3Ids);
  const scoped = registry.filter((row) => ids.includes(row.id));
  let savedCount = 0;
  for (const row of scoped) {
    await page.evaluate((id) => window.selectPreset(id), row.id);
    await page.waitForFunction(
      (id) => window.currentSpec.strategy === id,
      row.id,
    );
    await page.getByRole("button", { name: "保存固定配置" }).click();
    const saved = await page.evaluate(() => window.saved);
    assert.equal(saved.strategy, row.id);
    assert.equal(saved.maParams, undefined);
    savedCount++;
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `390px overflow: ${row.id}`,
    );
  }
  await page.evaluate(() => window.showManagement());
  const disciplines = await page.evaluate(() => window.disciplines);
  for (const row of disciplines) {
    await page
      .getByRole("button", { name: `应用${row.label}`, exact: true })
      .click();
    await page.getByRole("button", { name: "保存固定配置" }).click();
    const saved = await page.evaluate(() => window.saved);
    assert.equal(saved.management.swingDiscipline, row.id);
    assert.equal(saved.strategy, "dual-breakout");
    assert.equal(saved.risk.fraction, 0.03);
    assert.equal(saved.risk.maxWeight, 0.2);
    assert.equal(saved.maxPositions, 3);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
  }
  await page.evaluate(() => window.selectPreset("sw-macd-combined"));
  await page.waitForFunction(
    () => window.currentSpec.strategy === "sw-macd-combined",
  );
  await page.getByRole("button", { name: "保存固定配置" }).click();
  assert.equal(
    await page.evaluate(() => window.saved.management?.swingDiscipline),
    undefined,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      registryOptions: registry.length,
      savedPresets: savedCount,
      managementTemplates: disciplines.length,
      clearedSwingTemplate: true,
      clearedMa: true,
      narrowWidth: 390,
      overflowChecks: scoped.length + disciplines.length,
      pageErrors: errors.length,
    }),
  );
} finally {
  await browser.close();
}
