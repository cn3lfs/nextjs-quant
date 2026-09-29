import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = process.env.BASE ?? "http://127.0.0.1:3231";
const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const fixture = JSON.parse(readFileSync(join(logs, "q3-fixture.json"), "utf8"));
const nativeVisibility = process.env.CASH_NATIVE_VISIBILITY === "1";
const browser = await chromium.launch({
  channel: "chrome",
  headless: !nativeVisibility,
  // Playwright normally disables native backgrounding for deterministic tests.
  // Native lifecycle verification must let Chrome apply its real window state.
  ignoreDefaultArgs: nativeVisibility
    ? [
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
      ]
    : undefined,
});
const requests = [],
  checks = [];
const reads = (start) =>
  requests.slice(start).filter((name) => name.startsWith("cashWorkspace"));
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("request", (request) => {
    if (request.url().includes("/api/trpc/"))
      requests.push(
        ...new URL(request.url()).pathname.split("/api/trpc/")[1].split(","),
      );
  });
  await page.goto(`${base}/trade-review`, { waitUntil: "networkidle" });
  await page.bringToFront();
  await page.getByLabel("复盘账户别名").fill(fixture.accounts.stress);
  await page.getByRole("button", { name: "查看复盘", exact: true }).click();
  const cash = page.getByRole("region", { name: "现金核对", exact: true });
  await cash
    .getByRole("region", { name: "逐日现金核对", exact: true })
    .locator("tbody tr")
    .first()
    .waitFor({ timeout: 60000 });
  assert.ok(reads(0).length > 0);
  const cdp = nativeVisibility
    ? await page.context().newCDPSession(page)
    : null;
  const windowInfo = cdp ? await cdp.send("Browser.getWindowForTarget") : null;
  if (cdp) {
    await cdp.send("Browser.setWindowBounds", {
      windowId: windowInfo.windowId,
      bounds: { windowState: "minimized" },
    });
    await page.waitForFunction(
      () => document.visibilityState === "hidden",
      null,
      { polling: 100, timeout: 5000 },
    );
  } else
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  await page.waitForTimeout(500);
  const hidden = requests.length;
  await page.waitForTimeout(60000);
  assert.deepEqual(reads(hidden), []);
  checks.push({
    name: nativeVisibility
      ? "native minimized hidden 60s"
      : "controlled hidden 60s",
    moduleReads: 0,
  });
  console.log("Hidden 60s passed");
  await page.evaluate(async (account) => {
    await fetch(
      `/api/trpc/cashWorkspace?input=${encodeURIComponent(JSON.stringify({ json: { account } }))}`,
      { headers: { "x-quant-client": "workbench" } },
    );
  }, fixture.accounts.stress);
  assert.throws(() => assert.deepEqual(reads(hidden), []));
  checks.push({
    name: "forced hidden request negative control",
    detected: true,
  });
  const resume = requests.length;
  if (cdp) {
    await cdp.send("Browser.setWindowBounds", {
      windowId: windowInfo.windowId,
      bounds: { windowState: "normal" },
    });
    await page.bringToFront();
    await page.waitForFunction(() => document.visibilityState === "visible");
  } else
    await page.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    });
  await page.waitForTimeout(1000);
  assert.equal(
    reads(resume).filter((name) => name === "cashWorkspace").length,
    1,
  );
  checks.push({ name: "resume", moduleReads: reads(resume).length });
  await page.locator('a[href="/reports"]').first().click();
  await page.waitForTimeout(1000);
  const offroute = requests.length;
  await page.waitForTimeout(60000);
  assert.deepEqual(reads(offroute), []);
  checks.push({ name: "offroute 60s", moduleReads: 0 });
  console.log("Offroute 60s passed");
  const result = {
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
    checks,
    visibilityMode: nativeVisibility
      ? "native headful Chrome minimized/restored by CDP; real visibilityState; offroute real navigation"
      : "controlled DOM visibilitychange; offroute uses real navigation",
    requests,
  };
  writeFileSync(
    join(
      logs,
      nativeVisibility ? "q3-native-lifecycle.json" : "q3-lifecycle.json",
    ),
    JSON.stringify(result, null, 2),
  );
} finally {
  await browser.close();
}
