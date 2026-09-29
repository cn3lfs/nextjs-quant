import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { armCashTiming, cashTiming } from "./helpers/cash-browser-timing.mjs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = "http://127.0.0.1:3231",
  logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const fixture = JSON.parse(readFileSync(join(logs, "q3-fixture.json"), "utf8"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
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
  await cash
    .getByLabel("现金起始日期", { exact: true })
    .fill(fixture.calendar[1]);
  await page.route(
    (url) =>
      new URL(url).pathname
        .split("/")
        .at(-1)
        .split(",")
        .includes("cashWorkspace"),
    async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await armCashTiming(page, { kind: "filter", count: 9999 });
  await cash.getByRole("button", { name: "查询现金日期", exact: true }).click();
  const ms = await cashTiming(page);
  assert.ok(
    ms >= 400,
    "first-paint sensor must include an injected response delay",
  );
  assert.throws(
    () => assert.ok(ms <= 300),
    "300ms guard must reject the deliberate regression",
  );
  const result = {
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
    injectedDelayMs: 400,
    measuredMs: ms,
    budgetFailureDetected: true,
  };
  writeFileSync(
    join(logs, "q3-timing-control.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
