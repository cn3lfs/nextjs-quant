import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, cpus, totalmem } from "node:os";
const base = "http://127.0.0.1:3228",
  logs = join(tmpdir(), "logs/quant-delivery-import");
const fixture = JSON.parse(readFileSync(join(logs, "fixture.json"), "utf8"));
assert.ok(
  fixture.directory.startsWith(join(tmpdir(), "quant-delivery-import-")),
);
const db = new Database(join(fixture.directory, "quant.sqlite"));
const results = [],
  account = "性能导入验收",
  ids = [];
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function request(name, input, mutation = false) {
  const payload = JSON.stringify({ json: input });
  const started = performance.now();
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
  const body = await response.text();
  assert.equal(response.status, 200, body.slice(0, 400));
  return {
    value: JSON.parse(body).result.data.json,
    ms: performance.now() - started,
    bytes: Buffer.byteLength(body),
  };
}
async function measure(name, action, budget) {
  const times = [];
  let bytes = 0;
  for (let i = 0; i < 35; i++) {
    const value = await action();
    if (i >= 5) times.push(value.ms);
    bytes = value.bytes;
  }
  times.sort((a, b) => a - b);
  const result = {
    name,
    n: times.length,
    p50: times[14],
    p95: times[28],
    bytes,
    budget,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
async function clearOwned() {
  for (const row of db
    .prepare("SELECT id FROM import_batches WHERE account=?")
    .all(account)) {
    const detail = await request("deliveryBatchDetail", row.id);
    await request("deliveryRevokeChecked", detail.value, true);
  }
}
function assertSummary(result) {
  assert.equal(result.value.items.length, 20);
  assert.ok(result.value.nextCursor);
  assert.ok(result.bytes < 65536);
  assert.ok(!JSON.stringify(result.value).includes("rawRows"));
}
try {
  assert.equal(
    hash(
      JSON.stringify(
        db.prepare("SELECT * FROM import_batches ORDER BY id").all(),
      ),
    ),
    fixture.hash,
  );
  const guardProbe = await request("deliveryBatchPage", {});
  assertSummary(guardProbe);
  const injected = structuredClone(guardProbe);
  injected.value.items[0].rawRows = [["forbidden-evidence"]];
  assert.throws(
    () => assertSummary(injected),
    "summary evidence negative control",
  );
  for (const count of [100, 1000])
    await measure(
      `${count}-batch-page`,
      async () => {
        const result = await request("deliveryBatchPage", {
          account: "合成历史账户",
          to: 1700000000000 + count - 1,
        });
        assertSummary(result);
        assert.equal(result.value.count, count);
        return result;
      },
      200,
    );
  const payload = db
    .prepare("SELECT payload FROM import_batches LIMIT 1")
    .get().payload;
  const insert = db.prepare(
    "INSERT INTO import_batches VALUES (?,?,?,?,?,?,?)",
  );
  db.transaction(() => {
    for (let i = 1000; i < 10000; i++) {
      const id = `perf-batch-${i}`;
      ids.push(id);
      insert.run(
        id,
        "合成历史账户",
        "generic",
        hash(id),
        `history-${i}.csv`,
        1700000000000 + i,
        payload,
      );
    }
  })();
  await measure(
    "10000-batch-page",
    async () => {
      const result = await request("deliveryBatchPage", {});
      assertSummary(result);
      return result;
    },
    200,
  );
  await measure(
    "10000-batch-filter",
    async () =>
      request("deliveryBatchPage", {
        account: "合成历史账户",
        keyword: "history-9",
      }),
    200,
  );
  let token;
  await measure(
    "10000-preview-start",
    async () => {
      const result = await request(
        "deliveryPreviewStart",
        {
          path: join(fixture.files, "large.csv"),
          account,
          source: "generic",
          scope: "all",
        },
        true,
      );
      assert.equal(result.value.summary.new, 10000);
      token = result.value.token;
      return result;
    },
    2000,
  );
  await measure(
    "10000-preview-last-page",
    async () => {
      const result = await request("deliveryPreviewPage", {
        token,
        offset: 9980,
      });
      assert.equal(result.value.items.length, 20);
      assert.equal(result.value.items.at(-1).rowIndex, 10000);
      return result;
    },
    300,
  );
  await measure(
    "10000-preview-filter",
    async () => {
      const result = await request("deliveryPreviewPage", {
        token,
        keyword: "fixture-9999",
      });
      assert.equal(result.value.count, 1);
      return result;
    },
    300,
  );
  const exported = await request("deliveryPreviewExport", token);
  assert.equal(exported.value.preview.rawRows.length, 10000);
  assert.equal(exported.value.identity.hash, fixture.fileHash);
  for (let i = 0; i < 35; i++) {
    const preview = await request(
      "deliveryPreviewStart",
      { path: join(fixture.files, "large.csv"), account, source: "generic" },
      true,
    );
    const committed = await request(
      "deliveryPreviewConfirm",
      preview.value.token,
      true,
    );
    assert.equal(committed.value.fills, 10000);
    if (i >= 5)
      results.push({
        name: "commit-sample",
        ms: committed.ms,
        bytes: committed.bytes,
      });
    await clearOwned();
  }
  const commits = results.filter((r) => r.name === "commit-sample"),
    sorted = commits.map((r) => r.ms).sort((a, b) => a - b);
  results.splice(
    results.findIndex((r) => r.name === "commit-sample"),
    commits.length,
    {
      name: "10000-confirm",
      n: 30,
      p50: sorted[14],
      p95: sorted[28],
      bytes: commits.at(-1).bytes,
      budget: 2000,
    },
  );
  writeFileSync(
    join(logs, "workspace-http-perf.json"),
    JSON.stringify(
      {
        build: readFileSync(".next/BUILD_ID", "utf8").trim(),
        node: process.version,
        cpu: cpus()[0]?.model,
        ram: totalmem(),
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results.at(-1)));
  for (const result of results)
    assert.ok(
      result.p95 <= result.budget,
      `${result.name}: ${result.p95} > ${result.budget}`,
    );
} finally {
  await clearOwned();
  const remove = db.prepare("DELETE FROM import_batches WHERE id=?");
  db.transaction(() => ids.forEach((id) => remove.run(id)))();
  assert.equal(
    hash(
      JSON.stringify(
        db.prepare("SELECT * FROM import_batches ORDER BY id").all(),
      ),
    ),
    fixture.hash,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM trade_fills").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM cash_flows").get().n, 0);
  db.close();
}
