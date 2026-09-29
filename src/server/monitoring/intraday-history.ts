import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  intradayHistorySchema,
  intradayRunsSchema,
  type IntradayRunsInput,
  type IntradayHistoryInput,
} from "~/lib/strategy-facts/intraday-history";

export type IntradaySummary = {
  id: string;
  at: number;
  sessionId: string;
  symbol: string;
  barCutoff: string;
  rps: number;
  rpsDate: string;
  source: string;
  signalCount: number;
  state: "pending" | "retry" | "settled";
};

/** Lists metadata only. Full bars and close evidence remain in immutable records. */
export function intradayHistory(
  db: Database.Database,
  input: IntradayHistoryInput,
) {
  const { cursor, ...filter } = intradayHistorySchema.parse(input);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(filter))
    .digest("hex");
  if (cursor && cursor.filter !== fingerprint)
    throw new Error("分页条件已变化，请重新查询");
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  if (filter.from) {
    conditions.push("barCutoff >= ?");
    values.push(`${filter.from}T00:00:00+08:00`);
  }
  if (filter.to) {
    conditions.push("barCutoff <= ?");
    values.push(`${filter.to}T23:59:59+08:00`);
  }
  if (filter.symbol) {
    conditions.push("symbol = ?");
    values.push(filter.symbol);
  }
  if (filter.sessionId) {
    conditions.push("sessionId = ?");
    values.push(filter.sessionId);
  }
  if (filter.slot) {
    conditions.push("slot = ?");
    values.push(filter.slot);
  }
  if (filter.signalsOnly) conditions.push("signalCount > 0");
  if (filter.state) {
    conditions.push("state = ?");
    values.push(filter.state);
  }
  const where = conditions.length ? conditions.join(" AND ") : "1";
  const pageValues = cursor ? [cursor.at, cursor.at, cursor.id] : [];
  const sql = `WITH closes AS MATERIALIZED (
    SELECT CAST(json_extract(payload,'$.observationId') AS TEXT) observationId,
      MAX(CASE WHEN json_type(payload,'$.close.signalKeys')='array' THEN 1 ELSE 0 END) settled
    FROM records WHERE kind='intraday-close' AND json_valid(payload)
    GROUP BY observationId
  ), metadata AS MATERIALIZED (
    SELECT id,updated_at at,
      jsonb(json_extract(payload,'$.sessionId','$.snapshot.symbol','$.barCutoff','$.rps','$.rpsDate','$.snapshot.source')) value,
      COALESCE(json_array_length(payload,'$.signals'),0) signalCount
    FROM records WHERE kind='intraday-preview' AND json_valid(payload)
  ), source AS MATERIALIZED (
    SELECT p.id,p.at,json_extract(p.value,'$[0]') sessionId,
      json_extract(p.value,'$[1]') symbol,json_extract(p.value,'$[2]') barCutoff,
      json_extract(p.value,'$[3]') rps,json_extract(p.value,'$[4]') rpsDate,
      json_extract(p.value,'$[5]') source,p.signalCount,
      ${filter.slot ? "json_extract(r.payload,'$.slot')" : "NULL"} slot,
      CASE WHEN c.settled=1 THEN 'settled' WHEN c.observationId IS NOT NULL THEN 'retry' ELSE 'pending' END state
    FROM metadata p LEFT JOIN closes c ON c.observationId=p.id
    ${filter.slot ? "LEFT JOIN records r ON r.id=json_extract(p.value,'$[0]') AND r.kind='intraday-run'" : ""}
  ), filtered AS MATERIALIZED (SELECT * FROM source WHERE ${where}),
  page AS (SELECT * FROM filtered ${cursor ? "WHERE (at < ? OR (at = ? AND id < ?))" : ""} ORDER BY at DESC,id DESC LIMIT 21)
  SELECT (SELECT count(*) FROM filtered) total,
    (SELECT count(*) FROM source) totalAll,
    (SELECT count(*) FROM filtered WHERE signalCount>0) candidates,
    (SELECT count(*) FROM filtered WHERE state='pending') pending,
    (SELECT count(*) FROM filtered WHERE state='retry') retry,
    (SELECT count(*) FROM filtered WHERE state='settled') settled,
    (SELECT json_group_array(json_object('id',id,'at',at,'sessionId',sessionId,'symbol',symbol,'barCutoff',barCutoff,'rps',rps,'rpsDate',rpsDate,'source',source,'signalCount',signalCount,'state',state)) FROM page) rows`;
  const result = db.prepare(sql).get(...values, ...pageValues) as {
    total: number;
    totalAll: number;
    candidates: number;
    pending: number;
    retry: number;
    settled: number;
    rows: string;
  };
  const all = JSON.parse(result.rows) as IntradaySummary[];
  const rows = all.slice(0, 20);
  const last = rows.at(-1);
  return {
    rows,
    total: result.total,
    totalAll: result.totalAll,
    stats: {
      candidates: result.candidates,
      pending: result.pending,
      retry: result.retry,
      settled: result.settled,
    },
    nextCursor:
      all.length > 20 && last
        ? { at: last.at, id: last.id, filter: fingerprint }
        : null,
  };
}

export type IntradayRunSummary = {
  id: string;
  date: string;
  slot: "noon" | "late";
  status: "running" | "complete" | "partial" | "failed" | "missed";
  startedAt: number;
  updatedAt: number;
  evaluated: number;
  poolSize: number;
  error: string | null;
};
export function intradayRuns(db: Database.Database, input: IntradayRunsInput) {
  const { cursor, ...filter } = intradayRunsSchema.parse(input);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(filter))
    .digest("hex");
  if (cursor && cursor.filter !== fingerprint)
    throw new Error("分页条件已变化，请重新查询");
  const where: string[] = [];
  const values: (string | number)[] = [];
  for (const [key, operator, value] of [
    ["date", ">=", filter.from],
    ["date", "<=", filter.to],
    ["slot", "=", filter.slot],
    ["status", "=", filter.status],
  ] as const) {
    if (value) {
      where.push(`${key} ${operator} ?`);
      values.push(value);
    }
  }
  const row = db
    .prepare(
      `WITH source AS MATERIALIZED (
    SELECT id,json_extract(payload,'$.date') date,json_extract(payload,'$.slot') slot,
    json_extract(payload,'$.status') status,json_extract(payload,'$.startedAt') startedAt,
    updated_at updatedAt,COALESCE(json_array_length(payload,'$.results'),0) evaluated,
    COALESCE(json_array_length(payload,'$.pool.rows'),0) poolSize,json_extract(payload,'$.error') error
    FROM records WHERE kind='intraday-run' AND json_valid(payload)
  ), filtered AS MATERIALIZED (SELECT * FROM source WHERE ${where.join(" AND ") || "1"}),
  page AS (SELECT * FROM filtered ${cursor ? "WHERE (startedAt < ? OR (startedAt = ? AND id < ?))" : ""} ORDER BY startedAt DESC,id DESC LIMIT 21)
  SELECT (SELECT count(*) FROM filtered) total,
    (SELECT json_group_array(json_object('id',id,'date',date,'slot',slot,'status',status,'startedAt',startedAt,'updatedAt',updatedAt,'evaluated',evaluated,'poolSize',poolSize,'error',error)) FROM page) rows
  `,
    )
    .get(...values, ...(cursor ? [cursor.at, cursor.at, cursor.id] : [])) as {
    total: number;
    rows: string;
  };
  const all = JSON.parse(row.rows) as IntradayRunSummary[];
  const rows = all.slice(0, 20);
  const last = rows.at(-1);
  return {
    rows,
    total: row.total,
    nextCursor:
      all.length > 20 && last
        ? { at: last.startedAt, id: last.id, filter: fingerprint }
        : null,
  };
}
