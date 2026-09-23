import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { parseDeliveryTable } from "../../src/lib/research/evidence/delivery-table";
import { afterEach, expect, it } from "vitest";
import { migrate } from "../../src/server/db/migrations";
import {
  DeliveryStore,
  deliveryRowId,
} from "../../src/server/portfolio/delivery-store";
import {
  commitDeliveryImport,
  previewDeliveryImport,
} from "../../src/server/portfolio/delivery-import-service";

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

it("R5b: overlapping settlement/history rows deduplicate in either import order", () => {
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
      { new: 0, duplicate: 1, conflict: 0 },
    );
    expect(commitDeliveryImport(bytes[1]!, options, db)).toMatchObject({
      fills: 0,
      duplicate: 1,
      diagnostics: expect.arrayContaining([
        expect.stringContaining("1 笔因已存在而跳过，保留先导入的版本"),
      ]),
    });
    expect(counts(db)).toEqual([2, 1, 0]);
    expect(store.fills()).toEqual(saved);
    expect(store.batches().at(-1)!.payload.diagnostics.join()).toContain(
      "1 笔因已存在而跳过，保留先导入的版本",
    );
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
  changed.parsed.fills[0]!.fees.transferFee = null;
  changed.parsed.fills[0]!.fees.total = 999;
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
  expect(preview.summary.duplicate).toBe(4);
  expect(
    preview.rows
      .filter((row) => row.status === "conflict")
      .map((row) => row.differences),
  ).toEqual([["netAmount"], ["netAmount"]]);
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
      batchId: first.batchId,
      alreadyImported: true,
      fills: 0,
      cashFlows: 0,
      duplicate: fills + cashFlows,
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
    "CREATE TRIGGER fail_cash BEFORE INSERT ON cash_flows BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
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
  expect(store.batches()).toEqual([retained.batch]);
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

it("migration 10 is repeatable and preserves a genuine version 9 database", () => {
  const db = database(false);
  const source = readFileSync("src/server/db/migrations.ts", "utf8");
  const statements = [
    ...source
      .slice(0, source.indexOf("export function migrate"))
      .matchAll(/`([^`]+)`/g),
  ].map((match) => match[1]!);
  expect(statements).toHaveLength(10);
  for (const sql of statements.slice(0, 9)) db.exec(sql);
  db.pragma("user_version = 9");
  db.prepare("INSERT INTO records VALUES ('old','snapshot','{}',1)").run();
  db.prepare("INSERT INTO concept_rps_days VALUES ('2026-01-01','{}')").run();
  migrate(db);
  migrate(db);
  expect(db.pragma("user_version", { simple: true })).toBe(10);
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
