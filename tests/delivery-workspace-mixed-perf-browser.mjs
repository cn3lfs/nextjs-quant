import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const logs = join(tmpdir(), "logs/quant-delivery-import"),
  base = "http://127.0.0.1:3228";
const fixture = JSON.parse(readFileSync(join(logs, "fixture.json"), "utf8"));
const db = new Database(join(fixture.directory, "quant.sqlite"), {
  readonly: true,
});
const files = [],
  accounts = [],
  results = [];
async function api(name, input, mutation = false) {
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
  const text = await response.text();
  assert.equal(response.status, 200, text.slice(0, 500));
  return JSON.parse(text).result.data.json;
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const count of [1000, 10000]) {
    const account = `混合性能-${count}`;
    accounts.push(account);
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM import_batches WHERE account=?")
        .get(account).n,
      0,
    );
    const path = join(fixture.files, `mixed-${count}.csv`);
    assert.equal(existsSync(path), false);
    files.push(path);
    const header =
      "成交日期,证券代码,操作,成交价格,成交数量,成交金额,发生金额,成交编号";
    const rows = Array.from(
      { length: count - 2 },
      (_, i) => `20240301,600000,买入,10,100,1000,-1000,mixed-${i}`,
    );
    writeFileSync(path, [header, ...rows].join("\n"));
    let preview = await api(
      "deliveryPreviewStart",
      { path, account, source: "generic" },
      true,
    );
    await api("deliveryPreviewConfirm", preview.token, true);
    rows[rows.length - 1] = rows.at(-1).replace(",1000,-1000,", ",1001,-1000,");
    writeFileSync(
      path,
      [
        header,
        ...rows,
        "20240301,,银行转存,0,0,0,1000,cash-last",
        "20240301,600000,未知业务,0,0,0,0,unresolved-last",
      ].join("\n"),
    );
    preview = await api(
      "deliveryPreviewStart",
      { path, account, source: "generic" },
      true,
    );
    assert.equal(preview.summary.conflict, 1);
    assert.equal(preview.summary.duplicate, count - 3);
    assert.equal(preview.summary.unresolved, 1);
    assert.equal(preview.summary.new, 1);
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/trade-review`);
    await page
      .getByLabel("交割单目录（只读）", { exact: true })
      .fill(fixture.files);
    await page
      .getByLabel("文件名关键词", { exact: true })
      .fill(`mixed-${count}.csv`);
    await page.getByRole("button", { name: "检索文件", exact: true }).click();
    await page.getByRole("button", { name: "选择文件", exact: true }).click();
    await page.getByLabel("账户别名", { exact: true }).fill(account);
    await page.getByRole("button", { name: "预览并核对", exact: true }).click();
    await page
      .getByRole("button", { name: `核对第 ${count - 2} 行`, exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: `确认导入到 ${account}`, exact: true })
        .isDisabled(),
      true,
    );
    async function select(text) {
      await page
        .getByRole("combobox", { name: "核对状态", exact: true })
        .click();
      await page.getByRole("option", { name: text, exact: true }).click();
    }
    const samples = { filter: [], page: [], return: [] };
    for (let i = 0; i < 35; i++) {
      let start = performance.now();
      await select("待核对");
      await page
        .getByRole("button", { name: `核对第 ${count} 行`, exact: true })
        .waitFor();
      if (i >= 5) samples.filter.push(performance.now() - start);
      await select("全部");
      await page
        .getByRole("button", { name: "核对第 20 行", exact: true })
        .waitFor();
      start = performance.now();
      await page
        .getByRole("button", { name: "下一页核对", exact: true })
        .click();
      await page
        .getByRole("button", { name: "核对第 40 行", exact: true })
        .waitFor();
      if (i >= 5) samples.page.push(performance.now() - start);
      await page
        .getByRole("button", { name: "核对第 21 行", exact: true })
        .click();
      await page.getByLabel("单行证据", { exact: true }).waitFor();
      start = performance.now();
      await page
        .getByRole("button", { name: "返回核对列表", exact: true })
        .click();
      await page.waitForFunction(
        () => document.activeElement?.textContent === "核对第 21 行",
      );
      if (i >= 5) samples.return.push(performance.now() - start);
    }
    assert.deepEqual(errors, []);
    const stats = Object.fromEntries(
      Object.entries(samples).map(([key, values]) => {
        values.sort((a, b) => a - b);
        return [key, { n: values.length, p50: values[14], p95: values[28] }];
      }),
    );
    results.push({ count, stats, errors });
    console.log(JSON.stringify(results.at(-1)));
    await page.close();
  }
  writeFileSync(
    join(logs, "workspace-mixed-perf-browser.json"),
    JSON.stringify(
      { build: readFileSync(".next/BUILD_ID", "utf8").trim(), results },
      null,
      2,
    ),
  );
  for (const result of results)
    for (const value of Object.values(result.stats))
      assert.ok(value.p95 <= 300, JSON.stringify(result));
} finally {
  await browser.close();
  for (const account of accounts)
    for (const row of db
      .prepare("SELECT id FROM import_batches WHERE account=?")
      .all(account))
      await api(
        "deliveryRevokeChecked",
        await api("deliveryBatchDetail", row.id),
        true,
      );
  for (const file of files) if (existsSync(file)) unlinkSync(file);
  assert.equal(
    createHash("sha256")
      .update(
        JSON.stringify(
          db.prepare("SELECT * FROM import_batches ORDER BY id").all(),
        ),
      )
      .digest("hex"),
    fixture.hash,
  );
  db.close();
}
