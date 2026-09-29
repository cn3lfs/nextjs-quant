import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const base = "http://127.0.0.1:3228",
  requests = [],
  errors = [],
  checks = [];
const reads = (from) =>
  requests
    .slice(from)
    .filter((name) =>
      /^delivery(?:FilePage|Preview|Batch|Evidence|Receipt|Revoke)/.test(name),
    );
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/api/trpc/"))
      requests.push(
        ...new URL(request.url()).pathname.split("/api/trpc/")[1].split(","),
      );
  });
  await page.goto(`${base}/trade-review`);
  await page.getByRole("button", { name: "历史批次", exact: true }).click();
  await page
    .getByRole("button", { name: "查看批次 history-999.csv", exact: true })
    .waitFor();
  assert.ok(reads(0).includes("deliveryBatchPage"));
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1000);
  let begin = requests.length;
  await page.waitForTimeout(60000);
  assert.deepEqual(reads(begin), []);
  checks.push({
    name: "hidden-60s",
    moduleReads: 0,
    globalReads: requests.length - begin,
  });
  console.log("hidden 60s passed");
  await page.evaluate(async () => {
    const response = await fetch(
      "/api/trpc/deliveryBatchPage?input=" +
        encodeURIComponent(JSON.stringify({ json: {} })),
      { headers: { "x-quant-client": "workbench" } },
    );
    if (!response.ok) throw new Error("negative control request failed");
  });
  assert.throws(() => assert.deepEqual(reads(begin), []));
  checks.push({ name: "forced-hidden-read-negative-control", detected: true });
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.locator('a[href="/reports"]').first().click();
  await page.waitForTimeout(1000);
  begin = requests.length;
  await page.waitForTimeout(60000);
  assert.deepEqual(reads(begin), []);
  checks.push({
    name: "offroute-60s",
    moduleReads: 0,
    globalReads: requests.length - begin,
  });
  assert.deepEqual(errors, []);
  const result = {
    checks,
    requests,
    errors,
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
  };
  writeFileSync(
    join(
      tmpdir(),
      "logs/quant-delivery-import/workspace-lifecycle-browser.json",
    ),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
