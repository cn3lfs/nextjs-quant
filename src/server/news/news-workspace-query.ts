import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  newsWorkspaceSchema,
  newsPageSelectionSchema,
  newsArchiveQuerySchema,
  type NewsWorkspaceInput,
} from "~/lib/news/news-workspace";
import type { z } from "zod";
import type { ClsNewsItem } from "../data-sources/cls/cls-news";

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
    const file = statSync(path);
    const source = digest([
      resolve(path).toLowerCase(),
      file.dev,
      file.ino,
      file.birthtimeMs,
    ]);
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
export function newsWorkspacePage(path: string, raw: NewsWorkspaceInput) {
  const input = newsWorkspaceSchema.parse(raw);
  return readSource(path, (db, source) => {
    const result = page(db, source, input);
    const latest = db
      .prepare("SELECT max(ctime) time FROM news WHERE ctime<=?")
      .get(Math.floor(Date.now() / 1000)) as { time: number | null };
    return {
      ...result,
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
export function newsWorkspaceDetail(
  path: string,
  raw: NewsWorkspaceInput,
  id: number,
  expectedSource: string,
) {
  const input = newsWorkspaceSchema.parse(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("新闻ID无效");
  return readSource(path, (db, source) => {
    if (source !== expectedSource)
      throw new Error("新闻来源已改变，请返回列表重新查询");
    const base = scope(input);
    const row = db
      .prepare(
        `SELECT id,ctime,collected_at,title,content,shareurl FROM news WHERE ${base.where} AND id=?`,
      )
      .get(...base.values, id) as NewsRow | undefined;
    if (!row) throw new Error("新闻已不存在或不在当前查询范围内");
    return { item: item(row), source, readAt: Date.now() };
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
