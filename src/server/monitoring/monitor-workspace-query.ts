import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  deliveryPageSchema,
  deliveryStatus,
  monitorPageSchema,
  signalPageSchema,
  monitorWorkspaceId,
  deliveryOutcomeCounts,
} from "~/lib/strategy-facts/monitor-workspace";
import type { Channel, Delivery, Monitor, Signal } from "~/lib/domain";
import type { NotificationDecision } from "~/lib/strategy-facts/notification-policy";
import {
  monitorConfigurationVersion,
  channelDestinationVersion,
} from "./monitor-workspace-actions";

const positionSchema = z.object({
  key: z.string(),
  time: z.number().finite(),
  id: monitorWorkspaceId,
});
function position(kind: string, input: { cursor?: string }) {
  const { cursor, ...filters } = input;
  const key = createHash("sha256")
    .update(JSON.stringify({ kind, ...filters }))
    .digest("hex");
  if (!cursor) return { key, time: null, id: null };
  try {
    const value = positionSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString()),
    );
    if (value.key !== key) throw new Error();
    return value;
  } catch {
    throw new Error("分页位置或筛选条件已变化，请重新查询");
  }
}
function finish<T extends { id: string; createdAt: number }>(
  rows: T[],
  key: string,
) {
  const items = rows.slice(0, 20),
    last = items.at(-1),
    hasMore = rows.length > 20;
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ key, time: last.createdAt, id: last.id }),
          ).toString("base64url")
        : null,
  };
}
const before = (time: number | null) =>
  time === null
    ? "(@time IS NULL)"
    : "(createdAt<=@time AND (createdAt<@time OR (createdAt=@time AND id<@id)))";
const dateLimits = (input: { from?: string; to?: string }) => ({
  from: input.from ? Date.parse(`${input.from}T00:00:00+08:00`) : null,
  to: input.to ? Date.parse(`${input.to}T00:00:00+08:00`) + 86400000 : null,
});
const dateWhere =
  "(@from IS NULL OR createdAt>=@from) AND (@to IS NULL OR createdAt<@to)";
const field = (name: string) => `json_extract(payload,'$.${name}')`;

export function monitorWorkspacePage(db: Database.Database, raw: unknown) {
  const input = monitorPageSchema.parse(raw),
    p = position("monitor", input);
  const rows = db
    .prepare(
      `WITH summaries AS (
 SELECT id,${field("createdAt")} createdAt,${field("name")} name,${field("enabled")} enabled,
 COALESCE(${field("strategy.type")},'ma-cross') strategyType,${field("strategy.name")} strategyName,
 ${field("symbols")} symbols,${field("period")} period,${field("source")} source,
 ${field("lastCheck")} lastCheck,substr(${field("error")},1,300) error,
 json_array_length(payload,'$.channels') channelCount
 FROM records WHERE kind='monitor') SELECT * FROM summaries WHERE ${before(p.time)}
 AND (@enabled IS NULL OR enabled=@enabled) AND (@strategy IS NULL OR strategyType=@strategy)
 AND (@symbol='' OR EXISTS(SELECT 1 FROM json_each(symbols) WHERE value=@symbol))
 AND (instr(lower(name),lower(@query))>0 OR instr(lower(symbols),lower(@query))>0)
 ORDER BY createdAt DESC,id DESC LIMIT 21`,
    )
    .all({
      time: p.time,
      id: p.id,
      enabled: input.enabled === undefined ? null : Number(input.enabled),
      strategy: input.strategy ?? null,
      symbol: input.symbol ?? "",
      query: input.query,
    }) as {
    id: string;
    createdAt: number;
    name: string;
    enabled: number;
    strategyType: string;
    strategyName: string;
    symbols: string;
    period: Monitor["period"];
    source: Monitor["source"];
    lastCheck: number | null;
    error: string | null;
    channelCount: number;
  }[];
  return finish(
    rows.map((row) => ({
      ...row,
      enabled: !!row.enabled,
      symbols: JSON.parse(row.symbols) as string[],
    })),
    p.key,
  );
}

function readSignalWorkspacePage(db: Database.Database, raw: unknown) {
  const input = signalPageSchema.parse(raw),
    p = position("signal", input);
  const rows = db
    .prepare(
      `WITH summaries AS (
 SELECT id,${field("createdAt")} createdAt,${field("monitorId")} monitorId,${field("symbol")} symbol,
 COALESCE(${field("strategy.type")},'ma-cross') strategyType,${field("strategy.name")} strategyName,
 ${field("period")} period,${field("date")} date,${field("source")} source,${field("metrics.close")} close,${field("tradingStatusEvidence.status")} tradingStatus
 FROM records WHERE kind='signal') SELECT * FROM summaries WHERE ${before(p.time)} AND ${dateWhere}
 AND (@monitor IS NULL OR monitorId=@monitor) AND (@symbol='' OR symbol=@symbol)
 AND (@strategy IS NULL OR strategyType=@strategy)
 AND (instr(lower(symbol),lower(@query))>0 OR instr(lower(strategyName),lower(@query))>0 OR instr(lower(id),lower(@query))>0)
 ORDER BY createdAt DESC,id DESC LIMIT 21`,
    )
    .all({
      time: p.time,
      id: p.id,
      ...dateLimits(input),
      monitor: input.monitorId ?? null,
      symbol: input.symbol ?? "",
      strategy: input.strategy ?? null,
      query: input.query,
    }) as {
    id: string;
    createdAt: number;
    monitorId: string;
    symbol: string;
    strategyType: string;
    strategyName: string;
    period: Signal["period"];
    date: string;
    source: string;
    close: number;
    tradingStatus:
      NonNullable<Signal["tradingStatusEvidence"]>["status"] | null;
  }[];
  const result = finish(rows, p.key);
  const outcomes = signalDeliveryCounts(
    db,
    result.items.map((row) => row.id),
  );
  return {
    ...result,
    items: result.items.map((row) => ({
      ...row,
      deliveries: outcomes.get(row.id) ?? deliveryOutcomeCounts([]),
    })),
  };
}

export function signalWorkspacePage(db: Database.Database, raw: unknown) {
  return db.transaction(() => readSignalWorkspacePage(db, raw))();
}

/** A summary delivery is associated with each member once, including its primary signal. */
export function signalDeliveryCounts(
  db: Database.Database,
  ids: readonly string[],
) {
  const results = new Map(ids.map((id) => [id, deliveryOutcomeCounts([])]));
  if (!ids.length) return results;
  const rows = db
    .prepare(
      `WITH wanted AS (SELECT value id FROM json_each(@ids)),
 links AS (
 SELECT records.id deliveryId,${field("signalId")} signalId,${field("status")} status
 FROM records WHERE kind='delivery' AND ${field("signalId")} IN (SELECT id FROM wanted)
 UNION
 SELECT records.id deliveryId,j.value signalId,${field("status")} status
 FROM records,json_each(json_extract(records.payload,'$.summarySignalIds')) j
 WHERE records.kind='delivery' AND json_type(records.payload,'$.summarySignalIds')='array' AND j.value IN (SELECT id FROM wanted)
 ) SELECT signalId,status,count(*) count FROM links GROUP BY signalId,status`,
    )
    .all({ ids: JSON.stringify(ids) }) as {
    signalId: string;
    status: string;
    count: number;
  }[];
  for (const row of rows) {
    const state = deliveryStatus.safeParse(row.status);
    if (state.success) results.get(row.signalId)![state.data] = row.count;
  }
  return results;
}

export function deliveryWorkspacePage(db: Database.Database, raw: unknown) {
  const input = deliveryPageSchema.parse(raw),
    p = position("delivery", input);
  const rows = db
    .prepare(
      `WITH summaries AS (
 SELECT id,${field("createdAt")} createdAt,${field("signalId")} signalId,${field("channelId")} channelId,
 ${field("kind")} deliveryKind,${field("title")} title,${field("status")} status,
 ${field("attempts")} attempts,${field("nextAt")} nextAt,${field("expiresAt")} expiresAt,
 ${field("manualRetry")} manualRetry,${field("sourceDeliveryId")} sourceDeliveryId,
 substr(${field("error")},1,300) error,${field("summarySignalIds")} summarySignalIds
 FROM records WHERE kind='delivery') SELECT id,createdAt,signalId,channelId,deliveryKind,title,status,attempts,nextAt,expiresAt,manualRetry,sourceDeliveryId,error
 FROM summaries WHERE ${before(p.time)} AND ${dateWhere}
 AND (@signal IS NULL OR signalId=@signal OR EXISTS(SELECT 1 FROM json_each(summarySignalIds) WHERE value=@signal))
 AND (@channel IS NULL OR channelId=@channel) AND (@status IS NULL OR status=@status)
 AND (@kind IS NULL OR deliveryKind=@kind)
 AND (instr(lower(title),lower(@query))>0 OR instr(lower(id),lower(@query))>0)
 ORDER BY createdAt DESC,id DESC LIMIT 21`,
    )
    .all({
      time: p.time,
      id: p.id,
      ...dateLimits(input),
      signal: input.signalId ?? null,
      channel: input.channelId ?? null,
      status: input.status ?? null,
      kind: input.kind ?? null,
      query: input.query,
    }) as {
    id: string;
    createdAt: number;
    signalId: string;
    channelId: string;
    deliveryKind: Delivery["kind"];
    title: string;
    status: Delivery["status"];
    attempts: number;
    nextAt: number;
    expiresAt: number;
    manualRetry: number | null;
    sourceDeliveryId: string | null;
    error: string | null;
  }[];
  return finish(
    rows.map((row) => ({ ...row, manualRetry: !!row.manualRetry })),
    p.key,
  );
}

function readMonitorWorkspaceSummary(db: Database.Database, now = Date.now()) {
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10),
    from = Date.parse(`${today}T00:00:00+08:00`),
    to = from + 86400000;
  const count = (
    kind: string,
    condition: string,
    params: Record<string, number> = {},
  ) =>
    (
      db
        .prepare(
          `SELECT count(*) count FROM records WHERE kind='${kind}' AND ${condition}`,
        )
        .get(params) as { count: number }
    ).count;
  // All static clauses; no user-defined SQL identifiers or expressions.
  const result = {
    today,
    assessedAt: now,
    enabledMonitors: count("monitor", `${field("enabled")}=1`),
    todaySignals: count(
      "signal",
      `${field("createdAt")}>=@from AND ${field("createdAt")}<@to`,
      { from, to },
    ),
    todaySent: count(
      "delivery",
      `${field("status")}='sent' AND ${field("createdAt")}>=@from AND ${field("createdAt")}<@to`,
      { from, to },
    ),
    failedDeliveries: count("delivery", `${field("status")}='failed'`),
    activeDeliveries: count(
      "delivery",
      `${field("status")} IN ('pending','sending')`,
    ),
    pausedSymbolInstances: (
      db
        .prepare(
          `SELECT count(*) count FROM records,json_each(records.payload,'$.tradingStatusChecks') checks WHERE records.kind='monitor' AND json_extract(checks.value,'$.status')<>'trading'`,
        )
        .get() as { count: number }
    ).count,
  };
  return result;
}

export function monitorWorkspaceSummary(
  db: Database.Database,
  now = Date.now(),
) {
  return db.transaction(() => readMonitorWorkspaceSummary(db, now))();
}

function detail<T>(
  db: Database.Database,
  kind: string,
  raw: unknown,
): T | null {
  const id = monitorWorkspaceId.parse(raw);
  const row = db
    .prepare("SELECT payload FROM records WHERE kind=? AND id=?")
    .get(kind, id) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as T) : null;
}
export function monitorWorkspaceDetail(db: Database.Database, id: unknown) {
  const value = detail<Monitor>(db, "monitor", id);
  return value
    ? { ...value, configurationVersion: monitorConfigurationVersion(value) }
    : null;
}
function decisions(
  db: Database.Database,
  where: string,
  params: Record<string, string>,
) {
  return (
    db
      .prepare(
        `SELECT payload FROM records WHERE kind='notification-decision' AND ${where} ORDER BY updated_at,id`,
      )
      .all(params) as { payload: string }[]
  ).map((row) => JSON.parse(row.payload) as NotificationDecision);
}
export function signalWorkspaceDetail(db: Database.Database, id: unknown) {
  const value = detail<Signal>(db, "signal", id);
  return value
    ? {
        ...value,
        decisions: decisions(db, "json_extract(payload,'$.signalId')=@id", {
          id: value.id,
        }),
      }
    : null;
}
export function deliveryWorkspaceDetail(db: Database.Database, id: unknown) {
  const value = detail<Delivery>(db, "delivery", id);
  if (!value) return null;
  const channel = detail<Channel>(db, "channel", value.channelId);
  const target = channel?.target ?? "";
  return {
    ...value,
    channel: channel
      ? {
          id: channel.id,
          name: channel.name,
          type: channel.type,
          enabled: channel.enabled,
          configured: channel.configured,
          targetHint: target
            ? `${target.slice(0, 2)}…${target.slice(-2)}`
            : "机器人绑定目标",
          destinationVersion: channelDestinationVersion(channel),
        }
      : null,
    decisions: decisions(db, "id IN (SELECT value FROM json_each(@ids))", {
      ids: JSON.stringify(value.policyDecisionIds ?? []),
    }),
  };
}
export function monitorWorkspaceExport(
  db: Database.Database,
  kind: "monitor" | "signal" | "delivery",
  id: string,
) {
  return db.transaction(() => {
    if (kind === "monitor")
      return {
        schemaVersion: 1 as const,
        kind,
        value: monitorWorkspaceDetail(db, id),
      };
    if (kind === "delivery")
      return {
        schemaVersion: 1 as const,
        kind,
        value: deliveryWorkspaceDetail(db, id),
      };
    const value = signalWorkspaceDetail(db, id);
    const deliveries = value
      ? (
          db
            .prepare(
              `SELECT payload FROM records WHERE kind='delivery' AND
   (json_extract(payload,'$.signalId')=@id OR EXISTS(SELECT 1 FROM json_each(json_extract(records.payload,'$.summarySignalIds')) WHERE value=@id))
   ORDER BY json_extract(payload,'$.createdAt'),id`,
            )
            .all({ id }) as { payload: string }[]
        ).map((row) => JSON.parse(row.payload) as Delivery)
      : [];
    return { schemaVersion: 1 as const, kind, value, deliveries };
  })();
}
