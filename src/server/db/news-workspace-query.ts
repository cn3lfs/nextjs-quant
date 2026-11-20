import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  newsWorkspaceSchema,
  newsPageSelectionSchema,
  newsArchiveQuerySchema,
  type NewsWorkspaceInput,
} from "~/lib/news/news-workspace";
import type {
  NewsArchiveSourceRole,
  NewsArchiveView,
} from "~/lib/news/news-archives";
import type { NewsArchiveSettings } from "~/lib/settings/news-source-settings";
import type { z } from "zod";
import type { ClsNewsItem } from "../data-sources/cls/cls-news";
import { newsSourceIdentity, resolveNewsArchive } from "../news/news-archives";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
type NewsRow = {
  id: number;
  ctime: number;
  collected_at: string | null;
  title: string | null;
  content: string | null;
  shareurl: string | null;
};
function item(row: NewsRow): ClsNewsItem {
  return {
    id: row.id,
    publishedAt: new Date(row.ctime * 1000).toISOString(),
    collectedAt:
      row.collected_at &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.collected_at)
        ? `${row.collected_at.replace(" ", "T")}+08:00`
        : null,
    title: row.title ?? "",
    content: row.content ?? "",
    url:
      row.shareurl && /^https:\/\//i.test(row.shareurl) ? row.shareurl : null,
    hash: digest(row),
  };
}
function readSource<T>(
  path: string,
  fn: (db: Database.Database, source: string) => T,
): T {
  if (!path) throw new Error("尚未配置新闻存档，请前往数据与连接设置");
  let db: Database.Database | undefined;
  try {
    const source = newsSourceIdentity(path);
    db = new Database(path, { readonly: true, fileMustExist: true });
    return db.transaction(() => fn(db!, source))();
  } catch (error) {
    if (
      error instanceof Error &&
      (("code" in error &&
        /^(?:SQLITE_|ENOENT|EACCES|EPERM)/.test(String(error.code))) ||
        /SQLITE_|ENOENT|EACCES|unable to open/i.test(error.message))
    )
      throw new Error(
        "新闻存档不可读取或格式不兼容，请检查数据与连接设置后重试",
      );
    throw error;
  } finally {
    db?.close();
  }
}
function archiveView(archive: {
  key: "primary" | "complement";
  role: NewsArchiveSourceRole;
  label: string;
  primary: boolean;
}): NewsArchiveView {
  return {
    key: archive.key,
    role: archive.role,
    label: archive.label,
    primary: archive.primary,
  };
}
function scope(input: ReturnType<typeof newsWorkspaceSchema.parse>) {
  const where = ["ctime>=?", "ctime<=?"];
  const values: (number | string)[] = [
    Math.ceil((input.cutoff - 7 * 86400000) / 1000),
    Math.floor(input.cutoff / 1000),
  ];
  if (input.historical) {
    where.push(
      "datetime(collected_at) IS NOT NULL AND datetime(collected_at)<=?",
    );
    values.push(
      new Date(input.cutoff + 8 * 3600000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " "),
    );
  }
  if (input.query) {
    where.push(
      "(instr(coalesce(title,''),?)>0 OR instr(coalesce(content,''),?)>0)",
    );
    values.push(input.query, input.query);
  }
  return { where: where.join(" AND "), values };
}
function page(db: Database.Database, source: string, raw: NewsWorkspaceInput) {
  const { cursor, ...filter } = newsWorkspaceSchema.parse(raw),
    base = scope(filter);
  const key = digest({ source, ...filter });
  if (cursor && cursor.filter !== key)
    throw new Error("新闻分页条件或数据来源已改变，请重新查询");
  const seek = cursor ? " WHERE (ctime<? OR (ctime=? AND id<?))" : "";
  const values = cursor
    ? [...base.values, cursor.time, cursor.time, cursor.id]
    : base.values;
  // Keep only IDs/timestamps from the full-text scan. Count and seek share it;
  // read at most 51 full originals for their exact hashes, not every match.
  const selected = db
    .prepare(
      `WITH matched AS MATERIALIZED (
        SELECT id,ctime FROM news WHERE ${base.where}
      ), chosen AS (
        SELECT id,ctime FROM matched${seek} ORDER BY ctime DESC,id DESC LIMIT 51
      ) SELECT n.id,n.ctime,n.collected_at,n.title,n.content,n.shareurl,totals.total
        FROM (SELECT count(*) total FROM matched) totals
        LEFT JOIN chosen c ON 1=1 LEFT JOIN news n ON n.id=c.id
        ORDER BY c.ctime DESC,c.id DESC`,
    )
    .all(...values) as (Omit<NewsRow, "id"> & {
    id: number | null;
    total: number;
  })[];
  const total = selected[0]?.total ?? 0;
  const rows = selected.flatMap(({ total: _total, ...row }) =>
    row.id === null ? [] : [{ ...row, id: row.id }],
  );
  const items = rows.slice(0, 50).map(item),
    last = rows[49];
  const fingerprint = digest({
    key,
    ids: items.map((value) => [value.id, value.hash]),
  });
  return {
    items,
    total,
    source,
    fingerprint,
    nextCursor:
      rows.length > 50 && last
        ? { time: last.ctime, id: last.id, filter: key }
        : null,
  };
}
export function newsWorkspacePage(
  config: NewsArchiveSettings,
  raw: NewsWorkspaceInput,
) {
  const input = newsWorkspaceSchema.parse(raw);
  const archive = resolveNewsArchive(config, input.role);
  return readSource(archive.path, (db, source) => {
    const result = page(db, source, input);
    const latest = db
      .prepare("SELECT max(ctime) time FROM news WHERE ctime<=?")
      .get(Math.floor(Date.now() / 1000)) as { time: number | null };
    return {
      ...result,
      archive: archiveView(archive),
      items: result.items.map(({ content, title, ...rest }) => ({
        ...rest,
        title: title.slice(0, 200),
        preview: content.slice(0, 160),
        contentLength: content.length,
      })),
      cutoff: input.cutoff,
      from: input.cutoff - 7 * 86400000,
      readAt: Date.now(),
      latestPublishedAt: latest.time
        ? new Date(latest.time * 1000).toISOString()
        : null,
    };
  });
}
type RelatedNewsEvent = {
  id: string;
  publishedAt: string;
  title: string;
  preview: string;
  href: string;
};
type RelatedNewsEventWithMatches = RelatedNewsEvent & { matches: string[] };
/** SQLite's default upper() folds ASCII only and preserves length, so an index
 * in the folded text is also the index in the original stored field. */
function asciiFold(value: string) {
  return value.replace(/[a-z]/g, (char) => char.toUpperCase());
}
/** Reuse the SQL candidate order, but take the exact spelling from the first
 * real title/content occurrence; text that only matched across the joined
 * delimiter yields an empty query instead of a fragment from neither field. */
function literalQuery(fields: readonly string[], terms: readonly string[]) {
  for (const term of terms) {
    const needle = asciiFold(term);
    if (!needle) continue;
    for (const field of fields) {
      const at = asciiFold(field).indexOf(needle);
      if (at >= 0) return field.slice(at, at + term.length);
    }
  }
  return "";
}
function literalTerms(value: string | null) {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((term): term is string => typeof term === "string")
      : [];
  } catch {
    return [];
  }
}
/** A bounded read of the already configured news archive, with literal name/code
 * matching. It makes no claim of causal or verified investment relevance.
 * `withMatches` is an explicit opt-in: legacy callers keep the old fields and
 * the SQLite CASE avoids projecting terms they never read. */
export function relatedNewsEvents(
  path: string,
  terms: string[],
  from: number,
  to: number,
  withMatches: true,
): RelatedNewsEventWithMatches[];
export function relatedNewsEvents(
  path: string,
  terms: string[],
  from: number,
  to: number,
  withMatches?: false,
): RelatedNewsEvent[];
export function relatedNewsEvents(
  path: string,
  terms: string[],
  from: number,
  to: number,
  withMatches = false,
) {
  if (!terms.length) return [];
  return readSource(path, (db, source) => {
    const encoded = JSON.stringify(terms);
    // The matching terms are projected only for the 100 rows surviving the
    // window/filter/LIMIT and only when the caller opts in. Callers map the
    // returned literal terms back to their own securities; nothing is
    // re-matched against a truncated preview.
    const rows = db
      .prepare(
        `WITH selected AS (
          SELECT id,ctime,collected_at,title,content,shareurl FROM news
          WHERE ctime>=? AND ctime<=? AND EXISTS(SELECT 1 FROM json_each(?) term
          WHERE instr(upper(coalesce(title,'')||' '||coalesce(content,'')),upper(term.value))>0)
          ORDER BY ctime DESC,id DESC LIMIT 100
        ) SELECT s.id,s.ctime,s.collected_at,s.title,s.content,s.shareurl,
          CASE WHEN ? THEN
            (SELECT json_group_array(term.value) FROM json_each(?) term
              WHERE instr(upper(coalesce(s.title,'')||' '||coalesce(s.content,'')),upper(term.value))>0)
          ELSE NULL END matches
        FROM selected s ORDER BY s.ctime DESC,s.id DESC`,
      )
      .all(
        Math.ceil(from / 1000),
        Math.floor(to / 1000),
        encoded,
        withMatches ? 1 : 0,
        encoded,
      ) as (NewsRow & { matches: string | null })[];
    return rows.map((row) => {
      const news = item(row);
      const filter = {
        cutoff: Math.min(Date.parse(news.publishedAt), Date.now()),
        historical: false,
        query: literalQuery([news.title, news.content], terms),
      };
      const event = {
        id: String(news.id),
        publishedAt: news.publishedAt,
        title: news.title.slice(0, 200) || news.content.slice(0, 80),
        preview: news.content.slice(0, 1000),
        href: `/intel?newsQuery=${encodeURIComponent(JSON.stringify(filter))}&newsId=${news.id}&newsSource=${source}`,
      };
      return withMatches
        ? { ...event, matches: literalTerms(row.matches) }
        : event;
    });
  });
}
export function newsWorkspaceDetail(
  config: NewsArchiveSettings,
  raw: NewsWorkspaceInput,
  id: number,
  expectedSource: string,
) {
  const input = newsWorkspaceSchema.parse(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("新闻ID无效");
  const archive = resolveNewsArchive(config, input.role);
  return readSource(archive.path, (db, source) => {
    if (source !== expectedSource)
      throw new Error("新闻来源已改变，请返回列表重新查询");
    const base = scope(input);
    const row = db
      .prepare(
        `SELECT id,ctime,collected_at,title,content,shareurl FROM news WHERE ${base.where} AND id=?`,
      )
      .get(...base.values, id) as NewsRow | undefined;
    if (!row) throw new Error("新闻已不存在或不在当前查询范围内");
    return {
      item: item(row),
      source,
      readAt: Date.now(),
      archive: archiveView(archive),
    };
  });
}
export function readClsNewsByIds(
  path: string,
  raw: NewsWorkspaceInput,
  ids: number[],
  expectedSource?: string,
) {
  const input = newsWorkspaceSchema.parse(raw);
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) throw new Error("请至少选择一条新闻");
  if (uniqueIds.some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new Error("所选新闻 ID 无效");
  return readSource(path, (db, source) => {
    if (expectedSource && source !== expectedSource)
      throw new Error("新闻来源已改变，请刷新后重试");
    const base = scope(input);
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id,ctime,collected_at,title,content,shareurl FROM news WHERE ${base.where} AND id IN (${placeholders}) ORDER BY ctime DESC,id DESC`,
      )
      .all(...base.values, ...uniqueIds) as NewsRow[];
    if (rows.length !== uniqueIds.length)
      throw new Error("部分所选新闻不存在或不在当前查询范围内");
    return rows.map(item);
  });
}
export function freezeNewsWorkspacePage(
  path: string,
  raw: NewsWorkspaceInput,
  selection: z.input<typeof newsPageSelectionSchema>,
) {
  const input = newsWorkspaceSchema.parse(raw),
    expected = newsPageSelectionSchema.parse(selection);
  return readSource(path, (db, source) => {
    if (source !== expected.source)
      throw new Error("新闻来源已改变，请刷新后重新分析");
    const result = page(db, source, { ...input, cursor: expected.cursor });
    if (result.fingerprint !== expected.fingerprint)
      throw new Error("当前页新闻已变化，请刷新后重新分析");
    return result;
  });
}

export function newsArchivePage(
  db: Database.Database,
  raw: z.input<typeof newsArchiveQuerySchema>,
) {
  const { cursor, ...filter } = newsArchiveQuerySchema.parse(raw),
    key = digest(filter);
  if (cursor && cursor.filter !== key)
    throw new Error("历史分页与查询条件不一致，请重新查询");
  const at = "json_extract(payload,'$.createdAt')",
    status =
      "CASE WHEN json_array_length(payload,'$.items')=json_array_length(payload,'$.news') THEN 'complete' ELSE 'partial' END";
  const where = ["kind='news-analysis'"],
    values: (string | number)[] = [];
  if (filter.from) {
    where.push(`${at}>=?`);
    values.push(Date.parse(`${filter.from}T00:00:00+08:00`));
  }
  if (filter.to) {
    where.push(`${at}<?`);
    values.push(Date.parse(`${filter.to}T00:00:00+08:00`) + 86400000);
  }
  if (filter.query) {
    where.push("instr(coalesce(json_extract(payload,'$.input.query'),''),?)>0");
    values.push(filter.query);
  }
  if (filter.status) {
    where.push(`${status}=?`);
    values.push(filter.status);
  }
  const clause = where.join(" AND ");
  return db.transaction(() => {
    const seek = cursor ? " WHERE (createdAt<? OR (createdAt=? AND id<?))" : "";
    const args = cursor ? [...values, cursor.at, cursor.at, cursor.id] : values;
    // Materialize metadata, never bodies: count and cursor page share one JSON
    // projection instead of scanning/parsing all matching payloads twice.
    // LEFT JOIN retains the full-filter total even for an exhausted cursor.
    const selected = db
      .prepare(
        `WITH filtered AS MATERIALIZED (
          SELECT id,${at} createdAt,json_extract(payload,'$.model') model,
            json_extract(payload,'$.method.version') version,json_extract(payload,'$.input.query') query,
            json_extract(payload,'$.input.cutoff') cutoff,json_array_length(payload,'$.news') count,
            json_array_length(payload,'$.items') completed,${status} status,
            json_extract(payload,'$.hitLimit') hitLimit,json_extract(payload,'$.aggregation.day') aggregationDay
          FROM records WHERE ${clause}
        ), page AS (
          SELECT * FROM filtered${seek} ORDER BY createdAt DESC,id DESC LIMIT 21
        ) SELECT page.*, totals.total FROM (SELECT count(*) total FROM filtered) totals
          LEFT JOIN page ON 1=1 ORDER BY page.createdAt DESC,page.id DESC`,
      )
      .all(...args) as {
      id: string | null;
      total: number;
      createdAt: number;
      model: string;
      version: string;
      query: string;
      cutoff: number;
      count: number;
      completed: number;
      status: "complete" | "partial";
      hitLimit: number | null;
      aggregationDay: string | null;
    }[];
    const total = selected[0]?.total ?? 0;
    const rows = selected.flatMap(({ total: _total, ...row }) =>
      row.id === null ? [] : [{ ...row, id: row.id }],
    );
    const last = rows[19];
    return {
      rows: rows.slice(0, 20),
      total,
      nextCursor:
        rows.length > 20 && last
          ? { at: last.createdAt, id: last.id, filter: key }
          : null,
      readAt: Date.now(),
    };
  })();
}
