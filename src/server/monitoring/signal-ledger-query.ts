import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  ledgerHistorySchema,
  ledgerRunsSchema,
  ledgerDecisionsSchema,
  type LedgerHistoryInput,
} from "~/lib/strategy-facts/signal-ledger-query";
import {
  aggregateLedger,
  type LedgerSignal,
  type Outcome,
} from "~/lib/strategy-facts/signal-ledger";
import { signalInformation } from "~/lib/strategy-facts/signal-information";
import type { NotificationDecision } from "~/lib/strategy-facts/notification-policy";
import type { z } from "zod";
import type { LedgerRun } from "./signal-ledger-store";
import { NotificationPolicyStore } from "../infra/notification-policy-store";

const fingerprint = (filter: object) =>
  createHash("sha256").update(JSON.stringify(filter)).digest("hex");
function checkCursor(cursor: { filter: string } | undefined, filter: string) {
  if (cursor && cursor.filter !== filter)
    throw new Error("分页位置与筛选条件不一致，请从第一页查询");
}
function count(
  db: Database.Database,
  sql: string,
  values: (string | number)[] = [],
) {
  return (db.prepare(sql).get(...values) as { n: number }).n;
}
type SummaryOutcome = Pick<
  Outcome,
  "horizon" | "settled" | "returnPct" | "action"
>;
type SummaryRow = Pick<
  LedgerSignal,
  | "id"
  | "symbol"
  | "observedDate"
  | "strategy"
  | "direction"
  | "quality"
  | "score"
  | "endpointDate"
> & { outcomes: SummaryOutcome[] };
const signalProjection = `l.id,l.symbol,l.observed_date AS observedDate,
 json_extract(l.payload,'$.strategy') AS strategy,json_extract(l.payload,'$.direction') AS direction,
 json_extract(l.payload,'$.quality') AS quality,json_extract(l.payload,'$.score') AS score,
 json_extract(l.payload,'$.endpointDate') AS endpointDate`;

/** UI read model. Never replace the worker's unbounded rows() with this page. */
export function ledgerHistory(
  db: Database.Database,
  input: LedgerHistoryInput,
) {
  const { cursor, ...filter } = ledgerHistorySchema.parse(input);
  const hash = fingerprint(filter);
  checkCursor(cursor, hash);
  return db.transaction(() => {
    const where: string[] = [],
      values: (string | number)[] = [filter.horizon];
    for (const [value, sql] of [
      [filter.from, "l.observed_date>=?"],
      [filter.to, "l.observed_date<=?"],
      [filter.symbol, "l.symbol=?"],
      [filter.strategy, "json_extract(l.payload,'$.strategy')=?"],
      [filter.direction, "json_extract(l.payload,'$.direction')=?"],
      [filter.quality, "json_extract(l.payload,'$.quality')=?"],
    ] as const)
      if (value !== undefined) {
        where.push(sql);
        values.push(value);
      }
    const state = `CASE WHEN o.signal_id IS NULL OR o.settled=0 THEN 'pending' WHEN json_extract(o.payload,'$.returnPct') IS NULL THEN 'blank' ELSE 'valid' END`;
    if (filter.state) {
      where.push(`${state}=?`);
      values.push(filter.state);
    }
    const source = `FROM signal_ledger l LEFT JOIN signal_ledger_outcomes o ON o.signal_id=l.id AND o.horizon=? WHERE ${where.join(" AND ") || "1"}`;
    const stats = db
      .prepare(
        `SELECT count(*) AS total,
      COALESCE(sum((${state})='pending'),0) AS pending,
      COALESCE(sum((${state})='valid'),0) AS valid,
      COALESCE(sum((${state})='blank'),0) AS blank,
      COALESCE(sum((SELECT count(*) FROM signal_ledger_outcomes a WHERE a.signal_id=l.id AND a.settled=1)<3),0) AS pendingSignals ${source}`,
      )
      .get(...values) as {
      total: number;
      pending: number;
      valid: number;
      blank: number;
      pendingSignals: number;
    };
    const pageValues = [...values];
    let seek = "";
    if (cursor) {
      seek =
        " AND (l.observed_date<? OR (l.observed_date=? AND (l.symbol>? OR (l.symbol=? AND l.id>?))))";
      pageValues.push(
        cursor.date,
        cursor.date,
        cursor.symbol,
        cursor.symbol,
        cursor.id,
      );
    }
    const page = db
      .prepare(
        `SELECT ${signalProjection} ${source}${seek} ORDER BY l.observed_date DESC,l.symbol,l.id LIMIT 21`,
      )
      .all(...pageValues) as Omit<SummaryRow, "outcomes">[];
    const rows: SummaryRow[] = page
      .slice(0, 20)
      .map((row) => ({ ...row, outcomes: [] }));
    if (rows.length) {
      const outcomes = db
        .prepare(
          `SELECT signal_id AS id,horizon,settled,json_extract(payload,'$.returnPct') AS returnPct,json_extract(payload,'$.action') AS action FROM signal_ledger_outcomes WHERE signal_id IN (${rows.map(() => "?").join(",")}) ORDER BY horizon`,
        )
        .all(...rows.map((row) => row.id)) as (SummaryOutcome & {
        id: string;
      })[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const { id, ...value } of outcomes)
        byId
          .get(id)!
          .outcomes.push({ ...value, settled: Boolean(value.settled) });
    }
    const last = rows.at(-1);
    return {
      rows,
      ...stats,
      totalAll: count(db, "SELECT count(*) AS n FROM signal_ledger"),
      horizon: filter.horizon,
      nextCursor:
        page.length > 20 && last
          ? {
              date: last.observedDate,
              symbol: last.symbol,
              id: last.id,
              filter: hash,
            }
          : null,
      readAt: Date.now(),
    };
  })();
}

export function ledgerDetail(db: Database.Database, id: string) {
  return db.transaction(() => {
    const row = db
      .prepare("SELECT payload FROM signal_ledger WHERE id=?")
      .get(id) as { payload: string } | undefined;
    if (!row) throw new Error("信号记录不存在");
    const signal = JSON.parse(row.payload) as LedgerSignal;
    const outcomes = (
      db
        .prepare(
          "SELECT payload FROM signal_ledger_outcomes WHERE signal_id=? ORDER BY horizon",
        )
        .all(id) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as Outcome);
    // Bound the candidate set before reusing every existing semantic match predicate.
    const decisions = (
      db
        .prepare(
          `SELECT payload FROM records WHERE kind='notification-decision'
      AND json_extract(payload,'$.symbol')=? AND json_extract(payload,'$.date')=?
      AND json_extract(payload,'$.strategy')=?`,
        )
        .all(signal.symbol, signal.observedDate, signal.strategy) as {
        payload: string;
      }[]
    ).map((row) => JSON.parse(row.payload) as NotificationDecision);
    return {
      schemaVersion: 1 as const,
      exportedAt: Date.now(),
      signal: { ...signal, outcomes },
      notifications: new NotificationPolicyStore(db).ledgerDecisions(
        signal,
        decisions,
      ),
    };
  })();
}

export function ledgerSummary(db: Database.Database) {
  const latest = db
    .prepare(
      "SELECT json_remove(payload,'$.errors') AS payload,json_array_length(payload,'$.errors') AS errorCount FROM signal_ledger_runs ORDER BY (json_extract(payload,'$.status')='running') DESC,date DESC LIMIT 1",
    )
    .get() as { payload: string; errorCount: number } | undefined;
  const run = latest
    ? (JSON.parse(latest.payload) as Omit<LedgerRun, "errors">)
    : null;
  return {
    run: run ? { ...run, errorCount: latest!.errorCount } : null,
    activeDate: run?.status === "running" ? run.date : null,
    readAt: Date.now(),
  };
}

export function ledgerRuns(
  db: Database.Database,
  input: z.input<typeof ledgerRunsSchema>,
) {
  const { cursor, ...filter } = ledgerRunsSchema.parse(input),
    hash = fingerprint(filter);
  checkCursor(cursor, hash);
  const where: string[] = [],
    values: string[] = [];
  if (filter.from) {
    where.push("date>=?");
    values.push(filter.from);
  }
  if (filter.to) {
    where.push("date<=?");
    values.push(filter.to);
  }
  if (filter.status) {
    where.push("json_extract(payload,'$.status')=?");
    values.push(filter.status);
  }
  return db.transaction(() => {
    const source = `FROM signal_ledger_runs WHERE ${where.join(" AND ") || "1"}`;
    const total = count(db, `SELECT count(*) AS n ${source}`, values);
    const rows = db
      .prepare(
        `SELECT date,json_extract(payload,'$.status') AS status,json_extract(payload,'$.scanned') AS scanned,
      json_extract(payload,'$.total') AS total,json_extract(payload,'$.signals') AS signals,json_extract(payload,'$.elapsedMs') AS elapsedMs,
      json_array_length(payload,'$.errors') AS errorCount ${source}${cursor ? " AND date<?" : ""} ORDER BY date DESC LIMIT 21`,
      )
      .all(...values, ...(cursor ? [cursor.date] : [])) as Pick<
      LedgerRun,
      "date" | "status" | "scanned" | "total" | "signals" | "elapsedMs"
    >[];
    const shown = rows.slice(0, 20),
      last = shown.at(-1);
    return {
      rows: shown,
      total,
      nextCursor:
        rows.length > 20 && last ? { date: last.date, filter: hash } : null,
    };
  })();
}

export function ledgerDecisions(
  db: Database.Database,
  input: z.input<typeof ledgerDecisionsSchema>,
) {
  const { cursor, ...filter } = ledgerDecisionsSchema.parse(input),
    hash = fingerprint(filter);
  checkCursor(cursor, hash);
  const where = ["kind='notification-decision'"],
    values: (string | number)[] = [];
  for (const [value, sql] of [
    [filter.from, "json_extract(payload,'$.date')>=?"],
    [filter.to, "json_extract(payload,'$.date')<=?"],
    [filter.symbol, "json_extract(payload,'$.symbol')=?"],
    [filter.tier, "json_extract(payload,'$.tier')=?"],
  ] as const) {
    if (value !== undefined) {
      where.push(sql);
      values.push(value);
    }
  }
  return db.transaction(() => {
    const source = `FROM records WHERE ${where.join(" AND ")}`;
    const total = count(db, `SELECT count(*) AS n ${source}`, values);
    const seek = cursor
      ? " AND (json_extract(payload,'$.createdAt')<? OR (json_extract(payload,'$.createdAt')=? AND id>?))"
      : "";
    const rows = db
      .prepare(
        `SELECT id,json_extract(payload,'$.createdAt') AS createdAt,json_extract(payload,'$.date') AS date,
      json_extract(payload,'$.symbol') AS symbol,json_extract(payload,'$.strategy') AS strategy,json_extract(payload,'$.direction') AS direction,
      json_extract(payload,'$.tier') AS tier ${source}${seek} ORDER BY json_extract(payload,'$.createdAt') DESC,id ASC LIMIT 21`,
      )
      .all(
        ...values,
        ...(cursor ? [cursor.at, cursor.at, cursor.id] : []),
      ) as Pick<
      NotificationDecision,
      "id" | "createdAt" | "date" | "symbol" | "strategy" | "direction" | "tier"
    >[];
    const shown = rows.slice(0, 20),
      last = shown.at(-1);
    return {
      rows: shown,
      total,
      nextCursor:
        rows.length > 20 && last
          ? { at: last.createdAt, id: last.id, filter: hash }
          : null,
    };
  })();
}

/** Full population, projected without signal evidence or notification bodies. No cache can go stale after backfill. */
export function ledgerAnalysis(db: Database.Database) {
  return db.transaction(() => {
    const outcomes = new Map<string, Outcome[]>();
    for (const row of db
      .prepare(
        "SELECT signal_id,payload FROM signal_ledger_outcomes ORDER BY horizon",
      )
      .all() as { signal_id: string; payload: string }[]) {
      const values = outcomes.get(row.signal_id) ?? [];
      values.push(JSON.parse(row.payload) as Outcome);
      outcomes.set(row.signal_id, values);
    }
    const rows = (
      db
        .prepare(
          `SELECT ${signalProjection} FROM signal_ledger l ORDER BY l.observed_date DESC,l.symbol,l.id`,
        )
        .all() as Omit<SummaryRow, "outcomes">[]
    ).map((row) => ({ ...row, outcomes: outcomes.get(row.id) ?? [] }));
    const information = signalInformation(rows);
    return {
      groups: aggregateLedger(rows),
      information: {
        ...information,
        groups: information.groups.map(({ daily, ...group }) => {
          const sectionReasons: Record<string, number> = {};
          for (const section of daily)
            if (section.reason)
              sectionReasons[section.reason] =
                (sectionReasons[section.reason] ?? 0) + 1;
          return { ...group, sectionReasons };
        }),
      },
      sampleCount: rows.length,
      from: rows.at(-1)?.observedDate ?? null,
      to: rows[0]?.observedDate ?? null,
      readAt: Date.now(),
    };
  })();
}
