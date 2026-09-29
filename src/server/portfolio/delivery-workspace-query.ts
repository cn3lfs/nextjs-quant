import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DeliveryStore, type ImportBatch } from "./delivery-store";

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

// All current fact writes belong to immutable batches. Include every identity,
// rather than count/max, so revoke-and-replace invalidates the old snapshot.
export function deliveryAccountVersion(
  db: Database.Database,
  account?: string,
) {
  return digest(
    db
      .prepare(
        `SELECT id,file_hash,imported_at FROM import_batches
    WHERE (@account IS NULL OR account=@account) ORDER BY id`,
      )
      .all({ account: account ?? null }),
  );
}

type SummaryRow = Omit<ImportBatch, "payload" | "scope"> & {
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
  (SELECT count(*) FROM trade_fills f WHERE f.batch_id=b.id) ownedFills,
  (SELECT count(*) FROM cash_flows c WHERE c.batch_id=b.id) ownedCashFlows`;
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

export function deliveryBatchPage(db: Database.Database, raw: unknown) {
  const input = deliveryBatchPageSchema.parse(raw);
  const {
    cursor: encoded,
    offset: requestedOffset,
    version: expectedVersion,
    ...filters
  } = input;
  const filter = digest(filters);
  return db.transaction(() => {
    const version = deliveryAccountVersion(db, input.account || undefined);
    if (expectedVersion && expectedVersion !== version)
      throw new Error("批次已变化，请重新检索");
    let cursor: {
      id: string;
      at: number;
      filter: string;
      version: string;
      position: number;
    } | null = null;
    if (encoded) {
      try {
        cursor = z
          .object({
            id: z.string(),
            at: z.number().int(),
            filter: z.string(),
            version: z.string(),
            position: z.number().int().nonnegative().default(0),
          })
          .parse(
            JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
          );
      } catch {
        throw new Error("批次分页位置无效，请重新检索");
      }
      if (cursor.filter !== filter) throw new Error("筛选已变化，请重新检索");
      if (cursor.version !== version) throw new Error("批次已变化，请重新检索");
    }
    const where = `(@account IS NULL OR b.account=@account) AND (@source IS NULL OR b.source=@source)
      AND instr(lower(b.file_name),lower(@keyword))>0
      AND (@from IS NULL OR b.imported_at>=@from) AND (@to IS NULL OR b.imported_at<=@to)`;
    const parameters = {
      account: input.account || null,
      source: input.source ?? null,
      keyword: input.keyword,
      from: input.from ?? null,
      to: input.to ?? null,
    };
    const count = (
      db
        .prepare(`SELECT count(*) count FROM import_batches b WHERE ${where}`)
        .get(parameters) as { count: number }
    ).count;
    const offset =
      cursor?.position ??
      Math.min(requestedOffset, Math.max(0, Math.floor((count - 1) / 20) * 20));
    const rows = db
      .prepare(
        `SELECT ${projection} FROM import_batches b
      WHERE ${where}
      AND (@at IS NULL OR b.imported_at<@at OR (b.imported_at=@at AND b.id<@id))
      ORDER BY b.imported_at DESC,b.id DESC LIMIT 21 OFFSET @offset`,
      )
      .all({
        ...parameters,
        offset: cursor ? 0 : offset,
        at: cursor?.at ?? null,
        id: cursor?.id ?? null,
      }) as SummaryRow[];
    const items = rows.slice(0, 20).map(summary),
      last = items.at(-1);
    return {
      items,
      version,
      count,
      offset,
      nextCursor:
        rows.length > 20 && last
          ? Buffer.from(
              JSON.stringify({
                id: last.id,
                at: last.importedAt,
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
        .prepare(`SELECT id,payload FROM ${table} WHERE batch_id=? ORDER BY id`)
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
