import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DeliveryStore,
  exclusiveDeliveryRow,
  type ImportBatch,
} from "./delivery-store";

export const deliveryBatchPageSchema = z
  .object({
    account: z.string().trim().max(64).optional(),
    source: z.enum(["generic", "ths", "eastmoney", "tdx"]).optional(),
    keyword: z.string().trim().max(255).default(""),
    from: z.number().int().nonnegative().optional(),
    to: z.number().int().nonnegative().optional(),
    cursor: z.string().max(2048).optional(),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(2_147_483_620)
      .multipleOf(20)
      .default(0),
    version: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine(
    (v) => v.from === undefined || v.to === undefined || v.from <= v.to,
    "起止时间无效",
  );
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sqliteText = (value: string) =>
  Buffer.from(value, "utf8").toString("utf8");

type BatchIndexRow = {
  id: string;
  account: string;
  source: string;
  file_hash: string;
  foldedName: string;
  imported_at: number;
};
type BatchScope = {
  rows: BatchIndexRow[];
  version?: string;
  pageOrder?: BatchIndexRow[];
  filtered?: { key: string; rows: BatchIndexRow[] };
};
type BatchIndex =
  | { sqlFallback: true }
  | { sqlFallback: false; all: BatchScope; accounts: Map<string, BatchScope> };
function readBatchIndex(db: Database.Database): BatchIndex {
  const rows = db
    .prepare(
      `SELECT id,account,source,file_hash,file_name,
    lower(file_name) foldedName,imported_at FROM import_batches ORDER BY id`,
    )
    .all() as (BatchIndexRow & { file_name: unknown })[];
  const accounts = new Map<string, BatchScope>();
  for (const row of rows) {
    if (
      typeof row.id !== "string" ||
      typeof row.imported_at !== "number" ||
      !Number.isSafeInteger(row.imported_at) ||
      typeof row.account !== "string" ||
      typeof row.file_name !== "string" ||
      typeof row.source !== "string"
    )
      return { sqlFallback: true };
    let scope = accounts.get(row.account);
    if (!scope) {
      scope = { rows: [] };
      accounts.set(row.account, scope);
    }
    scope.rows.push(row);
  }
  return { sqlFallback: false, all: { rows }, accounts };
}
const batchCache = new WeakMap<
  Database.Database,
  {
    dataVersion: number;
    changes: number;
    index: BatchIndex;
  }
>();

// Called inside the read transaction. A caller-owned transaction may roll back
// (including to a savepoint) without changing either counter.
function committedBatchIndex(db: Database.Database) {
  // Reading a main database b-tree pins the snapshot before sampling data_version.
  const changes = db
    .prepare("SELECT total_changes() FROM main.sqlite_schema LIMIT 1")
    .pluck()
    .get() as number;
  const dataVersion = db.pragma("main.data_version", {
    simple: true,
  }) as number;
  const cached = batchCache.get(db);
  if (
    cached &&
    cached.changes === changes &&
    cached.dataVersion === dataVersion
  )
    return cached.index;
  const index = readBatchIndex(db);
  batchCache.set(db, { changes, dataVersion, index });
  return index;
}
function batchScope(
  index: BatchIndex,
  account?: string,
): BatchScope | undefined {
  if (index.sqlFallback) return undefined;
  return account === undefined
    ? index.all
    : (index.accounts.get(sqliteText(account)) ?? { rows: [] });
}
function scopeVersion(scope: BatchScope) {
  // rows retain SQLite's BINARY id order, including non-ASCII identifiers.
  return (scope.version ??= digest(
    scope.rows.map(({ id, file_hash, imported_at }) => ({
      id,
      file_hash,
      imported_at,
    })),
  ));
}
export function deliveryAccountVersion(
  db: Database.Database,
  account?: string,
) {
  if (!db.inTransaction)
    return db.transaction(() => {
      const scope = batchScope(committedBatchIndex(db), account);
      return scope ? scopeVersion(scope) : sqlAccountVersion(db, account);
    })();
  // Detail and revoke already have a transaction and only need the identities.
  return sqlAccountVersion(db, account);
}
function sqlAccountVersion(db: Database.Database, account?: string) {
  return digest(
    db
      .prepare(
        `SELECT id,file_hash,imported_at FROM import_batches
    WHERE (@account IS NULL OR account=@account) ORDER BY id`,
      )
      .all({ account: account ?? null }),
  );
}

type SummaryRow = Omit<
  ImportBatch,
  "payload" | "scope" | "status" | "revokedAt"
> & {
  scope: "all" | "cashFlowsOnly";
  statisticsJson: string;
  receiptJson: string | null;
  ownedFills: number;
  ownedCashFlows: number;
};
const projection = `b.id,b.account,b.source,b.file_hash fileHash,b.file_name fileName,b.imported_at importedAt,
  coalesce(json_extract(b.payload,'$.scope'),'all') scope,
  json_extract(b.payload,'$.statistics') statisticsJson,
  json_extract(b.payload,'$.receipt') receiptJson,
  (SELECT count(*) FROM trade_fills f WHERE f.batch_id=b.id AND ${exclusiveDeliveryRow("trade_fills")}) ownedFills,
  (SELECT count(*) FROM cash_flows f WHERE f.batch_id=b.id AND ${exclusiveDeliveryRow("cash_flows")}) ownedCashFlows`;
function summary(row: SummaryRow) {
  const { statisticsJson, receiptJson, ...value } = row;
  return {
    ...value,
    receipt: receiptJson
      ? (JSON.parse(receiptJson) as ImportBatch["payload"]["receipt"])
      : null,
    statistics: JSON.parse(
      statisticsJson,
    ) as ImportBatch["payload"]["statistics"],
  };
}

type BatchFilters = Pick<
  z.infer<typeof deliveryBatchPageSchema>,
  "source" | "from" | "to" | "keyword"
>;
function matchingRows(
  db: Database.Database,
  scope: BatchScope,
  filters: BatchFilters,
  key: string,
) {
  // Reverse id order first. Stable time sorting preserves SQLite's tie-break.
  const ordered = (scope.pageOrder ??= scope.rows
    .slice()
    .reverse()
    .sort((a, b) => b.imported_at - a.imported_at));
  const { source, from, to, keyword } = filters;
  if (!keyword && !source && from === undefined && to === undefined)
    return ordered;
  if (scope.filtered?.key === key) return scope.filtered.rows;
  const needle =
    keyword &&
    (db.prepare("SELECT lower(?)").pluck().get(sqliteText(keyword)) as string);
  const rows = ordered.filter(
    (row) =>
      (!source || row.source === source) &&
      (from === undefined || row.imported_at >= from) &&
      (to === undefined || row.imported_at <= to) &&
      (!needle || row.foldedName.includes(needle)),
  );
  scope.filtered = { key, rows };
  return rows;
}

function afterCursor(
  rows: BatchIndexRow[],
  cursor: { at: number; id: string },
) {
  const id = Buffer.from(cursor.id);
  let low = 0,
    high = rows.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const row = rows[mid]!;
    if (
      row.imported_at > cursor.at ||
      (row.imported_at === cursor.at && Buffer.from(row.id).compare(id) >= 0)
    )
      low = mid + 1;
    else high = mid;
  }
  return low;
}

const cursorFields = z.object({
  filter: z.string(),
  version: z.string(),
  position: z.number().int().nonnegative().default(0),
});
const cursorSchema = z.union([
  cursorFields.extend({ id: z.string(), at: z.number().int() }),
  cursorFields.extend({
    sqlOffset: z.literal(true),
    position: z.number().int().nonnegative(),
  }),
]);
type PageCursor = z.infer<typeof cursorSchema>;

function pageOffset(
  count: number,
  requested: number,
  cursor: PageCursor | null,
) {
  return (
    cursor?.position ??
    Math.min(requested, Math.max(0, Math.floor((count - 1) / 20) * 20))
  );
}

function sqlBatchPage(
  db: Database.Database,
  input: z.infer<typeof deliveryBatchPageSchema>,
  cursor: PageCursor | null,
) {
  const where = `(@account IS NULL OR b.account=@account) AND (@source IS NULL OR b.source=@source)
    AND (@keyword='' OR instr(lower(b.file_name),lower(@keyword))>0)
    AND (@from IS NULL OR b.imported_at>=@from) AND (@to IS NULL OR b.imported_at<=@to)`;
  const parameters = {
    account: input.account || null,
    source: input.source ?? null,
    keyword: input.keyword,
    from: input.from ?? null,
    to: input.to ?? null,
  };
  const count = db
    .prepare(`SELECT count(*) FROM import_batches b WHERE ${where}`)
    .pluck()
    .get(parameters) as number;
  const offset = pageOffset(count, input.offset, cursor);
  const boundary = cursor && "id" in cursor ? cursor : null;
  const rows = db
    .prepare(
      `SELECT ${projection} FROM import_batches b WHERE ${where}
    AND (@at IS NULL OR b.imported_at<@at OR (b.imported_at=@at AND b.id<@id))
    ORDER BY b.imported_at DESC,b.id DESC LIMIT 21 OFFSET @offset`,
    )
    .all({
      ...parameters,
      at: boundary?.at ?? null,
      id: boundary?.id ?? null,
      offset: boundary ? 0 : offset,
    }) as SummaryRow[];
  return { count, offset, rows: rows.slice(0, 20), hasMore: rows.length > 20 };
}

function indexedBatchPage(
  db: Database.Database,
  scope: BatchScope,
  input: z.infer<typeof deliveryBatchPageSchema>,
  filter: string,
  cursor: PageCursor | null,
) {
  const matches = matchingRows(db, scope, input, filter);
  const count = matches.length;
  const offset = pageOffset(count, input.offset, cursor);
  const start =
    cursor && "id" in cursor ? afterCursor(matches, cursor) : offset;
  const ids = matches.slice(start, start + 20).map((row) => row.id);
  const rows = ids.length
    ? (db
        .prepare(
          `SELECT ${projection} FROM import_batches b
      WHERE b.id IN (${ids.map(() => "?").join(",")})
      ORDER BY b.imported_at DESC,b.id DESC`,
        )
        .all(...ids) as SummaryRow[])
    : [];
  return { count, offset, rows, hasMore: start + 20 < count };
}

export function deliveryBatchPage(db: Database.Database, raw: unknown) {
  const input = deliveryBatchPageSchema.parse(raw);
  const {
    account,
    source,
    keyword,
    from,
    to,
    cursor: encoded,
    version: expectedVersion,
  } = input;
  const filter = digest({ account, source, keyword, from, to });
  const cacheable = !db.inTransaction;
  return db.transaction(() => {
    const index = cacheable ? committedBatchIndex(db) : readBatchIndex(db);
    const scope = batchScope(index, account || undefined);
    const version = scope
      ? scopeVersion(scope)
      : sqlAccountVersion(db, account || undefined);
    if (expectedVersion && expectedVersion !== version)
      throw new Error("批次已变化，请重新检索");
    let cursor: PageCursor | null = null;
    if (encoded) {
      try {
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
        );
      } catch {
        throw new Error("批次分页位置无效，请重新检索");
      }
      if (cursor.filter !== filter) throw new Error("筛选已变化，请重新检索");
      if (cursor.version !== version) throw new Error("批次已变化，请重新检索");
    }
    const { count, offset, rows, hasMore } = scope
      ? indexedBatchPage(db, scope, input, filter, cursor)
      : sqlBatchPage(db, input, cursor);
    const items = rows.map(summary),
      last = items.at(-1);
    return {
      items,
      version,
      count,
      offset,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                // A non-standard SQL sort key may not survive a JSON round trip.
                ...(scope
                  ? { id: last.id, at: last.importedAt }
                  : { sqlOffset: true }),
                filter,
                version,
                position: offset + 20,
              }),
            ).toString("base64url")
          : null,
    };
  })();
}

// Receipt lookup does not read the source file, including after a lost response.
export function deliveryBatchReceipt(
  db: Database.Database,
  account: string,
  fileHash: string,
) {
  const row = db
    .prepare(
      `SELECT ${projection} FROM import_batches b WHERE b.account=? AND b.file_hash=?`,
    )
    .get(account, fileHash) as SummaryRow | undefined;
  return row ? summary(row) : null;
}

export const deliveryBatchIdSchema = z.string().min(1).max(128);
export const deliveryEvidencePageSchema = z.object({
  id: deliveryBatchIdSchema,
  section: z.enum(["rawRows", "unresolved", "diagnostics"]),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 20)
    .default(0),
});
export const deliveryRevokeCheckedSchema = z.object({
  id: deliveryBatchIdSchema,
  account: z.string().min(1).max(64),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  ownedFills: z.number().int().nonnegative(),
  ownedCashFlows: z.number().int().nonnegative(),
});

export function deliveryBatchDetail(db: Database.Database, id: string) {
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT ${projection},
      json_extract(b.payload,'$.mapping') mappingJson,
      json_extract(b.payload,'$.sourceHeader') headerJson,
      json_extract(b.payload,'$.format') format,
      json_extract(b.payload,'$.encoding') encoding,
      json_extract(b.payload,'$.counts') countsJson,
      json_extract(b.payload,'$.statementOpeningCash') statementOpeningCash,
      json_array_length(b.payload,'$.rawRows') rawRowCount,
      json_array_length(b.payload,'$.unresolved') unresolvedCount,
      json_array_length(b.payload,'$.diagnostics') diagnosticCount
      FROM import_batches b WHERE b.id=?`,
      )
      .get(id) as
      | (SummaryRow & {
          mappingJson: string | null;
          headerJson: string | null;
          format: string | null;
          encoding: string | null;
          countsJson: string | null;
          statementOpeningCash: number | null;
          rawRowCount: number;
          unresolvedCount: number;
          diagnosticCount: number;
        })
      | undefined;
    if (!row) return null;
    const {
      mappingJson,
      headerJson,
      format,
      encoding,
      countsJson,
      statementOpeningCash,
      rawRowCount,
      unresolvedCount,
      diagnosticCount,
      ...base
    } = row;
    return {
      ...summary(base),
      version: deliveryAccountVersion(db, row.account),
      sourceHeader: headerJson ? (JSON.parse(headerJson) as string[]) : null,
      format,
      encoding,
      mapping: mappingJson
        ? (JSON.parse(mappingJson) as ImportBatch["payload"]["mapping"])
        : null,
      counts: countsJson
        ? (JSON.parse(countsJson) as ImportBatch["payload"]["counts"])
        : null,
      statementOpeningCash,
      rawRowCount,
      unresolvedCount,
      diagnosticCount,
    };
  })();
}

// SQLite extracts only the requested evidence page; the browser never needs the
// entire original payload to read the first twenty rows.
export function deliveryEvidencePage(db: Database.Database, raw: unknown) {
  const input = deliveryEvidencePageSchema.parse(raw);
  return db.transaction(() => {
    const exists = db
      .prepare("SELECT id FROM import_batches WHERE id=?")
      .get(input.id);
    if (!exists) return null;
    const rows = db
      .prepare(
        `SELECT j.key rowIndex,j.value value FROM import_batches b,
      json_each(b.payload,@section) j WHERE b.id=@id AND j.key>=@offset ORDER BY j.key LIMIT 21`,
      )
      .all({
        id: input.id,
        section: `$.${input.section}`,
        offset: input.offset,
      }) as { rowIndex: number; value: string }[];
    return {
      items: rows.slice(0, 20).map((row) => ({
        rowIndex: row.rowIndex,
        value:
          input.section === "diagnostics"
            ? row.value
            : (JSON.parse(row.value) as unknown),
      })),
      nextOffset: rows.length > 20 ? input.offset + 20 : null,
    };
  })();
}

export function deliveryBatchExport(db: Database.Database, id: string) {
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT ${projection},b.payload FROM import_batches b WHERE b.id=?`,
      )
      .get(id) as (SummaryRow & { payload: string }) | undefined;
    if (!row) return null;
    const { payload, ...base } = row;
    const facts = (table: "trade_fills" | "cash_flows") =>
      db
        .prepare(
          `SELECT id,payload FROM ${table}_claims WHERE batch_id=? ORDER BY id`,
        )
        .all(id)
        .map((value) => {
          const fact = value as { id: string; payload: string };
          return { id: fact.id, value: JSON.parse(fact.payload) as unknown };
        });
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      batch: summary(base),
      evidence: JSON.parse(payload) as ImportBatch["payload"],
      fills: facts("trade_fills"),
      cashFlows: facts("cash_flows"),
    };
  })();
}

export function deliveryRevokeChecked(db: Database.Database, raw: unknown) {
  const input = deliveryRevokeCheckedSchema.parse(raw);
  return db
    .transaction(() => {
      const current = deliveryBatchDetail(db, input.id);
      if (!current) return { fills: 0, cashFlows: 0, batches: 0 };
      if (
        current.account !== input.account ||
        current.version !== input.version ||
        current.ownedFills !== input.ownedFills ||
        current.ownedCashFlows !== input.ownedCashFlows
      )
        throw new Error("批次影响已变化，请重新核对后撤销");
      return new DeliveryStore(db).revokeBatch(input.id);
    })
    .immediate();
}
