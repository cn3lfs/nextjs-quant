import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const db = new Database(join(tmpdir(), "quant-signals-s0/quant.sqlite"));
const originals = db
  .prepare(
    "SELECT * FROM records WHERE kind='delivery' ORDER BY json_extract(payload,'$.createdAt') DESC,id DESC LIMIT 20",
  )
  .all();
const update = db.prepare("UPDATE records SET payload=? WHERE id=?");
const bodies = new Map(
  originals.map((row) => [
    row.id,
    ("SIGNALS_LARGE_" + row.id + " 完整🙂\n").padEnd(1048576, "x"),
  ]),
);
let browser;
try {
  db.transaction(() => {
    for (const row of originals)
      update.run(
        JSON.stringify({
          ...JSON.parse(row.payload),
          body: bodies.get(row.id),
        }),
        row.id,
      );
  })();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let detailReads = 0,
    created = 0,
    revoked = 0;
  page.on("request", (request) => {
    if (
      request.url().includes("/api/trpc/") &&
      request.url().includes("deliveryWorkspaceDetail")
    )
      detailReads++;
  });
  await page.goto("http://127.0.0.1:3225/signals?monitorTab=deliveries");
  const list = page.getByLabel("投递列表", { exact: true });
  await list.getByRole("button").first().waitFor();
  const cdp = await page.context().newCDPSession(page);
  const samples = [];
  const sample = async (visits) => {
    await cdp.send("HeapProfiler.collectGarbage");
    const usage = await cdp.send("Runtime.getHeapUsage");
    samples.push({ visits, ...usage });
  };
  await sample(0);
  const openTimes = [];
  for (let i = 0; i < 35; i++) {
    const row = originals[i % 20],
      value = JSON.parse(row.payload),
      start = performance.now();
    await list
      .getByRole("button", { name: new RegExp("^" + value.title + " ") })
      .click();
    const text = page.getByLabel("消息正文", { exact: true });
    await text.waitFor();
    assert.ok((await text.innerText()).startsWith("SIGNALS_LARGE_" + row.id));
    if (i >= 5) openTimes.push(performance.now() - start);
    if (i === 0) {
      await page.evaluate(() => {
        globalThis.fixtureBlobs = { created: 0, revoked: 0 };
        const create = URL.createObjectURL,
          revoke = URL.revokeObjectURL;
        URL.createObjectURL = (...args) => {
          globalThis.fixtureBlobs.created++;
          return create(...args);
        };
        URL.revokeObjectURL = (...args) => {
          globalThis.fixtureBlobs.revoked++;
          return revoke(...args);
        };
      });
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "导出完整证据", exact: true })
        .click();
      const result = JSON.parse(
        readFileSync(await (await download).path(), "utf8"),
      );
      assert.equal(result.value.body, bodies.get(row.id));
      const hashes = [result.value.body, bodies.get(row.id)].map((s) =>
        createHash("sha256").update(s).digest("hex"),
      );
      assert.equal(hashes[0], hashes[1]);
      const blobs = await page.evaluate(() => globalThis.fixtureBlobs);
      created = blobs.created;
      revoked = blobs.revoked;
      assert.equal(created, revoked);
      // Reader is segmented, but navigation reaches the exact final segment.
      const next = page.getByRole("button", {
        name: "消息正文下一段",
        exact: true,
      });
      assert.ok(await next.isEnabled());
      await next.click();
      assert.ok((await text.innerText()).length <= 8001);
    }
    await page.getByRole("button", { name: "返回列表", exact: true }).click();
    await page.waitForTimeout(30);
    if ([5, 10, 20, 35].includes(i + 1)) await sample(i + 1);
  }
  assert.equal(
    detailReads,
    35,
    "each closed detail is released; revisits read it again",
  );
  const storage = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  assert.ok(!storage.includes("SIGNALS_LARGE_"));
  const persisted = await page.evaluate(async () => {
    const info = await indexedDB.databases();
    if (!info.some((value) => value.name === "guanlan-query-cache")) return [];
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("guanlan-query-cache");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("queries")) {
          database.close();
          resolve([]);
          return;
        }
        const read = database
          .transaction("queries")
          .objectStore("queries")
          .getAll();
        read.onsuccess = () => {
          database.close();
          resolve(read.result);
        };
        read.onerror = () => {
          database.close();
          reject(read.error);
        };
      };
    });
  });
  assert.ok(!JSON.stringify(persisted).includes("SIGNALS_LARGE_"));
  // Twenty independent 1 MiB bodies would retain >20 MiB; allow small engine/component warmup.
  const lateGrowth =
    samples.at(-1).usedSize - samples.find((s) => s.visits === 20).usedSize;
  assert.ok(
    lateGrowth < 5 * 1024 * 1024,
    "last 15 visits cannot retain a body per visit",
  );
  assert.ok(
    samples.at(-1).usedSize - samples[0].usedSize < 12 * 1024 * 1024,
    "no twenty-body retention",
  );
  openTimes.sort((a, b) => a - b);
  const result = {
    bodyBytes: Buffer.byteLength(bodies.values().next().value),
    distinctBodies: 20,
    visits: 35,
    openP50: openTimes[15],
    openP95: openTimes[28],
    detailReads,
    created,
    revoked,
    samples,
    lateGrowth,
    persistentBodyFound: false,
    indexedDbEntries: persisted.length,
    errors,
  };
  writeFileSync(
    join(tmpdir(), "logs/quant-signals/large-body-memory.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  assert.ok(result.openP95 <= 1000);
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  db.transaction(() => {
    for (const row of originals) update.run(row.payload, row.id);
  })();
  for (const row of originals)
    assert.deepEqual(
      db.prepare("SELECT * FROM records WHERE id=?").get(row.id),
      row,
    );
  db.close();
}
