import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const base = "http://127.0.0.1:3226",
  requests = [],
  errors = [],
  checks = [];
const moduleReads = (from) =>
  requests.slice(from).filter((name) => name.startsWith("tradeWorkspace"));
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("/api/trpc/"))
      requests.push(
        ...new URL(r.url()).pathname.split("/api/trpc/")[1].split(","),
      );
  });
  await page.goto(base + "/trade-ledger?view=history");
  await page
    .getByLabel("交易历史列表", { exact: true })
    .getByRole("button")
    .first()
    .waitFor();
  await page
    .getByLabel("全部持仓摘要", { exact: true })
    .getByText("10000笔", { exact: true })
    .waitFor();
  assert.ok(moduleReads(0).length >= 2, "observer sees initial module reads");
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
  assert.deepEqual(moduleReads(hidden), []);
  checks.push({
    name: "controlled hidden 60s",
    moduleReads: 0,
    globalReads: requests.length - hidden,
  });
  console.log("Hidden passed");
  await page.evaluate(async () => {
    await fetch("/api/trpc/tradeWorkspaceEnvironment", {
      headers: { "x-quant-client": "workbench" },
    });
  });
  assert.throws(() => assert.deepEqual(moduleReads(hidden), []));
  checks.push({ name: "negative control forced hidden read", detected: true });
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.locator('a[href="/reports"]').first().click();
  await page.waitForTimeout(1000);
  const left = requests.length;
  await page.waitForTimeout(60000);
  assert.deepEqual(moduleReads(left), []);
  checks.push({
    name: "offroute 60s",
    moduleReads: 0,
    globalReads: requests.length - left,
  });
  assert.deepEqual(errors, []);
  writeFileSync(
    join(tmpdir(), "logs/quant-trade-ledger/lifecycle-browser.json"),
    JSON.stringify(
      {
        checks,
        requests,
        errors,
        build: readFileSync(".next/BUILD_ID", "utf8"),
      },
      null,
      2,
    ),
  );
  console.log("Lifecycle passed");
} finally {
  await browser.close();
}
