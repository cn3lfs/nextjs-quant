import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { parseDeliveryTable } from "../../src/lib/research/evidence/delivery-table";
import { afterEach, expect, it } from "vitest";
import { migrate, migrations } from "../../src/server/db/migrations";
import {
  DeliveryStore,
  deliveryRowId,
} from "../../src/server/db/delivery-store";
import {
  commitDeliveryImport,
  previewDeliveryImport,
} from "../../src/server/portfolio/delivery-import-service";
import { buildLegacyCleanupManifest } from "../../scripts/legacy-paper-cleanup";

const connections: Database.Database[] = [];
function database(migrated = true) {
  const db = new Database(":memory:");
  connections.push(db);
  db.pragma("foreign_keys = ON");
  if (migrated) migrate(db);
  return db;
}
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
});
const fixture = (name: string) =>
  readFileSync(`tests/fixtures/delivery/${name}`);
const options = {
  account: "主账户",
  source: "generic",
  fileName: "交割单.csv",
};
const tables = ["import_batches", "trade_fills", "cash_flows"] as const;
const counts = (db: Database.Database) =>
  tables.map(
    (table) =>
      (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n,
  );

it("R5b: overlapping settlement/history rows with different fee evidence conflict in either import order", () => {
  const samples = ["ths-settlement.txt", "ths-history.txt"].map((name) => {
    const table = parseDeliveryTable(fixture(name));
    const row = table.rows.find((row) => row[0] === "20240301")!;
    return Buffer.from([table.header.join("\t"), row.join("\t")].join("\n"));
  });
  for (const bytes of [samples, [...samples].reverse()]) {
    const db = database(),
      store = new DeliveryStore(db);
    const first = previewDeliveryImport(bytes[0]!, options, db);
    const second = previewDeliveryImport(bytes[1]!, options, db);
    expect(first.parsed.fills).toHaveLength(1);
    expect(second.parsed.fills).toHaveLength(1);
    expect(first.parsed.fills[0]!.fingerprintSource).toBe(
      second.parsed.fills[0]!.fingerprintSource,
    );
    commitDeliveryImport(bytes[0]!, options, db);
    const saved = store.fills();
    expect(previewDeliveryImport(bytes[1]!, options, db).summary).toMatchObject(
      { new: 0, duplicate: 0, conflict: 1 },
    );
    expect(() => commitDeliveryImport(bytes[1]!, options, db)).toThrow(/fees/);
    expect(counts(db)).toEqual([1, 1, 0]);
    expect(store.fills()).toEqual(saved);
  }
});

it("R5b: source-specific fields differ without conflict, core net amount still conflicts", () => {
  const db = database(),
    store = new DeliveryStore(db);
  const input = previewDeliveryImport(
    fixture("ths-statement.html"),
    options,
    db,
  );
  store.commitImport({ ...input, importedAt: 1 });
  const saved = store.fills();
  const changed = structuredClone(input);
  changed.parsed.fills[0]!.rowIndex = 100;
  changed.parsed.fills[0]!.dealId = "other";
  changed.parsed.fills[0]!.orderId = null;
  changed.parsed.fills[0]!.balanceCash = null;
  changed.parsed.fills[0]!.summary = "另一个导出";
  changed.parsed.cashFlows[0]!.balanceCash = 123;
  changed.parsed.cashFlows[0]!.rowIndex = 101;
  expect(
    store.inspect(options.account, changed.parsed).map((row) => row.status),
  ).toEqual(Array(4).fill("duplicate"));
  expect(
    store.commitImport({
      ...changed,
      fileHash: "source-fields",
      importedAt: 2,
    }),
  ).toMatchObject({ duplicate: 4, fills: 0, cashFlows: 0 });
  expect(store.fills()).toEqual(saved);
  changed.parsed.fills[0]!.netAmount! += 1;
  expect(() =>
    store.commitImport({ ...changed, fileHash: "net-conflict", importedAt: 3 }),
  ).toThrow(/netAmount/);
  expect(counts(db)).toEqual([2, 3, 1]);
});

it("R5b: same-day zero deal ids with different cash amounts import independently", () => {
  const db = database();
  const bytes = Buffer.from(
    "成交日期,证券代码,操作,成交价格,成交数量,发生金额,成交编号,合同编号\n20250110,300398,股息红利扣税,0,0,-21,0,0\n20250110,300398,股息红利扣税,0,0,-3.60,0,0",
  );
  expect(commitDeliveryImport(bytes, options, db)).toMatchObject({
    cashFlows: 2,
    duplicate: 0,
  });
  expect(counts(db)).toEqual([1, 0, 2]);
});

it("R5b: fixture net settlement differences remain conflicts and roll back every table", () => {
  const db = database();
  commitDeliveryImport(fixture("ths-settlement.txt"), options, db);
  const preview = previewDeliveryImport(
    fixture("ths-history.txt"),
    options,
    db,
  );
  expect(preview.summary).toMatchObject({ duplicate: 0, conflict: 6 });
  expect(
    preview.rows.filter((row) => row.differences.includes("fees")),
  ).toHaveLength(6);
  expect(
    preview.rows
      .filter((row) => row.differences.includes("netAmount"))
      .map((row) => row.differences),
  ).toEqual([
    ["fees", "netAmount"],
    ["fees", "netAmount"],
  ]);
  const before = counts(db);
  expect(() =>
    commitDeliveryImport(fixture("ths-history.txt"), options, db),
  ).toThrow(/netAmount/);
  expect(counts(db)).toEqual(before);
  expect(counts(db)).toEqual([1, 10, 0]);
});
const samples = [
  ["ths-statement.html", 3, 1],
  ["eastmoney-statement.csv", 3, 5],
  ["tdx-statement.txt", 3, 0],
] as const;
for (const [name, fills, cashFlows] of samples) {
  it(`${name}: first import and same-file idempotency`, () => {
    const db = database(),
      store = new DeliveryStore(db),
      bytes = fixture(name);
    const preview = previewDeliveryImport(bytes, options, db);
    expect(counts(db)).toEqual([0, 0, 0]);
    expect(preview.summary).toMatchObject({
      new: fills + cashFlows,
      duplicate: 0,
      conflict: 0,
      unresolved: 0,
    });
    const first = commitDeliveryImport(bytes, options, db);
    expect(first).toEqual({
      batchId: expect.any(String),
      alreadyImported: false,
      fills,
      cashFlows,
      duplicate: 0,
    });
    const repeat = commitDeliveryImport(bytes, options, db);
    expect(repeat).toEqual({
      ...first,
      alreadyImported: true,
      fills: 0,
      cashFlows: 0,
    });
    expect(counts(db)).toEqual([1, fills, cashFlows]);
    expect(store.fills(options.account)).toHaveLength(fills);
    expect(store.cashFlows(options.account)).toHaveLength(cashFlows);
    expect(store.fills("其他")).toEqual([]);
    expect(store.cashFlows("其他")).toEqual([]);
    expect(previewDeliveryImport(bytes, options, db).summary).toMatchObject({
      new: 0,
      duplicate: fills + cashFlows,
      conflict: 0,
    });
    expect(store.batches()[0]!.payload.statistics).toMatchObject({
      fills,
      cashFlows,
      unresolved: 0,
    });
  });
}

it("same fingerprint with changed core amount rejects the whole batch and reports id and fields", () => {
  const db = database(),
    store = new DeliveryStore(db),
    bytes = fixture("ths-statement.html");
  commitDeliveryImport(bytes, options, db);
  const input = previewDeliveryImport(bytes, options, db);
  // R5b 起指纹本身含价格与数量，改价会直接变成另一笔。要制造「同指纹异内容」，
  // 得保持指纹不变而改核心金额——这正是同一笔成交在两份导出里金额矛盾的情形。
  const changed = structuredClone(input.parsed.fills[0]!);
  changed.amount += 1;
  input.parsed.fills = [{ ...changed, fingerprintSource: "new-fill" }, changed];
  input.parsed.cashFlows[0]!.fingerprintSource = "new-cash";
  const before = tables.map((table) =>
    db.prepare(`SELECT * FROM ${table}`).all(),
  );
  expect(() =>
    store.commitImport({ ...input, fileHash: "changed", importedAt: 1 }),
  ).toThrow(
    new RegExp(
      `${deliveryRowId(options.account, changed.fingerprintSource)}.*amount`,
    ),
  );
  expect(counts(db)).toEqual([1, 3, 1]);
  expect(
    tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
  ).toEqual(before);
  // 同理：改价格会得到另一笔成交。改成交金额才保持指纹不变而制造内容矛盾。
  const changedBytes = Buffer.from(
    bytes.toString().replace("150000.00", "150001.00"),
  );
  // 1 元差异落在异常检测的万分之一容差内（anomalies 为 0），但冲突判定是精确比较，
  // 仍然识别为同一笔成交的内容矛盾。两者口径不同是有意为之。
  expect(
    previewDeliveryImport(changedBytes, options, db).summary,
  ).toMatchObject({ new: 0, duplicate: 3, conflict: 1, anomalies: 0 });
  expect(() => commitDeliveryImport(changedBytes, options, db)).toThrow(
    "交易编号已用于不同内容",
  );
  expect(counts(db)).toEqual([1, 3, 1]);
});

it("a late SQL failure rolls back already inserted batch, fills and cash flows", () => {
  const db = database();
  db.exec(
    "CREATE TRIGGER fail_cash BEFORE INSERT ON cash_flows_claims BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
  );
  expect(() =>
    commitDeliveryImport(fixture("ths-statement.html"), options, db),
  ).toThrow("injected failure");
  expect(counts(db)).toEqual([0, 0, 0]);
});

it("revoke removes only owned rows; repeated revoke is zero; reimport works", () => {
  const db = database(),
    store = new DeliveryStore(db);
  const first = commitDeliveryImport(
    fixture("ths-statement.html"),
    options,
    db,
  );
  const second = commitDeliveryImport(
    fixture("eastmoney-statement.csv"),
    options,
    db,
  );
  const retained = {
    fills: store.fills().filter((r) => r.batchId === second.batchId),
    cash: store.cashFlows().filter((r) => r.batchId === second.batchId),
    batch: store.batches().find((r) => r.id === second.batchId),
  };
  expect(store.revokeBatch(first.batchId)).toEqual({
    fills: 3,
    cashFlows: 1,
    batches: 1,
  });
  expect(counts(db)).toEqual([1, 3, 5]);
  expect(store.fills()).toEqual(retained.fills);
  expect(store.cashFlows()).toEqual(retained.cash);
  expect(store.batches(false)).toEqual([retained.batch]);
  expect(store.batches().find((b) => b.id === first.batchId)).toMatchObject({
    status: "revoked",
    revokedAt: expect.any(Number),
  });
  expect(store.revokeBatch(first.batchId)).toEqual({
    fills: 0,
    cashFlows: 0,
    batches: 0,
  });
  expect(
    commitDeliveryImport(fixture("ths-statement.html"), options, db),
  ).toMatchObject({ fills: 3, cashFlows: 1, alreadyImported: false });
});

it("overlapping files do not transfer row ownership and account aliases isolate identities", () => {
  const db = database(),
    store = new DeliveryStore(db),
    bytes = fixture("ths-statement.html");
  const first = commitDeliveryImport(bytes, options, db);
  const overlap = commitDeliveryImport(
    Buffer.concat([bytes, Buffer.from("\n")]),
    options,
    db,
  );
  expect(overlap).toMatchObject({
    alreadyImported: false,
    fills: 0,
    cashFlows: 0,
    duplicate: 4,
  });
  expect(store.revokeBatch(overlap.batchId)).toEqual({
    fills: 0,
    cashFlows: 0,
    batches: 1,
  });
  expect(store.fills().every((r) => r.batchId === first.batchId)).toBe(true);
  expect(
    commitDeliveryImport(bytes, { ...options, account: "另一个账户" }, db),
  ).toMatchObject({ fills: 3, cashFlows: 1, duplicate: 0 });
  expect(counts(db)).toEqual([2, 6, 2]);
});

const sensitive = Buffer.from(
  [
    "成交日期,证券代码,操作,成交价格,成交数量,发生金额,成交编号,资金账号,股东账号,自定义列",
    "20260105,999999,证券买入,10,100,-1000,D1,987654321098,876543210987,保留",
    "20260106,,银行转存,,0,1000,,987654321098,876543210987,保留",
    "20260107,,未知业务,,0,1000,,987654321098,876543210987,保留",
  ].join("\n"),
);
it("all three payloads redact primary/duplicate accounts including unresolved evidence", () => {
  const db = database(),
    store = new DeliveryStore(db);
  const preview = previewDeliveryImport(sensitive, options, db);
  expect(preview.summary).toEqual({
    new: 2,
    duplicate: 0,
    conflict: 0,
    unresolved: 1,
    anomalies: 1,
  });
  expect(preview.unmapped).toEqual([{ header: "自定义列", index: 9 }]);
  expect(counts(db)).toEqual([0, 0, 0]);
  expect(commitDeliveryImport(sensitive, options, db)).toMatchObject({
    fills: 1,
    cashFlows: 1,
    duplicate: 0,
  });
  for (const table of tables) {
    const rows = db.prepare(`SELECT payload FROM ${table}`).all() as {
      payload: string;
    }[];
    expect(rows).toHaveLength(1);
    for (const { payload } of rows) {
      expect(payload).not.toContain("987654321098");
      expect(payload).not.toContain("876543210987");
    }
  }
  expect(store.batches()[0]!.payload.rawRows.map((r) => r.slice(7, 9))).toEqual(
    [
      ["***", "***"],
      ["***", "***"],
      ["***", "***"],
    ],
  );
  expect(store.batches()[0]!.payload.unresolved[0]!.cells.slice(7, 9)).toEqual([
    "***",
    "***",
  ]);
  expect(db.prepare("SELECT symbol,code FROM trade_fills").get()).toEqual({
    symbol: null,
    code: "999999",
  });
  expect(JSON.stringify(preview)).not.toContain("987654321098");
  expect(JSON.stringify(preview)).not.toContain("876543210987");
});

it("migrations are repeatable and preserve a genuine version 9 database", () => {
  const db = database(false);
  // Build the genuine version 9 schema from the first nine migrations, then
  // verify later migrations extend it without losing the rows below.
  for (const sql of migrations.slice(0, 9)) db.exec(sql);
  db.pragma("user_version = 9");
  db.prepare("INSERT INTO records VALUES ('old','snapshot','{}',1)").run();
  db.prepare("INSERT INTO concept_rps_days VALUES ('2026-01-01','{}')").run();
  migrate(db);
  migrate(db);
  expect(db.pragma("user_version", { simple: true })).toBe(25);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'intraday_%'",
      )
      .all(),
  ).toHaveLength(2);
  expect(db.prepare("SELECT * FROM records").all()).toEqual([
    { id: "old", kind: "snapshot", payload: "{}", updated_at: 1 },
  ]);
  expect(db.prepare("SELECT * FROM concept_rps_days").all()).toEqual([
    { date: "2026-01-01", payload: "{}" },
  ]);
  expect(counts(db)).toEqual([0, 0, 0]);
});

it("Zod rejects invalid options before reads or writes", () => {
  const db = database();
  for (const bad of [
    { ...options, account: " " },
    { ...options, source: "unknown" },
  ]) {
    expect(() => previewDeliveryImport(sensitive, bad, db)).toThrow();
    expect(() => commitDeliveryImport(sensitive, bad, db)).toThrow();
  }
  expect(counts(db)).toEqual([0, 0, 0]);
});

it("within-batch duplicates write once while differing payloads reject; cash conflicts also reject", () => {
  const db = database(),
    store = new DeliveryStore(db);
  const input = previewDeliveryImport(
    fixture("ths-statement.html"),
    options,
    db,
  );
  input.parsed.fills.push(structuredClone(input.parsed.fills[0]!));
  expect(
    store
      .inspect(options.account, input.parsed)
      .filter((r) => r.status === "duplicate"),
  ).toHaveLength(1);
  expect(store.commitImport({ ...input, importedAt: 1 })).toMatchObject({
    fills: 3,
    cashFlows: 1,
    duplicate: 1,
  });
  input.parsed.cashFlows[0]!.amount++;
  expect(() =>
    store.commitImport({ ...input, fileHash: "cash-conflict", importedAt: 2 }),
  ).toThrow(/差异字段：amount/);
  expect(counts(db)).toEqual([1, 3, 1]);
  const empty = database();
  input.parsed.fills.at(-1)!.price++;
  expect(() =>
    new DeliveryStore(empty).commitImport({ ...input, importedAt: 1 }),
  ).toThrow(/price/);
  expect(counts(empty)).toEqual([0, 0, 0]);
});

it("reads use stable ascending date order and retain batch metadata", () => {
  const db = database(),
    store = new DeliveryStore(db);
  const input = previewDeliveryImport(
    fixture("ths-statement.html"),
    options,
    db,
  );
  input.parsed.fills.reverse();
  store.commitImport({ ...input, importedAt: 20 });
  const second = previewDeliveryImport(
    fixture("eastmoney-statement.csv"),
    options,
    db,
  );
  second.parsed.cashFlows.reverse();
  store.commitImport({ ...second, importedAt: 10 });
  expect(store.batches().map((r) => r.importedAt)).toEqual([10, 20]);
  expect(store.batches()[1]).toMatchObject({
    account: options.account,
    source: options.source,
    fileName: options.fileName,
    fileHash: input.fileHash,
  });
  expect(store.fills().map((r) => r.tradeDate)).toEqual([
    "2026-01-05",
    "2026-01-06",
    "2026-01-08",
    "2026-01-12",
    "2026-01-12",
    "2026-01-20",
  ]);
  expect(store.cashFlows().map((r) => r.flowDate)).toEqual([
    "2026-01-05",
    "2026-01-09",
    "2026-01-14",
    "2026-01-15",
    "2026-01-15",
    "2026-01-19",
  ]);
  expect(store.fills()).toEqual(store.fills());
  expect(store.cashFlows()).toEqual(store.cashFlows());
});

it("撤销首批保留重叠成交和现金流，撤销最后一批才移出账本", () => {
  const db = database();
  const store = new DeliveryStore(db);
  const input = previewDeliveryImport(
    fixture("ths-statement.html"),
    options,
    db,
  );
  const first = store.commitImport({ ...input, importedAt: 1 });
  input.parsed.fills = input.parsed.fills.slice(0, 1);
  const second = store.commitImport({
    ...input,
    fileHash: "partial",
    importedAt: 2,
  });
  expect(second).toMatchObject({ duplicate: 2 });
  expect(store.revokeBatch(first.batchId)).toEqual({
    fills: 2,
    cashFlows: 0,
    batches: 1,
  });
  expect(store.fills().map((r) => r.batchId)).toEqual([second.batchId]);
  expect(store.cashFlows().map((r) => r.batchId)).toEqual([second.batchId]);
  const tombstone = store.batches().find((b) => b.id === first.batchId);
  expect(store.revokeBatch(first.batchId).batches).toBe(0);
  expect(store.batches().find((b) => b.id === first.batchId)).toEqual(
    tombstone,
  );
  expect(store.revokeBatch(second.batchId)).toEqual({
    fills: 1,
    cashFlows: 1,
    batches: 1,
  });
  expect(store.accountSnapshot(options.account)).toEqual({
    fills: [],
    cashFlows: [],
  });
  expect(db.prepare("SELECT count(*) n FROM trade_fills_claims").get()).toEqual(
    { n: 4 },
  );
});

it("v21 缺少重复行归属时拒绝撤销，另一个账户不受影响", () => {
  const db = database(false);
  for (const sql of migrations.slice(0, 21)) db.exec(sql);
  db.pragma("user_version = 21");
  const batch = db.prepare(
    "INSERT INTO import_batches VALUES(?,?,'generic',?,'old.csv',1,?)",
  );
  for (const [id, account] of [
    ["first", "A"],
    ["duplicate", "A"],
    ["independent", "B"],
  ]) {
    batch.run(
      id,
      account,
      id,
      JSON.stringify({ statistics: { fills: 1, cashFlows: 0 } }),
    );
    if (id !== "duplicate")
      db.prepare(
        "INSERT INTO trade_fills VALUES(?,?,NULL,'600000','2026-01-01',?,'{}')",
      ).run(id, account, id);
  }
  migrate(db);
  const store = new DeliveryStore(db);
  expect(() => store.revokeBatch("first")).toThrow(/归属冲突.*duplicate/);
  expect(store.fills("A")).toHaveLength(1);
  expect(store.batches().every((b) => b.status === "active")).toBe(true);
  expect(store.revokeBatch("independent").fills).toBe(1);
  expect(store.revokeBatch("duplicate").fills).toBe(0);
  expect(store.revokeBatch("first").fills).toBe(1);
});

it("费用冲突拒绝整批，撤销首批后历史重叠成交仍沿用首批费用和对账字段", () => {
  const db = database();
  const store = new DeliveryStore(db);
  const input = previewDeliveryImport(
    fixture("ths-statement.html"),
    options,
    db,
  );
  const first = store.commitImport({ ...input, importedAt: 1 });
  const saved = store.accountSnapshot(options.account);
  const second = store.commitImport({
    ...input,
    fileHash: "overlap",
    importedAt: 2,
  });
  const fill = input.parsed.fills[0]!;
  fill.fees.total = (fill.fees.total ?? 0) + 1;
  fill.balanceCash = 123;
  const conflict = () =>
    store.commitImport({ ...input, fileHash: "different-fees", importedAt: 3 });
  expect(conflict).toThrow(/fees/);
  // A claim written by the earlier importer can already contain divergent fees.
  db.prepare(
    "UPDATE trade_fills_claims SET payload=? WHERE batch_id=? AND id=?",
  ).run(
    JSON.stringify(fill),
    second.batchId,
    deliveryRowId(options.account, fill.fingerprintSource),
  );
  expect(store.accountSnapshot(options.account)).toEqual(saved);
  store.revokeBatch(first.batchId);
  expect(store.accountSnapshot(options.account)).toEqual({
    fills: saved.fills.map((row) => ({ ...row, batchId: second.batchId })),
    cashFlows: saved.cashFlows.map((row) => ({
      ...row,
      batchId: second.batchId,
    })),
  });
  expect(conflict).toThrow(/fees/);
  const beforeRetry = store.batches();
  expect(
    store.commitImport({ ...input, fileHash: "overlap", importedAt: 3 }),
  ).toEqual({ ...second, alreadyImported: true });
  expect(store.batches()).toEqual(beforeRetry);
  store.revokeBatch(second.batchId);
  const fresh = store.commitImport({ ...input, importedAt: 4 });
  expect(fresh).toMatchObject({ fills: 3, cashFlows: 1, duplicate: 0 });
  expect(
    store
      .fills()
      .find((row) => row.fingerprintSource === fill.fingerprintSource),
  ).toMatchObject({
    fees: fill.fees,
    balanceCash: 123,
    batchId: fresh.batchId,
  });
});

it("v21 迁移后同文件同范围返回原回执，费用差异仍阻断新文件", () => {
  const db = database(false);
  for (const sql of migrations.slice(0, 21)) db.exec(sql);
  db.pragma("user_version = 21");
  const table = parseDeliveryTable(fixture("ths-settlement.txt"));
  const row = table.rows.find((row) => row[0] === "20240301")!;
  const bytes = Buffer.from(
    [table.header.join("\t"), row.join("\t")].join("\n"),
  );
  const input = previewDeliveryImport(bytes, options, db);
  const storedFill = structuredClone(input.parsed.fills[0]!);
  storedFill.fees.total = (storedFill.fees.total ?? 0) + 1;
  const receipt = { fills: 0, cashFlows: 0, duplicate: 1 };
  const statistics = { fills: 1, cashFlows: 0 };
  const insertBatch = db.prepare(
    "INSERT INTO import_batches VALUES (?,?,?,?,?,?,?)",
  );
  insertBatch.run(
    "earlier",
    input.account,
    input.source,
    "earlier-file-hash",
    input.fileName,
    1,
    JSON.stringify({ statistics }),
  );
  insertBatch.run(
    "original",
    input.account,
    input.source,
    input.fileHash,
    input.fileName,
    2,
    JSON.stringify({
      receipt,
      statistics,
      diagnostics: ["原始批次诊断"],
      statementOpeningCash: 123,
    }),
  );
  db.prepare("INSERT INTO trade_fills VALUES (?,?,?,?,?,?,?)").run(
    deliveryRowId(input.account, storedFill.fingerprintSource),
    input.account,
    storedFill.symbol,
    storedFill.code,
    storedFill.tradeDate,
    "earlier",
    JSON.stringify(storedFill),
  );
  expect(
    buildLegacyCleanupManifest(db, ":memory:").protected,
  ).not.toHaveProperty("delivery_batches");
  migrate(db);

  const store = new DeliveryStore(db);
  const before = store.accountSnapshot(input.account);
  expect(commitDeliveryImport(bytes, { ...options, scope: "all" }, db)).toEqual(
    {
      ...receipt,
      batchId: "original",
      alreadyImported: true,
      diagnostics: ["原始批次诊断"],
      statementOpeningCash: 123,
    },
  );
  expect(() =>
    commitDeliveryImport(bytes, { ...options, scope: "cashFlowsOnly" }, db),
  ).toThrow(/不同 scope/);
  expect(() =>
    commitDeliveryImport(
      Buffer.concat([bytes, Buffer.from("\n")]),
      options,
      db,
    ),
  ).toThrow(/fees/);
  expect(counts(db)).toEqual([2, 1, 0]);
  expect(store.accountSnapshot(input.account)).toEqual(before);
  expect(
    store.commitImport({
      ...input,
      fileHash: "earlier-file-hash",
      importedAt: 3,
    }),
  ).toEqual({
    batchId: "earlier",
    alreadyImported: true,
    fills: 0,
    cashFlows: 0,
    duplicate: 1,
  });
});

it("清理清单校验撤销批次和视图不可见的原始成交与现金流 claim", () => {
  const db = database();
  const store = new DeliveryStore(db);
  const { batchId } = commitDeliveryImport(
    fixture("ths-statement.html"),
    options,
    db,
  );
  store.revokeBatch(batchId);
  const checksums = () => buildLegacyCleanupManifest(db, ":memory:").protected;
  const before = checksums();
  expect(before).toMatchObject({
    import_batches: { rows: 0 },
    trade_fills: { rows: 0 },
    cash_flows: { rows: 0 },
    delivery_batches: { rows: 1 },
    trade_fills_claims: { rows: 3 },
    cash_flows_claims: { rows: 1 },
  });

  db.prepare(
    "UPDATE delivery_batches SET revoked_at = revoked_at + 1 WHERE id = ?",
  ).run(batchId);
  db.prepare(
    "UPDATE trade_fills_claims SET payload = '{}' WHERE batch_id = ?",
  ).run(batchId);
  db.prepare(
    "UPDATE cash_flows_claims SET payload = '{}' WHERE batch_id = ?",
  ).run(batchId);
  const after = checksums();
  for (const relation of [
    "delivery_batches",
    "trade_fills_claims",
    "cash_flows_claims",
  ] as const) {
    expect(after[relation]?.rows).toBe(before[relation]?.rows);
    expect(after[relation]?.sha256).not.toBe(before[relation]?.sha256);
  }
  expect(after).toMatchObject({
    import_batches: before.import_batches,
    trade_fills: before.trade_fills,
    cash_flows: before.cash_flows,
  });
});
