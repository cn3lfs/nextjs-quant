import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  let reads = 0;
  page.on("request", (request) => {
    if (
      request.url().includes("/api/trpc/") &&
      request.url().includes("clsReview")
    )
      reads++;
  });
  await page.goto("http://127.0.0.1:3224/cls-review");
  await page
    .getByLabel("报告列表", { exact: true })
    .getByRole("button")
    .first()
    .waitFor();
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const before = reads;
  await page.evaluate(async () => {
    const response = await fetch("/api/trpc/clsReviewSummary", {
      headers: { "x-quant-client": "workbench" },
    });
    if (!response.ok) throw new Error("negative-control request failed");
    await response.text();
  });
  assert.throws(
    () => assert.equal(reads, before, "hidden zero-read guard"),
    /hidden zero-read guard/,
  );
  writeFileSync(
    join(tmpdir(), "logs/quant-cls-review/hidden-negative.json"),
    JSON.stringify(
      {
        before,
        after: reads,
        detected: true,
        note: "Deliberate request while visibility is hidden; positive 60-second check is separate",
      },
      null,
      2,
    ),
  );
  console.log("Hidden read guard rejected deliberately injected request");
} finally {
  await browser.close();
}
