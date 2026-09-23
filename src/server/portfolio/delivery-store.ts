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

export class DeliveryStore {
  constructor(readonly db: Database.Database) {}

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
        `${prefix}${duplicate} 笔因已存在而跳过，保留先导入的版本；如需保留交割单的过户费，请先导入交割单。`,
      );
    return rows;
  }

  commitImport(input: CommitImportInput): ImportResult {
    const { account, source, scope } = importOptionsSchema.parse(input);
    if (scope === "cashFlowsOnly" && input.parsed.fills.length)
      throw new Error("cashFlowsOnly 批次不能包含成交，请按指定范围重新解析");
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare(
            "SELECT id,payload FROM import_batches WHERE account=? AND file_hash=?",
          )
          .get(account, input.fileHash) as
          { id: string; payload: string } | undefined;
        const metadata = {
          ...(input.parsed.cashFlowSummary
            ? { cashFlowSummary: input.parsed.cashFlowSummary }
            : {}),
          ...(input.parsed.statementOpeningCash !== undefined
            ? { statementOpeningCash: input.parsed.statementOpeningCash }
            : {}),
          ...(input.parsed.counts ? { counts: input.parsed.counts } : {}),
        };
        if (existing) {
          const previous = JSON.parse(existing.payload) as BatchPayload;
          if ((previous.scope ?? "all") !== (scope ?? "all"))
            throw new Error(
              "同一文件已按不同 scope 导入；请先核对并撤销原批次，再选择新的导入范围",
            );
          return {
            ...metadata,
            batchId: existing.id,
            alreadyImported: true,
            fills: 0,
            cashFlows: 0,
            duplicate:
              input.parsed.fills.length + input.parsed.cashFlows.length,
          };
        }
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
          if (exists) {
            result.duplicate++;
            return;
          }
          if ("tradeDate" in row) {
            this.db
              .prepare("INSERT INTO trade_fills VALUES (?,?,?,?,?,?,?)")
              .run(
                id,
                account,
                row.symbol,
                row.code,
                row.tradeDate,
                batchId,
                JSON.stringify(row),
              );
            result.fills++;
          } else {
            this.db
              .prepare("INSERT INTO cash_flows VALUES (?,?,?,?,?)")
              .run(id, account, row.flowDate, batchId, JSON.stringify(row));
            result.cashFlows++;
          }
        };
        input.parsed.fills.forEach((row) => insert(row, "fill"));
        input.parsed.cashFlows.forEach((row) => insert(row, "cashFlow"));
        if (result.duplicate) result.diagnostics = [...payload.diagnostics];
        return result;
      })
      .immediate();
  }

  batches(): ImportBatch[] {
    return (
      this.db
        .prepare(
          "SELECT id,account,source,file_hash AS fileHash,file_name AS fileName,imported_at AS importedAt,payload FROM import_batches ORDER BY imported_at,id",
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
        const fills = this.db
          .prepare("DELETE FROM trade_fills WHERE batch_id=?")
          .run(batchId).changes;
        const cashFlows = this.db
          .prepare("DELETE FROM cash_flows WHERE batch_id=?")
          .run(batchId).changes;
        const batches = this.db
          .prepare("DELETE FROM import_batches WHERE id=?")
          .run(batchId).changes;
        return { fills, cashFlows, batches };
      })
      .immediate();
  }
}
