import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it } from "vitest";
import { migrate } from "../../src/server/db/migrations";
import { DeliveryPreviewWorkspace } from "../../src/server/portfolio/delivery-preview-workspace";
import { commitDeliveryImport } from "../../src/server/portfolio/delivery-import-service";

let db: Database.Database,
  directory: string,
  workspace: DeliveryPreviewWorkspace;
const csv = (count: number) =>
  Buffer.from(
    [
      "成交日期,证券代码,操作,成交价格,成交数量,成交金额,发生金额,成交编号",
      ...Array.from(
        { length: count },
        (_, i) => `20240301,600000,买入,10,100,1000,-1000,row-${i}`,
      ),
    ].join("\n"),
  );
const options = () => ({
  path: join(directory, "synthetic.csv"),
  account: "合成账户",
  source: "generic" as const,
});
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  directory = mkdtempSync(join(tmpdir(), "quant-delivery-preview-"));
  writeFileSync(options().path, csv(45));
  workspace = new DeliveryPreviewWorkspace();
});
afterEach(() => {
  workspace.dispose();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
it("returns a bounded summary and complete paged evidence without writing facts", async () => {
  const preview = await workspace.start(db, options());
  expect(preview.summary.new).toBe(45);
  expect(preview).not.toHaveProperty("parsed");
  const all = [];
  for (const offset of [0, 20, 40])
    all.push(
      ...(await workspace.page(db, { token: preview.token, offset })).items,
    );
  expect(all).toHaveLength(45);
  expect(all.at(-1)?.rowIndex).toBe(45);
  expect(
    (await workspace.export(db, preview.token)).preview.rawRows,
  ).toHaveLength(45);
  expect(db.prepare("SELECT count(*) n FROM import_batches").get()).toEqual({
    n: 0,
  });
});
it("confirms a frozen identity and retries after source deletion without duplicate writes", async () => {
  const preview = await workspace.start(db, options());
  const saved = await workspace.confirm(db, preview.token);
  expect(saved.fills).toBe(45);
  const payload = JSON.parse(
    (
      db
        .prepare("SELECT payload FROM import_batches WHERE id=?")
        .get(saved.batchId) as { payload: string }
    ).payload,
  );
  expect(payload.receipt).toEqual({ fills: 45, cashFlows: 0, duplicate: 0 });
  unlinkSync(options().path);
  expect(await workspace.confirm(db, preview.token)).toMatchObject({
    batchId: saved.batchId,
    alreadyImported: true,
    fills: 0,
  });
  expect(db.prepare("SELECT count(*) n FROM import_batches").get()).toEqual({
    n: 1,
  });
});
it("rejects changed bytes and stale account facts before any new batch", async () => {
  const preview = await workspace.start(db, options());
  writeFileSync(options().path, csv(46));
  await expect(workspace.confirm(db, preview.token)).rejects.toThrow(
    "文件已改变",
  );
  writeFileSync(options().path, csv(45));
  commitDeliveryImport(csv(1), { account: "合成账户", source: "generic" }, db);
  await expect(workspace.confirm(db, preview.token)).rejects.toThrow(
    "账户批次已变化",
  );
  expect(db.prepare("SELECT count(*) n FROM import_batches").get()).toEqual({
    n: 1,
  });
});
it("expires and evicts previews; oversized previews remain fully readable via reparse", async () => {
  workspace.dispose();
  let now = 0;
  workspace = new DeliveryPreviewWorkspace(
    { count: 1, bytes: 1, ttl: 100 },
    () => now,
  );
  const first = await workspace.start(db, options());
  expect(first.cached).toBe(false);
  expect(workspace.stats()).toEqual({ count: 1, bytes: 0 });
  expect(
    (await workspace.page(db, { token: first.token, offset: 40 })).items,
  ).toHaveLength(5);
  expect(
    (await workspace.export(db, first.token)).preview.parsed.fills,
  ).toHaveLength(45);
  const second = await workspace.start(db, options());
  await expect(workspace.confirm(db, first.token)).rejects.toThrow(
    "预览已过期",
  );
  now = 101;
  await expect(workspace.confirm(db, second.token)).rejects.toThrow(
    "预览已过期",
  );
  expect(workspace.stats().count).toBe(0);
});
it("does not call an existing batch success under a different source or scope", async () => {
  const original = await workspace.start(db, options());
  const other = await workspace.start(db, { ...options(), source: "tdx" });
  const cash = await workspace.start(db, {
    ...options(),
    scope: "cashFlowsOnly",
  });
  await workspace.confirm(db, original.token);
  await expect(workspace.confirm(db, other.token)).rejects.toThrow(
    "不同来源或范围",
  );
  await expect(workspace.confirm(db, cash.token)).rejects.toThrow(
    "不同来源或范围",
  );
});
it("finds conflicts and unresolved rows beyond the first page and blocks the whole conflicting batch", async () => {
  commitDeliveryImport(csv(45), { account: "合成账户", source: "generic" }, db);
  const conflicting = csv(45)
    .toString()
    .replace(
      "20240301,600000,买入,10,100,1000,-1000,row-44",
      "20240301,600000,买入,10,100,1001,-1000,row-44",
    );
  writeFileSync(options().path, conflicting);
  const preview = await workspace.start(db, options());
  expect(preview.summary.conflict).toBe(1);
  const conflicts = await workspace.page(db, {
    token: preview.token,
    status: "conflict",
  });
  expect(conflicts.items).toHaveLength(1);
  expect(conflicts.items[0]?.rowIndex).toBe(45);
  expect(conflicts.items[0]?.differences).toContain("amount");
  await expect(workspace.confirm(db, preview.token)).rejects.toThrow(
    "交易编号已用于不同内容",
  );
  expect(db.prepare("SELECT count(*) n FROM import_batches").get()).toEqual({
    n: 1,
  });
  expect(db.prepare("SELECT count(*) n FROM trade_fills").get()).toEqual({
    n: 45,
  });
  writeFileSync(
    options().path,
    csv(45).toString() + "\n20240301,600000,未知业务,0,0,0,0,unresolved-last",
  );
  const pending = await workspace.start(db, options());
  expect(pending.summary.unresolved).toBe(1);
  const unresolved = await workspace.page(db, {
    token: pending.token,
    status: "unresolved",
  });
  expect(unresolved.items[0]?.rowIndex).toBe(46);
  expect(
    (await workspace.export(db, pending.token)).preview.rawRows,
  ).toHaveLength(46);
});
