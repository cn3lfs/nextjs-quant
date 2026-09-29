import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const logs = join(tmpdir(), "logs/quant-signals");
const measurements = [];
for (const name of ["monitors", "signals", "deliveries"]) {
  const times = [];
  let bytes = 0;
  for (let i = 0; i < 35; i++) {
    const start = performance.now();
    const r = await fetch(`http://127.0.0.1:3225/api/trpc/${name}`, {
      headers: {
        "x-quant-client": "workbench",
        origin: "http://127.0.0.1:3225",
        connection: "close",
      },
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    bytes = Buffer.byteLength(text);
    if (i >= 5) times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  measurements.push({ name, p50: times[15], p95: times[28], bytes });
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:3225/signals");
  await page.getByText("合成订阅 999", { exact: true }).waitFor();
  const text = await page.locator("main").innerText();
  assert.ok(text.includes("合成订阅 999"));
  assert.ok(
    !text.includes("合成订阅 0\n"),
    "older subscriptions are inaccessible in baseline",
  );
  await page.screenshot({
    path: join(logs, "before-1440.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(logs, "before-390.png"),
    fullPage: false,
  });
  writeFileSync(
    join(logs, "baseline-browser.json"),
    JSON.stringify(
      {
        browser: browser.version(),
        measurements,
        errors,
        oldestSubscriptionAbsent: true,
        mainText: text.slice(0, 3000),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ measurements, errors }));
} finally {
  await browser.close();
}
