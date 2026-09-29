import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const logs = join(tmpdir(), "logs/quant-delivery-import"),
  base = "http://127.0.0.1:3228";
const fixture = JSON.parse(readFileSync(join(logs, "fixture.json"), "utf8"));
assert.equal(
  resolve(fixture.directory),
  resolve(join(tmpdir(), "quant-delivery-import-browser")),
);
const db = new Database(join(fixture.directory, "quant.sqlite"));
const hash = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const original = () =>
  hash(db.prepare("SELECT * FROM import_batches ORDER BY id").all());
assert.equal(original(), fixture.hash);
const account = "内存验收合成账户",
  prefix = "memory-check-";
assert.equal(
  db
    .prepare("SELECT count(*) n FROM import_batches WHERE account=?")
    .get(account).n,
  0,
);
const rawRows = Array.from({ length: 1000 }, (_, i) => [
  String(i),
  "evidence-only-" + "x".repeat(1100),
]);
const payload = {
  statistics: { fills: 0, cashFlows: 0, unresolved: 0, anomalies: 0 },
  rawRows,
  unresolved: [],
  diagnostics: [],
};
assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 1048576);
db.transaction(() => {
  const insert = db.prepare(
    "INSERT INTO import_batches VALUES (?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < 20; i++)
    insert.run(
      `${prefix}${i}`,
      account,
      "generic",
      `${prefix}hash-${i}`,
      `memory-${i}.csv`,
      1700000000000 + i,
      JSON.stringify(payload),
    );
})();
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  errors = [],
  samples = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__deliveryBlobs = new Set();
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      window.__deliveryBlobs.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      window.__deliveryBlobs.delete(url);
      revoke(url);
    };
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await page.goto(`${base}/trade-review`);
  await page.getByRole("button", { name: "历史批次", exact: true }).click();
  await page.getByLabel("批次账户", { exact: true }).fill(account);
  await page.getByRole("button", { name: "检索批次", exact: true }).click();
  await page
    .getByRole("button", { name: "查看批次 memory-19.csv", exact: true })
    .waitFor();
  async function sample(visits) {
    await cdp.send("HeapProfiler.collectGarbage");
    samples.push({
      visits,
      ...(await cdp.send("Runtime.getHeapUsage")),
      dom: await page.locator("*").count(),
    });
  }
  await sample(0);
  let firstMs;
  for (let i = 0; i < 35; i++) {
    const started = performance.now();
    await page
      .getByRole("button", {
        name: `查看批次 memory-${i % 20}.csv`,
        exact: true,
      })
      .click();
    const detail = page.getByLabel("批次证据详情", { exact: true });
    await detail
      .getByText("从第 1 条开始，本页 20 条；完整证据可导出。", { exact: true })
      .waitFor();
    if (i === 0) {
      firstMs = performance.now() - started;
      const download = page.waitForEvent("download");
      await detail
        .getByRole("button", { name: "导出本批完整 JSON", exact: true })
        .click();
      const exported = JSON.parse(
        readFileSync(await (await download).path(), "utf8"),
      );
      assert.equal(hash(exported.evidence), hash(payload));
      assert.equal(exported.evidence.rawRows.length, 1000);
    }
    await detail
      .getByRole("button", { name: "返回批次列表", exact: true })
      .click();
    await page.waitForFunction(() =>
      document.activeElement?.id?.startsWith("delivery-batch-memory-check-"),
    );
    if ([5, 10, 20, 30, 35].includes(i + 1)) await sample(i + 1);
  }
  await page.waitForFunction(() => window.__deliveryBlobs.size === 0);
  const persisted = await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    let text = "";
    for (const { name } of databases) {
      if (!name?.includes("query")) continue;
      const database = await new Promise((res, rej) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      for (const store of database.objectStoreNames) {
        text += await new Promise((res, rej) => {
          const req = database.transaction(store).objectStore(store).getAll();
          req.onsuccess = () => res(JSON.stringify(req.result));
          req.onerror = () => rej(req.error);
        });
      }
      database.close();
    }
    return text;
  });
  assert.equal(persisted.includes("evidence-only-"), false);
  assert.deepEqual(errors, []);
  const growth =
    samples.at(-1).usedSize - samples.find((s) => s.visits === 10).usedSize;
  const report = {
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
    samples,
    firstMs,
    growth,
    blobUrls: 0,
    persistedEvidence: false,
    errors,
    scope:
      "20 different >1MiB batches, 35 visits; forced browser GC; not a universal leak proof",
  };
  writeFileSync(
    join(logs, "workspace-memory-browser.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  assert.ok(firstMs <= 1000, `first evidence ${firstMs}ms`);
  assert.ok(growth < 8 * 1048576, `post-warm browser heap growth ${growth}`);
} finally {
  await browser.close();
  db.prepare(
    "DELETE FROM import_batches WHERE account=? AND substr(id,1,?)=?",
  ).run(account, prefix.length, prefix);
  assert.equal(original(), fixture.hash);
  db.close();
}
