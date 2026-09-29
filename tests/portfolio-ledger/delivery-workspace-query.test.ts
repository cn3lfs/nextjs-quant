import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, it } from "vitest";
import { migrate } from "../../src/server/db/migrations";
import {
  deliveryAccountVersion,
  deliveryBatchPage,
  deliveryBatchReceipt,
  deliveryBatchDetail,
  deliveryEvidencePage,
  deliveryBatchExport,
  deliveryRevokeChecked,
} from "../../src/server/portfolio/delivery-workspace-query";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  const insert = db.prepare(
    "INSERT INTO import_batches VALUES (?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < 65; i++)
    insert.run(
      `id-${String(i).padStart(3, "0")}`,
      i % 2 ? "甲" : "乙",
      "generic",
      `hash-${i}`,
      `${i}%合成.csv`,
      Math.floor(i / 3),
      JSON.stringify({
        rawRows: [["large evidence".repeat(1000)]],
        statistics: { fills: 10, cashFlows: 1, unresolved: 0, anomalies: 0 },
      }),
    );
});
afterEach(() => db.close());
it("traverses ten thousand batches without gaps or duplicates", () => {
  const insert = db.prepare(
    "INSERT INTO import_batches VALUES (?,?,?,?,?,?,?)",
  );
  db.transaction(() => {
    for (let i = 0; i < 10000; i++) {
      const id = `bulk-${String(i).padStart(5, "0")}`;
      insert.run(
        id,
        "万批完整性",
        "generic",
        id,
        `${id}.csv`,
        Math.floor(i / 3),
        JSON.stringify({
          statistics: { fills: 0, cashFlows: 0, unresolved: 0, anomalies: 0 },
          rawRows: [["evidence"]],
        }),
      );
    }
  })();
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const page = deliveryBatchPage(db, { account: "万批完整性", cursor });
    expect(page.count).toBe(10000);
    expect(page.offset).toBe(ids.length);
    expect(page.items).toHaveLength(20);
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(ids).toEqual(
    Array.from(
      { length: 10000 },
      (_, i) => `bulk-${String(9999 - i).padStart(5, "0")}`,
    ),
  );
}, 30000);
it("preserves an offset after revoke and clamps an emptied last page", () => {
  const first = deliveryBatchPage(db, {});
  const middle = deliveryBatchPage(db, { offset: 20, version: first.version });
  expect(middle.count).toBe(65);
  expect(middle.offset).toBe(20);
  expect(middle.items[0]?.id).toBe("id-044");
  deliveryRevokeChecked(db, deliveryBatchDetail(db, middle.items[0]!.id)!);
  expect(() =>
    deliveryBatchPage(db, { offset: 20, version: first.version }),
  ).toThrow("批次已变化");
  const refreshed = deliveryBatchPage(db, { offset: 20 });
  expect(refreshed.offset).toBe(20);
  expect(refreshed.items[0]?.id).toBe("id-043");
  const last = deliveryBatchPage(db, { offset: 60 });
  for (const item of last.items)
    deliveryRevokeChecked(db, deliveryBatchDetail(db, item.id)!);
  const clamped = deliveryBatchPage(db, { offset: 60 });
  expect(clamped.count).toBe(60);
  expect(clamped.offset).toBe(40);
  expect(clamped.items).toHaveLength(20);
  const empty = deliveryBatchPage(db, { account: "不存在", offset: 60 });
  expect(empty.offset).toBe(0);
  expect(empty.count).toBe(0);
  expect(empty.items).toEqual([]);
});
it("reads every evidence row by page and exports full evidence consistently", () => {
  const rawRows = Array.from({ length: 1001 }, (_, i) => [
    `row-${i}`,
    "脱敏证据",
  ]);
  const payload = {
    rawRows,
    diagnostics: ["缺失费用"],
    unresolved: [{ rowIndex: 1001, reason: "待核对", cells: ["末行"] }],
    mapping: {},
    statistics: { fills: 0, cashFlows: 0, unresolved: 1, anomalies: 0 },
  };
  db.prepare("UPDATE import_batches SET payload=? WHERE id='id-000'").run(
    JSON.stringify(payload),
  );
  const detail = deliveryBatchDetail(db, "id-000")!;
  expect(detail.rawRowCount).toBe(1001);
  expect(detail.counts).toBeNull();
  expect(detail.sourceHeader).toBeNull();
  expect(detail.statementOpeningCash).toBeNull();
  expect(JSON.stringify(detail)).not.toContain("row-1000");
  const all: unknown[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: NonNullable<ReturnType<typeof deliveryEvidencePage>> =
      deliveryEvidencePage(db, {
        id: "id-000",
        section: "rawRows",
        offset,
      })!;
    all.push(...page.items.map((row) => row.value));
    offset = page.nextOffset;
  }
  expect(all).toEqual(rawRows);
  expect(
    deliveryEvidencePage(db, { id: "id-000", section: "diagnostics" })?.items[0]
      ?.value,
  ).toBe("缺失费用");
  expect(
    deliveryEvidencePage(db, { id: "id-000", section: "unresolved" })?.items[0]
      ?.value,
  ).toEqual(payload.unresolved[0]);
  const exported = deliveryBatchExport(db, "id-000")!;
  expect(exported.evidence).toEqual(payload);
  expect(exported.fills).toEqual([]);
  expect(deliveryBatchDetail(db, "missing")).toBeNull();
  expect(
    deliveryEvidencePage(db, { id: "missing", section: "rawRows" }),
  ).toBeNull();
  expect(deliveryBatchExport(db, "missing")).toBeNull();
});
it("rechecks revoke impact and preserves data when confirmation is stale", () => {
  const frozen = deliveryBatchDetail(db, "id-000")!;
  db.prepare("INSERT INTO trade_fills VALUES (?,?,?,?,?,?,?)").run(
    "owned",
    "乙",
    "sh600000",
    "600000",
    "2024-03-01",
    "id-000",
    "{}",
  );
  expect(() => deliveryRevokeChecked(db, frozen)).toThrow("影响已变化");
  expect(deliveryBatchDetail(db, "id-000")?.ownedFills).toBe(1);
  const refreshed = deliveryBatchDetail(db, "id-000")!;
  expect(() =>
    deliveryRevokeChecked(db, { ...refreshed, account: "甲" }),
  ).toThrow("影响已变化");
  expect(deliveryRevokeChecked(db, refreshed)).toEqual({
    fills: 1,
    cashFlows: 0,
    batches: 1,
  });
  expect(deliveryRevokeChecked(db, refreshed)).toEqual({
    fills: 0,
    cashFlows: 0,
    batches: 0,
  });
  expect(deliveryBatchDetail(db, "id-001")).not.toBeNull();
});
it("traverses all batches with tied times, returning only 20 summaries", () => {
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const page = deliveryBatchPage(db, { cursor });
    expect(page.items.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(page)).not.toContain("large evidence");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(65536);
    ids.push(...page.items.map((row) => row.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(ids).toHaveLength(65);
  expect(new Set(ids).size).toBe(65);
  expect(ids[0]).toBe("id-064");
  expect(ids.at(-1)).toBe("id-000");
});
it("filters literal file names, accounts and time bounds; rejects reused cursors", () => {
  const page = deliveryBatchPage(db, { account: "甲" });
  expect(page.items.every((r) => r.account === "甲")).toBe(true);
  expect(() =>
    deliveryBatchPage(db, { account: "乙", cursor: page.nextCursor! }),
  ).toThrow("筛选已变化");
  expect(
    deliveryBatchPage(db, { keyword: "64%", from: 21, to: 21 }).items.map(
      (r) => r.id,
    ),
  ).toEqual(["id-064"]);
  expect(() => deliveryBatchPage(db, { cursor: "broken" })).toThrow(
    "分页位置无效",
  );
});
it("invalidates same-count replacement but isolates other accounts", () => {
  const page = deliveryBatchPage(db, { account: "甲" }),
    version = deliveryAccountVersion(db, "甲");
  db.prepare(
    "UPDATE import_batches SET id='replacement' WHERE id='id-000'",
  ).run();
  expect(deliveryAccountVersion(db, "甲")).toBe(version);
  db.prepare(
    "UPDATE import_batches SET id='replacement-own' WHERE id='id-001'",
  ).run();
  expect(() =>
    deliveryBatchPage(db, { account: "甲", cursor: page.nextCursor! }),
  ).toThrow("批次已变化");
});
it("separates recognized counts from actual ownership and looks up receipts without files", () => {
  db.prepare("INSERT INTO trade_fills VALUES (?,?,?,?,?,?,?)").run(
    "fill",
    "乙",
    "sh600000",
    "600000",
    "2024-03-01",
    "id-000",
    "{}",
  );
  const receipt = deliveryBatchReceipt(db, "乙", "hash-0");
  expect(receipt).toMatchObject({
    scope: "all",
    ownedFills: 1,
    ownedCashFlows: 0,
    statistics: { fills: 10 },
  });
  expect(deliveryBatchReceipt(db, "甲", "hash-0")).toBeNull();
  db.prepare("DELETE FROM trade_fills WHERE batch_id='id-000'").run();
  db.prepare("DELETE FROM import_batches WHERE id='id-000'").run();
  expect(deliveryBatchReceipt(db, "乙", "hash-0")).toBeNull();
});
