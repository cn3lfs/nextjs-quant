import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  poolEntrySources,
  poolEntryStatuses,
  poolSyncSnapshotSchema,
} from "trading-strategies";
import { z } from "zod";
import { getDeployment } from "./deployment-repository";
import { appendExecutionAuditEvent, jsonSchema } from "./execution-audit";
import { sqlite } from "./index";

const textSchema = z.string().trim().min(1);
const dateSchema = z.string().date();
const countSchema = z.number().int().safe().nonnegative();
const statusSchema = z.enum(poolEntryStatuses);
const sourceSchema = z.enum(poolEntrySources);
const actionSchema = z.enum(["BUY", "SELL", "HOLD"]);
const priceSchema = z.number().finite().positive();
const metricsSchema = z.record(jsonSchema);

const cnSymbolPattern = /^(sh|sz|bj)\d{6}$/i;
export function normalizePoolSymbol(symbol: string): string {
  const trimmed = symbol.trim();
  return cnSymbolPattern.test(trimmed)
    ? trimmed.toLowerCase()
    : trimmed.toUpperCase();
}
const symbolSchema = textSchema.transform(normalizePoolSymbol);

const entrySchema = z
  .object({
    id: textSchema,
    deploymentId: textSchema,
    symbol: textSchema,
    status: statusSchema,
    source: sourceSchema,
    enteredDate: dateSchema,
    lastMatchedDate: dateSchema,
    lastCheckedDate: dateSchema,
    consecutiveMissedDays: countSchema,
    entryPrice: priceSchema.nullable(),
    entryReason: z.string(),
    lastMetrics: metricsSchema,
    evictedDate: dateSchema.nullable(),
    evictReason: z.string().nullable(),
    lastSignalDate: dateSchema.nullable(),
    lastSignalAction: actionSchema.nullable(),
    createdAt: countSchema,
    updatedAt: countSchema,
  })
  .strict();

export type PoolEntryRecord = z.infer<typeof entrySchema>;
type PoolEntryRow = Omit<PoolEntryRecord, "lastMetrics"> & {
  lastMetricsJson: string;
};

const columns = `id,deployment_id AS deploymentId,symbol,status,source,
  entered_date AS enteredDate,last_matched_date AS lastMatchedDate,
  last_checked_date AS lastCheckedDate,
  consecutive_missed_days AS consecutiveMissedDays,entry_price AS entryPrice,
  entry_reason AS entryReason,last_metrics_json AS lastMetricsJson,
  evicted_date AS evictedDate,evict_reason AS evictReason,
  last_signal_date AS lastSignalDate,last_signal_action AS lastSignalAction,
  created_at AS createdAt,updated_at AS updatedAt`;

function decodeEntry({
  lastMetricsJson,
  ...row
}: PoolEntryRow): PoolEntryRecord {
  return entrySchema.parse({
    ...row,
    lastMetrics: JSON.parse(lastMetricsJson),
  });
}

const listOptionsSchema = z
  .object({
    status: statusSchema.optional(),
    limit: z.number().int().min(1).max(1000).default(50),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();
const cursorSchema = z.tuple([countSchema, textSchema]);

export function listPoolEntries(
  deploymentId: string,
  options: z.input<typeof listOptionsSchema> = {},
  connection: Database.Database = sqlite(),
) {
  const id = textSchema.parse(deploymentId);
  const { status, limit, cursor } = listOptionsSchema.parse(options);
  const after = cursor
    ? cursorSchema.parse(
        JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
      )
    : [];
  const rows = connection
    .prepare<(string | number)[], PoolEntryRow>(
      `SELECT ${columns} FROM deployment_pool_entries WHERE deployment_id=?
     ${status ? "AND status=?" : ""}
     ${cursor ? "AND (updated_at,id) < (?,?)" : ""}
     ORDER BY updated_at DESC,id DESC LIMIT ?`,
    )
    .all(id, ...(status ? [status] : []), ...after, limit + 1);
  const items = rows.slice(0, limit).map(decodeEntry);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify([last.updatedAt, last.id])).toString(
            "base64url",
          )
        : null,
  };
}

export function getActivePoolEntries(
  deploymentId: string,
  connection: Database.Database = sqlite(),
) {
  return connection
    .prepare<[string], PoolEntryRow>(
      `SELECT ${columns} FROM deployment_pool_entries WHERE deployment_id=? AND status='watching'
     ORDER BY entered_date ASC,symbol ASC`,
    )
    .all(textSchema.parse(deploymentId))
    .map(decodeEntry);
}

const snapshot = poolSyncSnapshotSchema.innerType().shape;
const optionalMetrics = metricsSchema.optional();
const syncBatchSchema = z
  .object({
    asOf: dateSchema,
    added: z.array(
      snapshot.added.element.extend({
        symbol: symbolSchema,
        metrics: optionalMetrics,
      }),
    ),
    retained: z.array(
      z.union([
        symbolSchema.transform((symbol) => ({ symbol, metrics: undefined })),
        z.object({ symbol: symbolSchema, metrics: optionalMetrics }).strict(),
      ]),
    ),
    missedGrace: z.array(
      snapshot.missedGrace.element.extend({
        symbol: symbolSchema,
        consecutiveMissedDays: countSchema.positive(),
        metrics: optionalMetrics,
      }),
    ),
    evicted: z.array(
      snapshot.evicted.element.extend({ symbol: symbolSchema }).strict(),
    ),
  })
  .strict()
  .refine(({ added, retained, missedGrace, evicted }) => {
    const keys = [...added, ...retained, ...missedGrace, ...evicted].map(
      ({ symbol }) => symbol.toUpperCase(),
    );
    return new Set(keys).size === keys.length;
  }, "监控池同步批次内的证券代码不能重复");

const upsertEntry = `INSERT INTO deployment_pool_entries (
  id,deployment_id,symbol,status,source,entered_date,last_matched_date,last_checked_date,
  entry_price,entry_reason,last_metrics_json,created_at,updated_at
) VALUES (
  @id,@deploymentId,@symbol,'watching',@source,@asOf,@asOf,@asOf,
  @entryPrice,@reason,@metricsJson,@now,@now
) ON CONFLICT(deployment_id,symbol) DO UPDATE SET
  symbol=excluded.symbol,status='watching',source=excluded.source,
  entered_date=excluded.entered_date,last_matched_date=excluded.last_matched_date,
  last_checked_date=excluded.last_checked_date,consecutive_missed_days=0,
  entry_price=COALESCE(excluded.entry_price,deployment_pool_entries.entry_price),entry_reason=excluded.entry_reason,
  last_metrics_json=excluded.last_metrics_json,updated_at=excluded.updated_at,
  evicted_date=NULL,evict_reason=NULL`;

const evictEntry = `UPDATE deployment_pool_entries SET
  status='evicted',evicted_date=@asOf,last_checked_date=@asOf,evict_reason=@reason,updated_at=@now
  WHERE deployment_id=@deploymentId AND symbol=@symbol`;

function activePoolCount(deploymentId: string, connection: Database.Database) {
  return connection
    .prepare<[string], { total: number }>(
      "SELECT count(*) AS total FROM deployment_pool_entries WHERE deployment_id=? AND status='watching'",
    )
    .get(deploymentId)!.total;
}

function assertMonotonicDate(
  deploymentId: string,
  symbol: string,
  asOf: string,
  connection: Database.Database,
) {
  const stale = connection
    .prepare(
      `SELECT 1 FROM deployment_pool_entries
       WHERE deployment_id=@deploymentId AND symbol=@symbol
         AND (last_checked_date>@asOf OR last_matched_date>@asOf OR evicted_date>@asOf)`,
    )
    .get({ deploymentId, symbol, asOf });
  if (stale) {
    throw new Error(`监控池同步日期 ${asOf} 早于标的 ${symbol} 的最近记录日期`);
  }
}

function assertPoolCapacity(
  deploymentId: string,
  connection: Database.Database,
  options?: { allowShrinkingFrom?: number; addedCount?: number },
) {
  const deployment = getDeployment(deploymentId, connection);
  if (!deployment) throw new Error(`策略部署不存在：${deploymentId}`);
  const { maxPoolSize } = deployment.poolPolicy.eviction;
  const total = activePoolCount(deploymentId, connection);
  if (total <= maxPoolSize) return;
  if (
    options?.allowShrinkingFrom !== undefined &&
    (options.addedCount ?? 0) === 0 &&
    total < options.allowShrinkingFrom
  ) {
    return;
  }
  throw new Error(`监控池在监标的数量 ${total} 超过上限 ${maxPoolSize}`);
}

export function applyPoolSyncBatch(
  deploymentId: string,
  raw: z.input<typeof syncBatchSchema>,
  connection: Database.Database = sqlite(),
) {
  const id = textSchema.parse(deploymentId);
  const { asOf, added, retained, missedGrace, evicted } =
    syncBatchSchema.parse(raw);
  return connection
    .transaction(() => {
      const beforeTotal = activePoolCount(id, connection);
      const context = { deploymentId: id, asOf, now: Date.now() };
      const counts = { added: 0, retained: 0, missedGrace: 0, evicted: 0 };
      for (const { symbol } of [
        ...added,
        ...retained,
        ...missedGrace,
        ...evicted,
      ]) {
        assertMonotonicDate(id, symbol, asOf, connection);
      }

      const add = connection.prepare(
        `${upsertEntry} WHERE deployment_pool_entries.status='evicted'`,
      );
      const refresh = connection.prepare(`UPDATE deployment_pool_entries SET
      last_matched_date=COALESCE(@matchedDate,last_matched_date),
      last_checked_date=@asOf,
      consecutive_missed_days=@consecutiveMissedDays,
      last_metrics_json=COALESCE(@metricsJson,last_metrics_json),updated_at=@now
      WHERE deployment_id=@deploymentId AND symbol=@symbol AND status='watching'`);
      const evict = connection.prepare(`${evictEntry} AND status='watching'`);

      for (const { symbol, reason, price, score, metrics } of added) {
        counts.added += add.run({
          ...context,
          id: randomUUID(),
          source: "screener",
          symbol,
          reason,
          entryPrice: price,
          metricsJson: JSON.stringify(
            metrics ?? (score === null ? {} : { score }),
          ),
        }).changes;
      }
      for (const { symbol, metrics } of retained) {
        counts.retained += refresh.run({
          ...context,
          symbol,
          matchedDate: asOf,
          consecutiveMissedDays: 0,
          metricsJson: metrics === undefined ? null : JSON.stringify(metrics),
        }).changes;
      }
      for (const { symbol, consecutiveMissedDays, metrics } of missedGrace) {
        counts.missedGrace += refresh.run({
          ...context,
          symbol,
          matchedDate: null,
          consecutiveMissedDays,
          metricsJson: metrics === undefined ? null : JSON.stringify(metrics),
        }).changes;
      }
      for (const entry of evicted) {
        counts.evicted += evict.run({ ...context, ...entry }).changes;
      }
      assertPoolCapacity(id, connection, {
        allowShrinkingFrom: beforeTotal,
        addedCount: counts.added,
      });
      appendExecutionAuditEvent(
        {
          deploymentId: id,
          eventType: "pool_synced",
          details: { asOf, ...counts },
          createdAt: context.now,
        },
        connection,
      );
      return counts;
    })
    .immediate();
}

const manualAddSchema = z
  .object({
    symbol: symbolSchema,
    asOf: dateSchema,
    entryPrice: priceSchema.nullable().default(null),
    reason: textSchema.default("手动入池"),
    metrics: metricsSchema.default({}),
  })
  .strict();

export function manualAddPoolEntry(
  deploymentId: string,
  raw: z.input<typeof manualAddSchema>,
  connection: Database.Database = sqlite(),
) {
  const id = textSchema.parse(deploymentId);
  const { symbol, asOf, entryPrice, reason, metrics } =
    manualAddSchema.parse(raw);
  return connection
    .transaction(() => {
      assertMonotonicDate(id, symbol, asOf, connection);
      const now = Date.now();
      const row = connection
        .prepare<object, PoolEntryRow>(`${upsertEntry} RETURNING ${columns}`)
        .get({
          id: randomUUID(),
          deploymentId: id,
          symbol,
          asOf,
          entryPrice,
          reason,
          source: "manual",
          metricsJson: JSON.stringify(metrics),
          now,
        })!;
      assertPoolCapacity(id, connection);
      appendExecutionAuditEvent(
        {
          deploymentId: id,
          eventType: "pool_manual_added",
          details: { symbol, asOf, reason },
          createdAt: now,
        },
        connection,
      );
      return decodeEntry(row);
    })
    .immediate();
}

const manualEvictSchema = z
  .object({
    asOf: dateSchema,
    reason: textSchema.default("手动移出监控池"),
  })
  .strict();

export function manualEvictPoolEntry(
  deploymentId: string,
  symbol: string,
  raw: z.input<typeof manualEvictSchema>,
  connection: Database.Database = sqlite(),
) {
  const id = textSchema.parse(deploymentId);
  const entrySymbol = symbolSchema.parse(symbol);
  const { asOf, reason } = manualEvictSchema.parse(raw);
  return connection
    .transaction(() => {
      assertMonotonicDate(id, entrySymbol, asOf, connection);
      const now = Date.now();
      const row = connection
        .prepare<object, PoolEntryRow>(`${evictEntry} RETURNING ${columns}`)
        .get({ deploymentId: id, symbol: entrySymbol, asOf, reason, now });
      if (!row) throw new Error(`监控池条目不存在：${entrySymbol}`);
      appendExecutionAuditEvent(
        {
          deploymentId: id,
          eventType: "pool_manual_evicted",
          details: { symbol: entrySymbol, asOf, reason },
          createdAt: now,
        },
        connection,
      );
      return decodeEntry(row);
    })
    .immediate();
}

const signalSchema = z
  .object({ signalDate: dateSchema, action: actionSchema })
  .strict();

export function recordPoolEntrySignal(
  deploymentId: string,
  symbol: string,
  raw: z.input<typeof signalSchema>,
  connection: Database.Database = sqlite(),
) {
  const id = textSchema.parse(deploymentId);
  const entrySymbol = symbolSchema.parse(symbol);
  const signal = signalSchema.parse(raw);
  const row = connection
    .prepare<object, PoolEntryRow>(
      `UPDATE deployment_pool_entries SET last_signal_date=@signalDate,
     last_signal_action=@action,updated_at=@now WHERE deployment_id=@deploymentId AND symbol=@symbol
     RETURNING ${columns}`,
    )
    .get({ ...signal, deploymentId: id, symbol: entrySymbol, now: Date.now() });
  if (!row) throw new Error(`监控池条目不存在：${entrySymbol}`);
  return decodeEntry(row);
}
