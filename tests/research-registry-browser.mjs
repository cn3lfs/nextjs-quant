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
import {researchStrategyIds,researchStrategies} from './src/lib/research-strategies';
import {researchSpecSchema} from './src/lib/strategy-research';
function Fixture(){const [spec,setSpec]=useState(()=>researchSpecSchema.parse({strategy:'dual-breakout',start:'2024-01-01',end:'2024-12-31',validationStart:'2024-10-01'}));
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
    .getByRole("option", { name: "双均线趋势 · 既有规则", exact: true })
    .click();
  await page.getByRole("spinbutton", { name: "短均线天数" }).fill("7");
  await page.getByRole("combobox", { name: "研究策略" }).click();
  await page
    .getByRole("option", { name: "旗形 · 15根通道突破", exact: true })
    .click();
  await page.getByRole("button", { name: "保存固定配置" }).click();
  const saved = await page.evaluate(() => window.saved);
  assert.equal(saved.strategy, "flag-15");
  assert.equal(saved.maParams, undefined);
  for (const row of registry) {
    await page.evaluate((id) => window.selectPreset(id), row.id);
    await page.waitForFunction(
      (id) => window.currentSpec.strategy === id,
      row.id,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `390px overflow: ${row.id}`,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      registryOptions: registry.length,
      savedPreset: saved.strategy,
      clearedMa: true,
      narrowWidth: 390,
      overflowChecks: registry.length,
      pageErrors: errors.length,
    }),
  );
} finally {
  await browser.close();
}
