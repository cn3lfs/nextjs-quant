import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = process.env.BASE ?? "http://127.0.0.1:3230";
const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const fixture = JSON.parse(readFileSync(join(logs, "q0-fixture.json"), "utf8"));
const before = JSON.parse(
  readFileSync(join(logs, "q0-http-browser.json"), "utf8"),
);
assert.equal(before.fixtureHash, fixture.hash);
const input = { account: fixture.account, order: { id: "date", desc: false } };
const samples = [];
let bytes = 0;
for (let i = 0; i < 35; i++) {
  const start = performance.now();
  const response = await fetch(
    `${base}/api/trpc/cashWorkspace?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
    {
      headers: { "x-quant-client": "workbench", origin: base },
    },
  );
  const body = await response.text();
  assert.equal(response.status, 200, body.slice(0, 500));
  const value = JSON.parse(body).result.data.json;
  assert.equal(value.total, 1000);
  assert.equal(value.rows.length, 20);
  assert.equal(value.rows[0].date, "2020-01-01");
  assert.ok(value.rows.every((row) => !("evidence" in row)));
  bytes = Buffer.byteLength(body);
  if (i >= 5) samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/trade-review`, { waitUntil: "networkidle" });
  await page.getByLabel("复盘账户别名").fill(fixture.account);
  await page.getByRole("button", { name: "查看复盘", exact: true }).click();
  const cash = page.getByRole("region", { name: "现金核对", exact: true });
  const table = cash.getByRole("region", { name: "逐日现金核对", exact: true });
  await table.locator("tbody tr").first().waitFor({ timeout: 60000 });
  await table.getByRole("button", { name: "日期", exact: true }).click();
  await table
    .getByRole("button", { name: "2020-01-01", exact: true })
    .waitFor();
  assert.equal(await table.locator("tbody tr").count(), 20);
  const nodes = await cash.locator("*").count();
  await cash.evaluate((element) =>
    window.scrollTo({
      top: element.getBoundingClientRect().top + window.scrollY - 80,
    }),
  );
  await cash.screenshot({ path: join(logs, "final-cash-1440-summary.png") });
  assert.deepEqual(errors, []);
  const result = {
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
    fixtureHash: fixture.hash,
    comparison:
      "same 1000-date fixture, ascending first 20 dates including 20000-row first source; old build browser saved before implementation",
    before: {
      build: before.build,
      http: before.http,
      nodes: before.browser.nodes,
    },
    after: {
      http: {
        n: samples.length,
        p50: samples[14],
        p95: samples[28],
        max: samples.at(-1),
        bytes,
      },
      nodes,
      errors,
    },
  };
  writeFileSync(
    join(logs, "final-comparison.json"),
    JSON.stringify(result, null, 2),
  );
  assert.ok(bytes <= 65536);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
