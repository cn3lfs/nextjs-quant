import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  clsReviewReportQuery,
  clsReviewFactQuery,
  clsReviewVerificationQuery,
  clsReviewVerificationIdentity,
} from "~/lib/news/cls-review-workspace";
import type { ClsFactReview } from "~/lib/news/cls-fact-review";
import type { ClsVerification } from "./cls-verification";

const cursorSchema = z.object({
  key: z.string(),
  time: z.number().finite(),
  id: z.string().max(200),
});
type Position = z.infer<typeof cursorSchema>;
function paging(input: Record<string, unknown> & { cursor?: string }) {
  const { cursor, ...filters } = input;
  const key = createHash("sha256")
    .update(JSON.stringify(filters))
    .digest("hex");
  let position: Position | undefined;
  if (cursor) {
    try {
      position = cursorSchema.parse(
        JSON.parse(Buffer.from(cursor, "base64url").toString()),
      );
    } catch {
      throw new Error("分页位置无效，请重新查询");
    }
    if (position.key !== key) throw new Error("分页条件已变化，请重新查询");
  }
  return {
    position,
    finish<T extends { id: string; sortTime: number }>(rows: T[]) {
      const items = rows.slice(0, 20);
      const last = items.at(-1);
      return {
        items,
        hasMore: rows.length > 20,
        nextCursor:
          rows.length > 20 && last
            ? Buffer.from(
                JSON.stringify({ key, time: last.sortTime, id: last.id }),
              ).toString("base64url")
            : null,
      };
    },
  };
}
const before = "(sortTime < @time OR (sortTime = @time AND id < @id))";
export function clsReportPage(db: Database.Database, raw: unknown) {
  const input = clsReviewReportQuery.parse(raw);
  const page = paging(input);
  const rows = db
    .prepare(
      `WITH summaries AS (
    SELECT id, updated_at sortTime, json_extract(payload,'$.report.title') title,
      json_extract(payload,'$.report.reportDate') reportDate,
      json_extract(payload,'$.versionNumber') versionNumber,
      json_extract(payload,'$.importedAt') importedAt,
      json_extract(payload,'$.report.hash') hash
    FROM records WHERE kind='cls-review-report'
  ) SELECT * FROM summaries WHERE
    instr(lower(title),lower(@title))>0
    AND (@unknown=0 OR reportDate IS NULL)
    AND (@from IS NULL OR reportDate>=@from) AND (@to IS NULL OR reportDate<=@to)
    ${page.position ? `AND ${before}` : ""}
    ORDER BY sortTime DESC,id DESC LIMIT 21`,
    )
    .all({
      title: input.title,
      unknown: input.unknownDate ? 1 : 0,
      from: input.from ?? null,
      to: input.to ?? null,
      ...(page.position
        ? { time: page.position.time, id: page.position.id }
        : {}),
    }) as {
    id: string;
    sortTime: number;
    title: string;
    reportDate: string | null;
    versionNumber: number;
    importedAt: number;
    hash: string;
  }[];
  return page.finish(rows);
}

export function clsFactPage(db: Database.Database, raw: unknown) {
  const input = clsReviewFactQuery.parse(raw);
  const page = paging(input);
  // A single statement ranks once and derives both the full statistics and page.
  // Materialize metadata only: copying every full evidence payload made the
  // 10,000-claim fixture exceed the budget. Fetch payloads for the 21 page IDs.
  const rows = db
    .prepare(
      `WITH ranked AS MATERIALIZED (
    SELECT id,json_extract(payload,'$.reviewedAt') sortTime,
      json_extract(payload,'$.verdict') verdict,
      ROW_NUMBER() OVER(PARTITION BY json_extract(payload,'$.sectionId'),json_extract(payload,'$.quote')
        ORDER BY json_extract(payload,'$.reviewedAt') DESC,id DESC) position
    FROM records WHERE kind='cls-review-fact' AND json_extract(payload,'$.reportId')=@reportId
  ), statistics AS (
    SELECT COUNT(*) reviewed,COALESCE(SUM(verdict='supported'),0) supported,
      COALESCE(SUM(verdict='contradicted'),0) contradicted,
      COALESCE(SUM(verdict='unresolved'),0) unresolved FROM ranked WHERE position=1
  ), page_ids AS (
    SELECT id,sortTime,verdict FROM ranked
    WHERE (@mode='history' OR position=1) AND (@verdict IS NULL OR verdict=@verdict)
      ${page.position ? `AND ${before}` : ""} ORDER BY sortTime DESC,id DESC LIMIT 21
  ), paged AS (
    SELECT page_ids.id,page_ids.sortTime,page_ids.verdict,
      json_extract(records.payload,'$.reportId') reportId,json_extract(records.payload,'$.sectionId') sectionId,
      json_extract(records.payload,'$.reviewedAt') reviewedAt,
      substr(json_extract(records.payload,'$.quote'),1,200) quote,
      substr(json_extract(records.payload,'$.evidence'),1,500) evidence,
      length(json_extract(records.payload,'$.quote'))>200 OR length(json_extract(records.payload,'$.evidence'))>500 truncated
    FROM page_ids JOIN records ON records.id=page_ids.id
  ) SELECT paged.*,statistics.* FROM statistics LEFT JOIN paged ON 1=1
    ORDER BY paged.sortTime DESC,paged.id DESC`,
    )
    .all({
      reportId: input.reportId,
      mode: input.mode,
      verdict: input.verdict ?? null,
      ...(page.position
        ? { time: page.position.time, id: page.position.id }
        : {}),
    }) as (ClsFactReview & {
    sortTime: number;
    truncated: number;
    reviewed: number;
    supported: number;
    contradicted: number;
    unresolved: number;
  })[];
  const first = rows[0]!;
  const statistics = {
    reviewed: first.reviewed,
    supported: first.supported,
    contradicted: first.contradicted,
    unresolved: first.unresolved,
    supportRate:
      first.supported + first.contradicted
        ? first.supported / (first.supported + first.contradicted)
        : null,
  };
  const items = rows
    .filter((row) => row.id !== null)
    .map(
      ({
        reviewed: _reviewed,
        supported: _supported,
        contradicted: _contradicted,
        unresolved: _unresolved,
        ...row
      }) => row,
    );
  return { ...page.finish(items), statistics };
}

export function clsFactDetail(
  db: Database.Database,
  reportId: string,
  id: string,
) {
  const row = db
    .prepare(
      "SELECT payload FROM records WHERE id=? AND kind='cls-review-fact' AND json_extract(payload,'$.reportId')=?",
    )
    .get(id, reportId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as ClsFactReview) : null;
}

export function clsVerificationPage(db: Database.Database, raw: unknown) {
  const input = clsReviewVerificationQuery.parse(raw);
  const page = paging(input);
  const rows = db
    .prepare(
      `WITH summaries AS (
    SELECT id,updated_at sortTime,json_extract(payload,'$.hash') hash,
      json_extract(payload,'$.checkedAt') checkedAt,json_extract(payload,'$.date') date,
      json_extract(payload,'$.source') source,json_extract(payload,'$.outcomes') outcomes,
      json_extract(payload,'$.warnings') warnings
    FROM records WHERE kind='cls-review-verification' AND json_extract(payload,'$.date')=@date
  ) SELECT * FROM summaries ${page.position ? `WHERE ${before}` : ""}
  ORDER BY sortTime DESC,id DESC LIMIT 21`,
    )
    .all({
      date: input.date,
      ...(page.position
        ? { time: page.position.time, id: page.position.id }
        : {}),
    }) as {
    id: string;
    sortTime: number;
    hash: string;
    checkedAt: number;
    date: string;
    source: string;
    outcomes: string;
    warnings: string;
  }[];
  return page.finish(
    rows.map((row) => ({
      ...row,
      source: JSON.parse(row.source) as ClsVerification["source"],
      outcomes: JSON.parse(row.outcomes) as ClsVerification["outcomes"],
      warnings: JSON.parse(row.warnings) as string[],
    })),
  );
}

export function clsVerificationDetail(db: Database.Database, raw: unknown) {
  const input = clsReviewVerificationIdentity.parse(raw);
  const row = db
    .prepare(
      "SELECT payload FROM records WHERE kind='cls-review-verification' AND id=?",
    )
    .get(`cls-review-verification:${input.date}:${input.hash}`) as
    { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as ClsVerification) : null;
}

export function clsReportSamples(db: Database.Database, reportId: string) {
  return db
    .prepare(
      `SELECT json_extract(payload,'$.date') date, json_extract(payload,'$.fixedAt') fixedAt
    FROM records WHERE kind='cls-review-sample' AND json_extract(payload,'$.reportId')=?
    ORDER BY date DESC`,
    )
    .all(reportId) as { date: string; fixedAt: number }[];
}
