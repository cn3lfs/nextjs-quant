import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = "http://127.0.0.1:3229",
  samples = [],
  logs = join(tmpdir(), "logs/quant-delivery-import");
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
let previousToken;
let restartChecks = 0;
async function request(name, input, mutation = false) {
  const payload = JSON.stringify({ json: input });
  const response = await fetch(
    `${base}/api/trpc/${name}${mutation ? "" : `?input=${encodeURIComponent(payload)}`}`,
    {
      method: mutation ? "POST" : "GET",
      headers: {
        "x-quant-client": "workbench",
        origin: base,
        "content-type": "application/json",
      },
      ...(mutation ? { body: payload } : {}),
    },
  );
  return { status: response.status, body: await response.text() };
}
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
          PORT: "3229",
          QUANT_DATA_DIR: join(tmpdir(), "quant-delivery-import-browser"),
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
      await page.goto(base + "/trade-review");
      await page.getByRole("button", { name: "历史批次", exact: true }).click();
      await page
        .getByRole("button", { name: "查看批次 history-999.csv", exact: true })
        .waitFor();
      const historyMs = performance.now() - pageStart;
      await page
        .getByRole("button", { name: "查看批次 history-999.csv", exact: true })
        .click();
      await page
        .getByLabel("批次证据详情", { exact: true })
        .getByRole("heading")
        .waitFor();
      const detailMs = performance.now() - pageStart;
      assert.deepEqual(errors, []);
      samples.push({
        iteration: i + 1,
        pid: server.pid,
        readyMs,
        historyMs,
        detailMs,
      });
      // Only after cold timings: prove that volatile previews do not survive
      // a real process restart, while persisted batches remain readable.
      if (previousToken) {
        const old = await request("deliveryPreviewPage", {
          token: previousToken,
        });
        assert.notEqual(old.status, 200);
        assert.match(old.body, /预览已过期或服务已重启/);
        restartChecks++;
      }
      const persisted = await request(
        "deliveryBatchDetail",
        "fixture-batch-00999",
      );
      assert.equal(persisted.status, 200);
      assert.equal(
        JSON.parse(persisted.body).result.data.json.id,
        "fixture-batch-00999",
      );
      const started = await request(
        "deliveryPreviewStart",
        {
          path: join(
            tmpdir(),
            "quant-delivery-import-browser/synthetic-files/large.csv",
          ),
          account: "冷服务预览验收",
          source: "generic",
        },
        true,
      );
      assert.equal(started.status, 200);
      previousToken = JSON.parse(started.body).result.data.json.token;
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
      writeFileSync(join(logs, `delivery-cold-server-${i + 1}.log`), output);
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
    restartChecks,
    build: readFileSync(".next/BUILD_ID", "utf8"),
    samples,
    history: stats("historyMs"),
    detail: stats("detailMs"),
    server: stats("readyMs"),
    scope:
      "five fresh server processes and browser contexts; filesystem OS cache not cleared",
  };
  assert.equal(restartChecks, 4);
  writeFileSync(
    join(logs, "workspace-cold-browser.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(result);
} finally {
  await browser.close();
}
