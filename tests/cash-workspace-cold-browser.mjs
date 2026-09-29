import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = "http://127.0.0.1:3232",
  logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const fixture = JSON.parse(readFileSync(join(logs, "q3-fixture.json"), "utf8"));
assert.equal(
  resolve(fixture.directory),
  resolve(join(tmpdir(), "quant-cash-reconciliation-pressure")),
);
assert.equal(
  await fetch(base).then(
    () => true,
    () => false,
  ),
  false,
  "cold-test port already owned",
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const samples = [];
try {
  for (let i = 0; i < 5; i++) {
    let output = "";
    const started = performance.now();
    const server = spawn(
      process.execPath,
      [resolve(".next/standalone/server.js")],
      {
        windowsHide: true,
        env: {
          ...process.env,
          HOSTNAME: "127.0.0.1",
          PORT: "3232",
          QUANT_DATA_DIR: fixture.directory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout.on("data", (chunk) => {
      output += chunk;
    });
    server.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    try {
      const deadline = Date.now() + 30000;
      while (!output.includes("Ready")) {
        assert.equal(server.exitCode, null, output);
        assert.ok(Date.now() < deadline);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const readyMs = performance.now() - started;
      const page = await context.newPage();
      const pageStart = performance.now();
      await page.goto(`${base}/trade-review`, { waitUntil: "networkidle" });
      await page.bringToFront();
      await page.getByLabel("复盘账户别名").fill(fixture.accounts.stress);
      const navigationMs = performance.now() - pageStart;
      const accountStart = performance.now();
      await page.getByRole("button", { name: "查看复盘", exact: true }).click();
      const cash = page.getByRole("region", { name: "现金核对", exact: true });
      await cash
        .getByRole("region", { name: "逐日现金核对", exact: true })
        .locator("tbody tr")
        .first()
        .waitFor({ timeout: 60000 });
      const accountMs = performance.now() - accountStart;
      samples.push({
        iteration: i + 1,
        pid: server.pid,
        readyMs,
        navigationMs,
        accountMs,
        navigationToCashMs: performance.now() - pageStart,
      });
      console.log(JSON.stringify(samples.at(-1)));
    } finally {
      await context.close();
      if (server.exitCode === null) {
        const exited = new Promise((resolve) => server.once("exit", resolve));
        if (process.platform === "win32")
          spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        else server.kill("SIGTERM");
        await exited;
      }
      writeFileSync(join(logs, `q3-cold-${i + 1}.log`), output);
      assert.equal(
        await fetch(base).then(
          () => true,
          () => false,
        ),
        false,
      );
    }
  }
  const sorted = samples
    .map((sample) => sample.accountMs)
    .sort((a, b) => a - b);
  const result = {
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
    samples,
    accountP50: sorted[2],
    accountP95: sorted[4],
    scope:
      "five fresh services and browser contexts, no account prewarming; account timing starts at selection; navigation and service startup reported separately; OS file cache not cleared",
  };
  writeFileSync(join(logs, "q3-cold.json"), JSON.stringify(result, null, 2));
  assert.ok(sorted[4] <= 2500, "cold account budget exceeded");
} finally {
  await browser.close();
}
