import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "../../src/server/db/delivery-workspace-query";

let db: Database.Database;
let trace: string[] | undefined;
beforeEach(() => {
  trace = undefined;
  db = new Database(":memory:", { verbose: (sql) => trace?.push(String(sql)) });
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
  const latencies: number[] = [];
  const warmStatements: string[] = [];
  const started = performance.now();
  do {
    if (ids.length === 20) trace = warmStatements;
    const pageStart = performance.now();
    const page = deliveryBatchPage(db, { account: "万批完整性", cursor });
    latencies.push(performance.now() - pageStart);
    trace = undefined;
    expect(page.count).toBe(10000);
    expect(page.offset).toBe(ids.length);
    expect(page.items).toHaveLength(20);
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const elapsed = performance.now() - started;
  const p95 = latencies.sort((a, b) => a - b)[
    Math.ceil(latencies.length * 0.95) - 1
  ]!;
  console.log(
    `10000 batches / ${latencies.length} pages: total ${elapsed.toFixed(2)} ms, P95 ${p95.toFixed(2)} ms`,
  );
  expect(latencies).toHaveLength(500);
  expect(ids).toEqual(
    Array.from(
      { length: 10000 },
      (_, i) => `bulk-${String(9999 - i).padStart(5, "0")}`,
    ),
  );
  expect(db.pragma("user_version", { simple: true })).toBe(24);
  for (const sql of warmStatements) {
    const plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all() as {
      detail: string;
    }[];
    console.log(
      sql.trim().split("\n")[0],
      "\n" + (plan.map((row) => row.detail).join("\n") || "(no plan rows)"),
    );
    if (sql.includes("FROM import_batches b")) {
      expect(sql).toMatch(/WHERE b\.id IN \(/);
      expect(plan[0]?.detail).toContain(
        "sqlite_autoindex_delivery_batches_1 (id=?)",
      );
    }
  }
  expect(
    warmStatements.filter((sql) => sql.includes("FROM import_batches")),
  ).toHaveLength(1);
  expect(elapsed).toBeLessThanOrEqual(5000);
  expect(p95).toBeLessThanOrEqual(100);
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

function insertBatch(connection: Database.Database, id: string, name = id) {
  connection
    .prepare(
      "INSERT INTO import_batches VALUES (?, 'audit', 'ths', ?, ?, 99, '{}')",
    )
    .run(id, id, name);
}
const auditPage = (connection: Database.Database) =>
  deliveryBatchPage(connection, { account: "audit" });
const totalChanges = (connection: Database.Database) =>
  connection.prepare("SELECT total_changes()").pluck().get() as number;
const dataVersion = (connection: Database.Database) =>
  connection.pragma("main.data_version", { simple: true }) as number;

it("invalidates a warm memory index on view triggers, physical batch writes and both ownership views", () => {
  const empty = auditPage(db);
  const write = (action: () => void) => {
    const before = totalChanges(db);
    action();
    expect(totalChanges(db)).toBeGreaterThan(before);
    return auditPage(db);
  };
  const added = write(() => insertBatch(db, "batch"));
  expect(added.version).not.toBe(empty.version);
  expect(added.items).toMatchObject([
    { id: "batch", ownedFills: 0, ownedCashFlows: 0 },
  ]);
  const updated = write(() =>
    db.exec("UPDATE import_batches SET file_name='EDIT' WHERE id='batch'"),
  );
  expect(updated.items[0]?.fileName).toBe("EDIT");
  expect(deliveryBatchPage(db, { keyword: "edit" }).count).toBe(1);
  const direct = write(() =>
    db.exec(
      "UPDATE delivery_batches SET file_hash='direct',file_name='direct' WHERE id='batch'",
    ),
  );
  expect(direct.version).not.toBe(updated.version);
  expect(deliveryBatchPage(db, { keyword: "edit" }).count).toBe(0);
  const filled = write(() =>
    db.exec(
      "INSERT INTO trade_fills VALUES ('fill','audit','sh600000','600000','2024-03-01','batch','{}')",
    ),
  );
  expect(filled.items[0]?.ownedFills).toBe(1);
  const cash = write(() =>
    db.exec(
      "INSERT INTO cash_flows VALUES ('cash','audit','2024-03-01','batch','{}')",
    ),
  );
  expect(cash.items[0]).toMatchObject({ ownedFills: 1, ownedCashFlows: 1 });
  expect(cash.version).toBe(direct.version);
  const revoked = write(() =>
    db.exec("DELETE FROM import_batches WHERE id='batch'"),
  );
  expect(revoked).toEqual(empty);
});

it.each(["DELETE", "WAL"])(
  "observes external commits and same-count replacement in %s journal mode",
  (mode) => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-paging-"));
    const file = join(dir, "ledger.sqlite");
    let duringTokenRead: (() => void) | undefined;
    const reader = new Database(file, {
      verbose: (sql) => {
        if (/^PRAGMA main\.data_version/i.test(String(sql))) {
          const write = duringTokenRead;
          duringTokenRead = undefined;
          write?.();
        }
      },
    });
    const writer = new Database(file);
    try {
      expect(reader.pragma("journal_mode = " + mode, { simple: true })).toBe(
        mode.toLowerCase(),
      );
      migrate(reader);
      const changes = totalChanges(reader);
      const write = (action: () => void) => {
        const before = dataVersion(reader);
        action();
        expect(dataVersion(reader)).toBeGreaterThan(before);
        expect(totalChanges(reader)).toBe(changes);
        return auditPage(reader);
      };
      const empty = auditPage(reader);
      const added = write(() => insertBatch(writer, "old"));
      expect(added.version).not.toBe(empty.version);
      expect(added.items.map((item) => item.id)).toEqual(["old"]);
      const direct = write(() =>
        writer.exec(
          "UPDATE delivery_batches SET imported_at=100 WHERE id='old'",
        ),
      );
      expect(direct.version).not.toBe(added.version);
      const filled = write(() =>
        writer.exec(
          "INSERT INTO trade_fills VALUES ('f','audit',NULL,'600000','2024-03-01','old','{}')",
        ),
      );
      expect(filled.items[0]?.ownedFills).toBe(1);
      const cash = write(() =>
        writer.exec(
          "INSERT INTO cash_flows VALUES ('c','audit','2024-03-01','old','{}')",
        ),
      );
      expect(cash.items[0]?.ownedCashFlows).toBe(1);
      const replacement = write(
        writer.transaction(() => {
          writer.exec("DELETE FROM import_batches WHERE id='old'");
          insertBatch(writer, "new");
        }),
      );
      expect(replacement.count).toBe(cash.count);
      expect(replacement.items.map((item) => item.id)).toEqual(["new"]);
      expect(replacement.version).not.toBe(cash.version);
      expect(deliveryAccountVersion(reader, "audit")).toBe(replacement.version);
      expect(() =>
        deliveryBatchPage(reader, { account: "audit", version: cash.version }),
      ).toThrow("批次已变化");
      if (mode === "WAL") {
        // Commit between pinning the read snapshot and reading its data_version.
        duringTokenRead = () => insertBatch(writer, "concurrent");
        expect(auditPage(reader)).toEqual(replacement);
        expect(auditPage(reader).items.map((item) => item.id)).toEqual([
          "new",
          "concurrent",
        ]);
      }
      expect(reader.pragma("user_version", { simple: true })).toBe(24);
    } finally {
      writer.close();
      reader.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it("never publishes outer transaction or savepoint rows on rollback even when total_changes is unchanged", () => {
  const committed = auditPage(db);
  db.exec("BEGIN");
  insertBatch(db, "outer");
  const outer = auditPage(db);
  expect(outer.items.map((row) => row.id)).toEqual(["outer"]);
  db.exec("SAVEPOINT nested");
  insertBatch(db, "inner");
  expect(auditPage(db).count).toBe(2);
  const changes = totalChanges(db);
  db.exec("ROLLBACK TO nested");
  expect(totalChanges(db)).toBe(changes);
  expect(auditPage(db)).toEqual(outer);
  expect(deliveryAccountVersion(db, "audit")).toBe(outer.version);
  db.exec("ROLLBACK");
  expect(totalChanges(db)).toBe(changes);
  expect(auditPage(db)).toEqual(committed);
  expect(deliveryAccountVersion(db, "audit")).toBe(committed.version);
});

it("matches SQLite literal substring filters, binary id ordering and the original SHA-256 input", () => {
  insertBatch(db, "😀", "MiX_中%Ä.csv");
  insertBatch(db, "\uE000", "mix中文ä.csv");
  insertBatch(db, "甲", "MiX%中.csv");
  for (const keyword of ["", "%", "_", "mIx", "_中%", "中文", "ä", "Ä"]) {
    const expected = db
      .prepare(
        `SELECT id FROM import_batches WHERE account='audit'
      AND instr(lower(file_name), lower(?))>0 ORDER BY imported_at DESC,id DESC`,
      )
      .pluck()
      .all(keyword);
    const actual = deliveryBatchPage(db, { account: "audit", keyword });
    expect(actual.count).toBe(expected.length);
    expect(actual.items.map((row) => row.id)).toEqual(expected);
  }
  for (const account of [undefined, "audit", "", "missing"]) {
    const identities = db
      .prepare(
        `SELECT id,file_hash,imported_at FROM import_batches
      WHERE (? IS NULL OR account=?) ORDER BY id`,
      )
      .all(account ?? null, account ?? null);
    expect(deliveryAccountVersion(db, account)).toBe(
      createHash("sha256").update(JSON.stringify(identities)).digest("hex"),
    );
  }
});

it("matches bound lone surrogates in account versions and filename searches", () => {
  insertBatch(db, "replacement", "mix\uFFFD.csv");
  db.prepare("UPDATE import_batches SET account=? WHERE id='replacement'").run(
    "acct\uFFFD",
  );
  const expected = deliveryBatchPage(db, {
    account: "acct\uFFFD",
    keyword: "X\uFFFD",
  });
  expect(expected.items.map((row) => row.id)).toEqual(["replacement"]);
  for (const surrogate of ["\uD800", "\uDC00"]) {
    const account = "acct" + surrogate;
    const boundVersion = db.transaction(() =>
      deliveryAccountVersion(db, account),
    )();
    expect(deliveryAccountVersion(db, account)).toBe(boundVersion);
    expect(
      deliveryBatchPage(db, { account, keyword: "X" + surrogate }),
    ).toEqual(expected);
  }
});

it.each([
  ["NULL id", null, 100, 101, 1],
  ["text timestamp", "odd", "later", "zzz", 1],
  [
    "unsafe integer timestamp",
    "odd",
    9007199254740993n,
    9007199254740994n,
    9007199254740992n,
  ],
] as const)(
  "pages across a %s boundary in SQLite order",
  (_, id, at, before, after) => {
    const insert = db.prepare(
      "INSERT INTO import_batches VALUES (?, 'audit', 'ths', ?, ?, ?, '{}')",
    );
    for (let i = 0; i < 19; i++) {
      insert.run(`first-${i}`, `first-${i}`, "match", before);
    }
    insert.run(id, "odd", "match", at);
    insert.run("z-last", "z-last", "match", after);
    const expected = db
      .prepare(
        "SELECT id FROM import_batches WHERE account='audit' ORDER BY imported_at DESC, id DESC",
      )
      .pluck()
      .all();
    const first = auditPage(db);
    expect(first.items.map((row) => row.id)).toEqual(expected.slice(0, 20));
    expect(first.count).toBe(21);
    expect(first.nextCursor).toBeTruthy();
    const second = deliveryBatchPage(db, {
      account: "audit",
      cursor: first.nextCursor,
    });
    expect(second.items.map((row) => row.id)).toEqual(expected.slice(20));
    expect(second).toMatchObject({ count: 21, offset: 20, nextCursor: null });
    const bounded = deliveryBatchPage(db, {
      account: "audit",
      keyword: "MATCH",
      to: 100,
    });
    expect(bounded.items.map((row) => row.id)).toEqual(
      db
        .prepare(
          "SELECT id FROM import_batches WHERE account='audit' AND imported_at<=100 ORDER BY imported_at DESC,id DESC",
        )
        .pluck()
        .all(),
    );
  },
);
