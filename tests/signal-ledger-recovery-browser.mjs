/** Read-only production interaction checks; network failure injected in browser only. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = process.env.BASE ?? "http://127.0.0.1:3222";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(base + "/signal-ledger");
  const first = page.locator("button[data-ledger-signal]").first();
  await first.waitFor();
  const id = await first.getAttribute("data-ledger-signal");
  await page.route("**/api/trpc/**", async (route) => {
    if (route.request().url().includes("ledgerDetail"))
      await route.abort("failed");
    else await route.continue();
  });
  await first.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "重试读取", exact: true }).waitFor();
  assert.ok(page.url().includes("signal="));
  await page.unroute("**/api/trpc/**");
  await page.getByRole("button", { name: "重试读取", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "导出完整信号依据", exact: true })
    .waitFor();
  const begin = performance.now();
  await page.getByText("结构证据", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await page
    .locator("details")
    .filter({ has: page.getByText("结构证据", { exact: true }) })
    .locator("pre")
    .waitFor();
  const evidenceExpandAutomationMs = performance.now() - begin;
  await page.getByRole("button", { name: "返回信号列表", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (id) => document.activeElement?.getAttribute("data-ledger-signal") === id,
    id,
  );
  const input = page.getByLabel("证券代码", { exact: true });
  await input.fill("sh999999");
  await input.press("Enter");
  await page.getByText(/当前筛选没有匹配信号/).waitFor();
  writeFileSync(
    join(tmpdir(), "logs", "quant-signal-ledger", "browser-recovery.json"),
    JSON.stringify(
      {
        detailFailureRetry: true,
        keyboardOpenReturnAndSubmit: true,
        restoredId: id,
        evidenceExpandAutomationMs,
        note: "single normal evidence expansion, automation latency not P95",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
