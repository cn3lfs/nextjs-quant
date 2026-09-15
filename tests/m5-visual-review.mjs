import { temporaryDirectory } from "../scripts/temporary-directory.mjs";
/** M5 milestone-only browser capture. Existing chart + real tRPC engine.
 * Isolated profile seeded with immutable historical fixtures. Only the snapshot
 * selection response is redirected to those fixtures; breakout is NOT mocked.
 * No subscriptions, channels, source writes, or external browser requests.
 * Run after build + desktop:prepare: pnpm exec tsx tests/m5-visual-review.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { put, sqlite } from "../src/server/db/index.ts";
import { settingsSchema } from "../src/lib/domain.ts";
const require = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
);
const { chromium } = require("playwright");
const temporary = temporaryDirectory("quant-m5-ui-");
const data = temporary.path;
process.env.QUANT_DATA_DIR = data;
put(
  "settings",
  "settings",
  settingsSchema.parse({ autoAnalysis: false, autoNewsAnalysis: false }),
);
const cases = [];
for (const name of ["valid", "false", "insufficient"]) {
  const f = JSON.parse(
    await readFile(`tests/fixtures/breakout-${name}.json`, "utf8"),
  );
  const snapshot = {
    id: `snapshot-m5-${name}`,
    symbol: f.symbol,
    name: f.symbol,
    period: "day",
    source: "tdx-local",
    adjustment: "none",
    createdAt: 0,
    bars: f.bars,
    hash: f.barsHash,
    historicalAsOf: f.cutoff,
  };
  put("snapshot", snapshot.id, snapshot);
  cases.push({ name, snapshot });
}
sqlite().close();
await mkdir("docs/m5-review", { recursive: true });
const server = temporary.track(
  spawn(process.execPath, [".next/standalone/server.js"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      QUANT_DATA_DIR: data,
      HOSTNAME: "127.0.0.1",
      PORT: "3215",
    },
  }),
);
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("M5 server startup timeout")),
      30000,
    );
    server.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("Ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`M5 server exited ${code}`));
    });
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1900, height: 1250 },
    timezoneId: "Asia/Shanghai",
  });
  const errors = [],
    captures = [];
  let externalRequests = 0,
    selected = cases[0].snapshot;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") {
      externalRequests++;
      return route.abort();
    }
    if (
      url.pathname === "/api/trpc/snapshot" &&
      route.request().method() === "POST"
    ) {
      // Preserve the application's actual JSONL streaming envelope. A normal
      // JSON batch response is not compatible with httpBatchStreamLink.
      const response = await route.fetch();
      const substitute = (value) => {
        if (!value || typeof value !== "object") return value;
        if (
          Array.isArray(value.bars) &&
          typeof value.id === "string" &&
          value.id.startsWith("snapshot-")
        )
          return selected;
        if (Array.isArray(value)) return value.map(substitute);
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, substitute(entry)]),
        );
      };
      const body = (await response.text())
        .split("\n")
        .map((line) =>
          line.trim() ? JSON.stringify(substitute(JSON.parse(line))) : line,
        )
        .join("\n");
      return route.fulfill({ response, body });
    }
    return route.continue();
  });
  await page.goto("http://127.0.0.1:3215");
  for (const entry of cases) {
    selected = entry.snapshot;
    await page.getByRole("button", { name: "日 K", exact: true }).click();
    const chart = page.getByTestId("market-chart");
    await page
      .waitForFunction(
        (date) =>
          document
            .querySelector('[data-testid="breakout-status"]')
            ?.textContent?.includes(`${date} · 多`),
        selected.historicalAsOf,
        { timeout: 60000 },
      )
      .catch(async (error) => {
        console.log(
          "M5 UI",
          (await page.locator("body").innerText()).slice(-9000),
          errors,
        );
        throw error;
      });
    await chart.getByLabel("缠论结构", { exact: true }).uncheck();
    await chart.getByLabel("副图", { exact: true }).selectOption("volume");
    const status = await chart.getByTestId("breakout-status").innerText();
    assert.match(
      status,
      entry.name === "valid"
        ? /多 是 4\/5/
        : entry.name === "false"
          ? /多 否 3\/5/
          : /多 未知 未知/,
    );
    await chart.scrollIntoViewIfNeeded();
    // Leave room after the observation bar so right-axis level labels cannot
    // obscure the latest breakthrough arrow during manual review.
    const bounds = await chart.locator(".price-chart").boundingBox();
    await page.mouse.move(bounds.x + bounds.width * 0.72, bounds.y + 180);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.48, bounds.y + 180, {
      steps: 15,
    });
    await page.mouse.up();
    await page.mouse.move(bounds.x + 20, bounds.y - 10);
    await page.waitForTimeout(250);
    await chart.screenshot({
      path: `docs/m5-review/${entry.name}-${selected.symbol}-${selected.historicalAsOf}.png`,
    });
    captures.push({
      name: entry.name,
      symbol: selected.symbol,
      date: selected.historicalAsOf,
      status,
    });
    await chart.getByLabel("双突破", { exact: true }).uncheck();
    await chart.getByLabel("双突破", { exact: true }).check();
  }
  await page.getByRole("button", { name: "信号与通知", exact: true }).click();
  await page
    .getByRole("combobox", { name: "监控策略", exact: true })
    .selectOption("dual-breakout");
  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "新建监控订阅" }) });
  const daily = panel
    .locator("select")
    .filter({ has: page.locator('option[value="5m"]') });
  assert.equal(await daily.inputValue(), "day");
  assert.equal(await daily.isDisabled(), true);
  assert.deepEqual(errors, []);
  assert.equal(externalRequests, 0);
  await writeFile(
    "docs/m5-review/capture.json",
    JSON.stringify(
      {
        captures,
        errors,
        externalRequests,
        visualReview: "待管理者人工确认",
        profile: data,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ captures, errors, externalRequests }));
} finally {
  await browser?.close();
  server.kill();
}
