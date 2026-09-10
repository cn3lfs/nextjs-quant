import { temporaryDirectory } from "../scripts/temporary-directory.mjs";
/** M4 milestone UI check. Fresh profile, no subscriptions, no notification tests. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
const require = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
);
const { chromium } = require("playwright");
const temporary = temporaryDirectory("quant-m4-ui-");
const data = temporary.path;
const server = temporary.track(
  spawn(process.execPath, [".next/standalone/server.js"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      QUANT_DATA_DIR: data,
      HOSTNAME: "127.0.0.1",
      PORT: "3214",
    },
  }),
);
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("M4 server startup timeout")),
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
      reject(new Error(`M4 server exited ${code}`));
    });
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  let externalRequests = 0;
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname !== "127.0.0.1") {
      externalRequests++;
      return route.abort();
    }
    return route.continue();
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:3214");
  await page.getByRole("button", { name: "信号与通知", exact: true }).click();
  const strategy = page.getByRole("combobox", {
    name: "监控策略",
    exact: true,
  });
  await strategy.selectOption("czsc");
  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "新建监控订阅" }) });
  const daily = panel
    .locator("select")
    .filter({ has: page.locator('option[value="5m"]') });
  assert.equal(await daily.inputValue(), "day");
  assert.equal(await daily.isDisabled(), true);
  assert.match(await panel.innerText(), /15:05/);
  await strategy.selectOption("ma-cross");
  assert.equal(await daily.isEnabled(), true);
  assert.equal(await panel.locator('input[type="number"]').count(), 5);
  assert.deepEqual(errors, []);
  assert.equal(externalRequests, 0);
  console.log(
    JSON.stringify({
      m4Ui: "passed",
      externalRequests,
      actualNetworkDeliveries: 0,
      profile: data,
    }),
  );
} finally {
  await browser?.close();
  server.kill();
}
