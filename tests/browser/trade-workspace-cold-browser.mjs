import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = "http://127.0.0.1:3227",
  samples = [],
  logs = join(tmpdir(), "logs/quant-trade-ledger");
// Refuse to share an already-owned port, then start one fresh server for each sample.
assert.equal(
  await fetch(base).then(
    () => true,
    () => false,
  ),
  false,
  "cold-test port already in use",
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (let i = 0; i < 5; i++) {
    let output = "";
    const start = performance.now();
    const server = spawn(
      process.execPath,
      [resolve(".next/standalone/server.js")],
      {
        windowsHide: true,
        env: {
          ...process.env,
          HOSTNAME: "127.0.0.1",
          PORT: "3227",
          QUANT_DATA_DIR: join(tmpdir(), "quant-trade-ledger-s0b"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout.on("data", (chunk) => (output += chunk));
    server.stderr.on("data", (chunk) => (output += chunk));
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    try {
      const deadline = Date.now() + 30000;
      while (!output.includes("Ready")) {
        assert.equal(server.exitCode, null, output);
        assert.ok(Date.now() < deadline, "server readiness timeout: " + output);
        await new Promise((r) => setTimeout(r, 100));
      }
      const readyMs = performance.now() - start,
        page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const pageStart = performance.now();
      await page.goto(base + "/trade-ledger?view=history");
      await page
        .getByLabel("交易历史列表", { exact: true })
        .getByRole("button")
        .first()
        .waitFor();
      const historyMs = performance.now() - pageStart;
      await page
        .getByLabel("全部持仓摘要", { exact: true })
        .getByText("10000笔", { exact: true })
        .waitFor();
      const holdingsMs = performance.now() - pageStart;
      assert.deepEqual(errors, []);
      samples.push({
        iteration: i + 1,
        pid: server.pid,
        readyMs,
        historyMs,
        holdingsMs,
      });
    } finally {
      await context.close();
      if (server.exitCode === null) {
        const exited = new Promise((r) => server.once("exit", r));
        if (process.platform === "win32")
          spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        else server.kill("SIGTERM");
        await exited;
      }
      writeFileSync(join(logs, `cold-server-${i + 1}.log`), output);
      assert.equal(
        await fetch(base).then(
          () => true,
          () => false,
        ),
        false,
        "owned cold server must exit",
      );
    }
  }
  const stats = (key) => {
    const values = samples.map((s) => s[key]).sort((a, b) => a - b);
    return { p50: values[2], p95: values[4] };
  };
  const result = {
    build: readFileSync(".next/BUILD_ID", "utf8"),
    samples,
    history: stats("historyMs"),
    holdings: stats("holdingsMs"),
    server: stats("readyMs"),
    scope:
      "five fresh server processes and browser contexts; filesystem OS cache not cleared",
  };
  writeFileSync(
    join(logs, "cold-browser.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(result);
} finally {
  await browser.close();
}
