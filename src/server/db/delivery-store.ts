import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  importOptionsSchema,
  redactRow,
  type DeliveryImport,
  type ImportOptions,
  type ParsedFill,
  type ParsedCashFlow,
} from "~/lib/research/evidence/delivery-import";

export type CommitImportInput = ImportOptions & {
  fileHash: string;
  fileName: string;
  importedAt: number;
  parsed: DeliveryImport;
  rawRows: string[][];
  sourceHeader?: string[];
  format?: string;
  encoding?: string;
};
export type ImportResult = {
  batchId: string;
  alreadyImported: boolean;
  fills: number;
  cashFlows: number;
  duplicate: number;
  diagnostics?: string[];
  statementOpeningCash?: number | null;
  counts?: DeliveryImport["counts"];
  cashFlowSummary?: DeliveryImport["cashFlowSummary"];
};
export type ImportRowStatus = {
  id: string;
  rowIndex: number;
  type: "fill" | "cashFlow";
  status: "new" | "duplicate" | "conflict";
  differences: string[];
};
type Stored<T> = T & { id: string; account: string; batchId: string };
type BatchPayload = Pick<
  DeliveryImport,
  | "mapping"
  | "diagnostics"
  | "unresolved"
  | "statementOpeningCash"
  | "counts"
  | "cashFlowSummary"
> & {
  receipt?: { fills: number; cashFlows: number; duplicate: number };
  sourceHeader?: string[];
  format?: string;
  encoding?: string;
  scope?: ImportOptions["scope"];
  rawRows: string[][];
  statistics: {
    fills: number;
    cashFlows: number;
    unresolved: number;
    anomalies: number;
  };
};
export type ImportBatch = ImportOptions & {
  revokedAt: number | null;
  status: "active" | "revoked";
  id: string;
  fileHash: string;
  fileName: string;
  importedAt: number;
  payload: BatchPayload;
};

export function deliveryRowId(account: string, fingerprintSource: string) {
  return createHash("sha256")
    .update(`${account}|${fingerprintSource}`)
    .digest("hex");
}

type DeliveryFactTable = "trade_fills" | "cash_flows";

// Caller aliases its active economic row as f.
export function exclusiveDeliveryRow(table: DeliveryFactTable) {
  return `NOT EXISTS (SELECT 1 FROM ${table}_claims other
    JOIN import_batches active ON active.id=other.batch_id
    WHERE other.id=f.id AND other.batch_id<>f.batch_id)`;
}

function importResultMetadata({
  cashFlowSummary,
  statementOpeningCash,
  counts,
}: Pick<BatchPayload, "cashFlowSummary" | "statementOpeningCash" | "counts">) {
  return {
    ...(cashFlowSummary ? { cashFlowSummary } : {}),
    ...(statementOpeningCash !== undefined ? { statementOpeningCash } : {}),
    ...(counts ? { counts } : {}),
  };
}

export class DeliveryStore {
  constructor(readonly db: Database.Database) {}

  accountSnapshot(account: string) {
    return this.db.transaction(() => ({
      fills: this.fills(account),
      cashFlows: this.cashFlows(account),
    }))();
  }

  inspect(account: string, parsed: DeliveryImport): ImportRowStatus[] {
    const seen = new Map<string, ParsedFill | ParsedCashFlow>();
    const inspect = (
      row: ParsedFill | ParsedCashFlow,
      type: ImportRowStatus["type"],
    ): ImportRowStatus => {
      const id = deliveryRowId(account, row.fingerprintSource);
      const table = type === "fill" ? "trade_fills" : "cash_flows";
      const existing = this.db
        .prepare(`SELECT payload FROM ${table} WHERE id=?`)
        .get(id) as { payload: string } | undefined;
      const previous =
        seen.get(id) ??
        (existing
          ? (JSON.parse(existing.payload) as ParsedFill | ParsedCashFlow)
          : undefined);
      seen.set(id, previous ?? row);
      const differences = previous
        ? (type === "fill"
            ? [
                "tradeDate",
                "code",
                "kind",
                "price",
                "quantity",
                "amount",
                "fees",
                "netAmount",
              ]
            : ["flowDate", "kind", "amount", "code"]
          ).filter(
            (key) =>
              !isDeepStrictEqual(
                Reflect.get(previous, key),
                Reflect.get(row, key),
              ),
          )
        : [];
      return {
        id,
        rowIndex: row.rowIndex,
        type,
        status: previous
          ? differences.length
            ? "conflict"
            : "duplicate"
          : "new",
        differences,
      };
    };
    const rows = [
      ...parsed.fills.map((row) => inspect(row, "fill")),
      ...parsed.cashFlows.map((row) => inspect(row, "cashFlow")),
    ].sort((a, b) => a.rowIndex - b.rowIndex || a.id.localeCompare(b.id));
    const duplicate = rows.filter((row) => row.status === "duplicate").length;
    const prefix = "重复导入：";
    parsed.diagnostics = parsed.diagnostics.filter(
      (message) => !message.startsWith(prefix),
    );
    if (duplicate)
      parsed.diagnostics.push(
        `${prefix}${duplicate} 笔因已存在而跳过，保留先导入的版本。`,
      );
    return rows;
  }

  commitImport(input: CommitImportInput): ImportResult {
    const { account, source, scope } = importOptionsSchema.parse(input);
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare(
            "SELECT id,payload FROM import_batches WHERE account=? AND file_hash=?",
          )
          .get(account, input.fileHash) as
          { id: string; payload: string } | undefined;
        if (existing) {
          const previous = JSON.parse(existing.payload) as BatchPayload;
          if ((previous.scope ?? "all") !== (scope ?? "all"))
            throw new Error(
              "同一文件已按不同 scope 导入；请先核对并撤销原批次，再选择新的导入范围",
            );
          // A retry writes nothing; report zero new rows while keeping the
          // persisted batch identity and original duplicate count.
          return {
            ...importResultMetadata(previous),
            fills: 0,
            cashFlows: 0,
            duplicate:
              previous.receipt?.duplicate ??
              (previous.statistics?.fills ?? 0) +
                (previous.statistics?.cashFlows ?? 0),
            batchId: existing.id,
            alreadyImported: true,
            ...(previous.receipt?.duplicate
              ? { diagnostics: previous.diagnostics }
              : {}),
          };
        }

        if (scope === "cashFlowsOnly" && input.parsed.fills.length)
          throw new Error(
            "cashFlowsOnly 批次不能包含成交，请按指定范围重新解析",
          );
        const metadata = importResultMetadata(input.parsed);
        const rows = this.inspect(account, input.parsed);
        const conflicts = rows.filter((row) => row.status === "conflict");
        if (conflicts.length)
          throw new Error(
            `交易编号已用于不同内容（${conflicts.length} 笔）：${conflicts
              .slice(0, 5)
              .map(
                (row) =>
                  `${row.id} 差异字段：${row.differences.slice(0, 8).join("、")}`,
              )
              .join("；")}`,
          );
        const batchId = randomUUID();
        const payload: BatchPayload = {
          ...(input.sourceHeader ? { sourceHeader: input.sourceHeader } : {}),
          ...(input.format ? { format: input.format } : {}),
          ...(input.encoding ? { encoding: input.encoding } : {}),
          ...metadata,
          ...(scope ? { scope } : {}),
          mapping: input.parsed.mapping,
          diagnostics: input.parsed.diagnostics,
          rawRows: input.rawRows.map((row) =>
            redactRow(row, input.parsed.mapping),
          ),
          unresolved: input.parsed.unresolved.map((row) => ({
            ...row,
            cells: redactRow(row.cells, input.parsed.mapping),
          })),
          statistics: {
            fills: input.parsed.fills.length,
            cashFlows: input.parsed.cashFlows.length,
            unresolved: input.parsed.unresolved.length,
            anomalies: input.parsed.fills.filter((row) => row.anomalies.length)
              .length,
          },
        };
        this.db
          .prepare("INSERT INTO import_batches VALUES (?,?,?,?,?,?,?)")
          .run(
            batchId,
            account,
            source,
            input.fileHash,
            input.fileName,
            input.importedAt,
            JSON.stringify(payload),
          );
        const result: ImportResult = {
          ...metadata,
          batchId,
          alreadyImported: false,
          fills: 0,
          cashFlows: 0,
          duplicate: 0,
        };

        const insert = (
          row: ParsedFill | ParsedCashFlow,
          type: "fill" | "cashFlow",
        ) => {
          const id = deliveryRowId(account, row.fingerprintSource);
          const exists = this.db
            .prepare(
              `SELECT id FROM ${type === "fill" ? "trade_fills" : "cash_flows"} WHERE id=?`,
            )
            .get(id);
          if (exists) result.duplicate++;
          const serialized = JSON.stringify(row);
          if ("tradeDate" in row) {
            this.db
              .prepare(
                "INSERT INTO trade_fills_claims (id,account,symbol,code,trade_date,batch_id,payload) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id,batch_id) DO NOTHING",
              )
              .run(
                id,
                account,
                row.symbol,
                row.code,
                row.tradeDate,
                batchId,
                serialized,
              );
            this.db
              .prepare(
                "INSERT INTO trade_fills_canonical (id,payload) VALUES (?,?) ON CONFLICT(id) DO NOTHING",
              )
              .run(id, serialized);
            if (!exists) result.fills++;
          } else {
            this.db
              .prepare(
                "INSERT INTO cash_flows_claims (id,account,flow_date,batch_id,payload) VALUES (?,?,?,?,?) ON CONFLICT(id,batch_id) DO NOTHING",
              )
              .run(id, account, row.flowDate, batchId, serialized);
            this.db
              .prepare(
                "INSERT INTO cash_flows_canonical (id,payload) VALUES (?,?) ON CONFLICT(id) DO NOTHING",
              )
              .run(id, serialized);
            if (!exists) result.cashFlows++;
          }
        };
        input.parsed.fills.forEach((row) => insert(row, "fill"));
        input.parsed.cashFlows.forEach((row) => insert(row, "cashFlow"));
        payload.receipt = {
          fills: result.fills,
          cashFlows: result.cashFlows,
          duplicate: result.duplicate,
        };
        this.db
          .prepare("UPDATE import_batches SET payload=? WHERE id=?")
          .run(JSON.stringify(payload), batchId);
        if (result.duplicate) result.diagnostics = [...payload.diagnostics];
        return result;
      })
      .immediate();
  }

  batches(includeRevoked = true): ImportBatch[] {
    return (
      this.db
        .prepare(
          `SELECT id,account,source,file_hash AS fileHash,file_name AS fileName,imported_at AS importedAt,
            revoked_at AS revokedAt,CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END status,payload
           FROM delivery_batches ${includeRevoked ? "" : "WHERE revoked_at IS NULL"} ORDER BY imported_at,id`,
        )
        .all() as (Omit<ImportBatch, "payload"> & { payload: string })[]
    ).map((row) => ({
      ...row,
      payload: JSON.parse(row.payload) as BatchPayload,
    }));
  }

  fills(account?: string): Stored<ParsedFill>[] {
    return this.readRows<ParsedFill>(
      "trade_fills",
      "trade_date,code,id",
      account,
    );
  }

  cashFlows(account?: string): Stored<ParsedCashFlow>[] {
    return this.readRows<ParsedCashFlow>("cash_flows", "flow_date,id", account);
  }

  private readRows<T>(
    table: string,
    order: string,
    account?: string,
  ): Stored<T>[] {
    return (
      this.db
        .prepare(
          `SELECT id,account,batch_id AS batchId,payload FROM ${table}${account === undefined ? "" : " WHERE account=?"} ORDER BY ${order}`,
        )
        .all(...(account === undefined ? [] : [account])) as {
        id: string;
        account: string;
        batchId: string;
        payload: string;
      }[]
    ).map(({ payload, ...row }) => ({ ...(JSON.parse(payload) as T), ...row }));
  }

  revokeBatch(batchId: string) {
    return this.db
      .transaction(() => {
        const impact = (table: DeliveryFactTable) => {
          const { count } = this.db
            .prepare(
              `SELECT count(*) count FROM ${table} f WHERE f.batch_id=? AND ${exclusiveDeliveryRow(table)}`,
            )
            .get(batchId) as { count: number };
          if (count) {
            const uncertain = this.db
              .prepare(
                `SELECT u.batch_id FROM delivery_uncertain_claims u
               JOIN import_batches other ON other.id=u.batch_id
               JOIN import_batches target ON target.account=other.account
               WHERE target.id=? AND other.id<>target.id AND u.fact_table=? LIMIT 1`,
              )
              .get(batchId, table) as { batch_id: string } | undefined;
            if (uncertain)
              throw new Error(
                `交割单归属冲突：历史批次 ${uncertain.batch_id} 缺少逐行归属记录，已保留全部数据`,
              );
          }
          return count;
        };
        const fills = impact("trade_fills");
        const cashFlows = impact("cash_flows");
        // Each batch keeps its own claim payload. Revoking the first batch must
        // not rewrite another batch's original row index or evidence.
        const batches = this.db
          .prepare(
            "UPDATE delivery_batches SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
          )
          .run(Date.now(), batchId).changes;
        // Once no active batch claims a fact, drop its canonical projection so a
        // later reimport can establish fresh economics.
        for (const table of ["trade_fills", "cash_flows"] as const)
          this.db
            .prepare(
              `DELETE FROM ${table}_canonical WHERE id IN (
                 SELECT c.id FROM ${table}_claims c WHERE c.batch_id=?
                 AND NOT EXISTS (
                   SELECT 1 FROM ${table}_claims other
                   JOIN import_batches active ON active.id=other.batch_id
                   WHERE other.id=c.id))`,
            )
            .run(batchId);
        return { fills, cashFlows, batches };
      })
      .immediate();
  }
}
