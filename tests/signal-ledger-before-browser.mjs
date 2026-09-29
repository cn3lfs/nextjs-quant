import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
assert.ok(
  resolve(process.env.QUANT_DATA_DIR ?? "").startsWith(
    resolve(tmpdir()) + "\\quant-signal-ledger-",
  ),
);
const base = process.env.BASE ?? "http://127.0.0.1:3222";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let refreshes = 0;
  page.on("request", (r) => {
    if (r.url().includes("/signal-ledger") && r.url().includes("_rsc"))
      refreshes++;
  });
  const start = performance.now();
  await page.goto(base + "/signal-ledger");
  await page.getByRole("region", { name: "台账明细", exact: true }).waitFor();
  const initialMs = performance.now() - start;
  const details = await page
    .getByRole("region", { name: "台账明细", exact: true })
    .locator("details")
    .count();
  assert.equal(details, 100);
  const at = refreshes;
  await page.waitForTimeout(10000);
  const idleRefreshes = refreshes - at;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const beforeHidden = refreshes;
  await page.waitForTimeout(10000);
  const hiddenRefreshes = refreshes - beforeHidden;
  const dir = join(tmpdir(), "logs", "quant-signal-ledger");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({
      path: join(dir, `before-${width}.png`),
      fullPage: true,
    });
  }
  writeFileSync(
    join(dir, "browser-before.json"),
    JSON.stringify(
      {
        initialMs,
        details,
        fixture: 121,
        idleRefreshes,
        hiddenRefreshes,
        intervalMs: 10000,
        errors,
        browser: browser.version(),
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
