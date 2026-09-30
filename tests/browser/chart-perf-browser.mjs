/** Reproducible interaction benchmark for the real MarketChart component.
 * Synthetic bars only (no data IO). Usage: node tests/chart-perf-browser.mjs
 * Prints, per bar count, the median main-thread task time (CDP TaskDuration)
 * per interaction and how many chart instances were (re)created.
 * PROFILE=1 also prints the top self-time functions of the hover runs;
 * SHOT=1 writes a screenshot per bar count to the OS temp directory.
 */
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
);
const { chromium } = require("playwright");
const result = await build({
  stdin: {
    contents: `
import React, { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MarketChart } from './src/components/market/chart';
import { defaultChartView } from './src/lib/chart/chart-view';
const n = Number(new URLSearchParams(location.search).get('n') || 2000);
const bars = Array.from({length: n}, (_, i) => {
  const base = 30 + Math.sin(i / 37) * 6 + i / 400;
  return { date: new Date(Date.UTC(1990, 0, 1) + i * 86400000).toISOString().slice(0, 10),
    open: base, close: base + Math.sin(i) * 0.4, high: base + 0.8, low: base - 0.8, volume: 1000 + (i % 50) * 30, amount: 3000 };
});
function App() {
  const [view, setView] = useState({ ...defaultChartView, subchart: ['volume'] });
  const [tool, setTool] = useState('none');
  const [start, setStart] = useState(null);
  window.__bench = { setView: (f) => flushSync(() => setView(f)), setTool: (t) => flushSync(() => setTool(t)), setStart: (s) => flushSync(() => setStart(s)) };
  return <div style={{height: 800}}><MarketChart bars={bars} period="day" view={view} onViewChange={setView} drawingTool={tool} drawingPoints={start ? [start] : []} onAnchor={() => {}} /></div>;
}
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
});
if (process.env.PROFILE)
  writeFileSync(
    join(tmpdir(), "chart-perf-bundle.js"),
    result.outputFiles[0].text,
  );
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/bundle.js" ? "text/javascript" : "text/html; charset=utf-8",
  );
  res.end(
    req.url === "/bundle.js"
      ? result.outputFiles[0].text
      : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>',
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const n of [2000, 20000]) {
    const page = await browser.newPage({
      viewport: { width: 1500, height: 950 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Count chart instances: every createChart inserts one div.tv-lightweight-charts.
    await page.addInitScript(() => {
      window.__charts = 0;
      new MutationObserver((records) => {
        for (const r of records)
          for (const node of r.addedNodes)
            if (
              node instanceof HTMLElement &&
              (node.matches?.("div.tv-lightweight-charts") ||
                node.querySelector?.("div.tv-lightweight-charts"))
            )
              window.__charts++;
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`http://127.0.0.1:${port}/?n=${n}`);
    await page
      .waitForFunction(() => window.__bench && window.__charts > 0, null, {
        timeout: 15000,
      })
      .catch(() => {
        throw new Error(`chart did not mount: ${errors.join("; ")}`);
      });
    await page.waitForTimeout(300);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const busy = async () =>
      (await cdp.send("Performance.getMetrics")).metrics.find(
        (m) => m.name === "TaskDuration",
      ).value * 1000;
    // Main-thread task time per action (CDP TaskDuration), which, unlike
    // wall-clock to the next frame, is not quantized by the 16.7ms frame.
    // Three warm-up runs, then the median of 15 individually measured runs.
    const measure = async (label, action) => {
      const once = () =>
        page.evaluate(async (action) => {
          const before = window.__charts;
          new Function("b", action)(window.__bench);
          await new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          );
          return window.__charts - before;
        }, action);
      for (let i = 0; i < 3; i++) await once();
      const times = [];
      let rebuilds = 0;
      for (let i = 0; i < 15; i++) {
        const t0 = await busy();
        rebuilds += await once();
        times.push((await busy()) - t0);
      }
      times.sort((a, b) => a - b);
      return { label, taskMs: +times[7].toFixed(1), rebuilds };
    };
    const rows = [];
    rows.push(
      await measure(
        "画线工具切换",
        "const s = (window.__i = (window.__i || 0) + 1); b.setTool(s % 2 ? 'trend' : 'none');",
      ),
      await measure(
        "画线起点落下",
        "const s = (window.__j = (window.__j || 0) + 1); b.setStart(s % 2 ? { date: '1990-02-01', price: 30 } : null);",
      ),
      await measure(
        "切换主图指标",
        "const s = (window.__k = (window.__k || 0) + 1); b.setView((v) => ({ ...v, mainIndicators: s % 2 ? ['ma'] : ['ma', 'boll'] }));",
      ),
      await measure(
        "增删副图",
        "const s = (window.__m = (window.__m || 0) + 1); b.setView((v) => ({ ...v, subchart: s % 2 ? ['volume', 'macd'] : ['volume'] }));",
      ),
      await measure(
        "切换深色",
        "const s = (window.__d = (window.__d || 0) + 1); b.setView((v) => ({ ...v, dark: s % 2 === 1 }));",
      ),
    );
    // Crosshair moves across the main pane, plain and with a drawing tool armed
    // (the tool adds anchor resolution and a preview on every move).
    const hoverRun = async (label, tool) => {
      await page.evaluate((tool) => window.__bench.setTool(tool), tool);
      const h0 = await busy();
      const r = await page.evaluate(async () => {
        const el = document.querySelector("div.tv-lightweight-charts canvas");
        const box = el.getBoundingClientRect();
        const frames = () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          );
        const before = window.__charts;
        for (let i = 0; i < 30; i++) {
          el.dispatchEvent(
            new MouseEvent("mousemove", {
              bubbles: true,
              clientX: box.left + 50 + i * 20,
              clientY: box.top + 200,
            }),
          );
          await frames();
        }
        return window.__charts - before;
      });
      return {
        label,
        taskMs: +(((await busy()) - h0) / 30).toFixed(1),
        rebuilds: r,
      };
    };
    if (process.env.PROFILE)
      await cdp.send("Profiler.enable").then(() => cdp.send("Profiler.start"));
    rows.push(
      await hoverRun("十字光标每步", "none"),
      await hoverRun("画线中十字光标每步", "trend"),
    );
    if (process.env.PROFILE) {
      // Top self-time functions during the two hover runs.
      const { profile } = await cdp.send("Profiler.stop");
      const self = new Map();
      const byId = new Map(profile.nodes.map((node) => [node.id, node]));
      profile.samples.forEach((id, i) => {
        const f = byId.get(id).callFrame;
        const key = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber}`;
        self.set(
          key,
          (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000,
        );
      });
      console.log(
        JSON.stringify([...self].sort((a, b) => b[1] - a[1]).slice(0, 12)),
      );
    }
    if (process.env.SHOT) {
      // Visual check after all toggles: three panes, MA+BOLL, a drawing preview.
      await page.evaluate(() => {
        window.__bench.setView((v) => ({
          ...v,
          dark: false,
          mainIndicators: ["ma", "boll"],
          subchart: ["volume", "macd", "rsi"],
        }));
        window.__bench.setTool("trend");
      });
      const box = await page.locator("div.tv-lightweight-charts").boundingBox();
      await page.mouse.move(box.x + 500, box.y + 150);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(tmpdir(), `chart-perf-${n}.png`) });
    }
    console.log(JSON.stringify({ bars: n, rows, errors }));
    await page.close();
  }
} finally {
  await browser?.close();
  server.close();
}
