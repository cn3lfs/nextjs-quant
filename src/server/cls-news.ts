import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { Evidence } from "~/lib/domain";
import { settings } from "./settings";
import { evidenceEnvelope } from "./evidence";
export type NewsCursor = { time: number; id: number };
export type ClsNewsItem = {
  id: number;
  publishedAt: string;
  collectedAt: string | null;
  title: string;
  content: string;
  url: string | null;
  hash: string;
};
type Row = {
  id: number;
  ctime: number;
  collected_at: string | null;
  title: string | null;
  content: string | null;
  shareurl: string | null;
};
const digest = (data: unknown) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
const localTime = (time: number) =>
  new Date(time + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
export function readClsNews(
  path: string,
  options: {
    cutoff: number;
    from?: number;
    limit?: number;
    page?: number;
    query?: string;
    after?: NewsCursor;
    before?: NewsCursor;
    historical?: boolean;
  },
) {
  const { cutoff } = options,
    from = options.from ?? cutoff - 7 * 86400000;
  const limit = options.limit ?? 50,
    page = options.page ?? 0;
  if (
    !Number.isFinite(cutoff) ||
    cutoff > Date.now() ||
    !Number.isFinite(from) ||
    from > cutoff ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isInteger(page) ||
    page < 0 ||
    (options.after && options.before) ||
    [options.after, options.before].some(
      (cursor) =>
        cursor &&
        (!Number.isInteger(cursor.time) ||
          cursor.time < 0 ||
          cursor.time > Math.floor(cutoff / 1000) ||
          !Number.isInteger(cursor.id) ||
          cursor.id < 0),
    )
  )
    throw new Error("新闻时间范围或分页参数非法");
  const connection = new Database(path, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return connection.transaction(() => {
      const where = ["ctime >= ?", "ctime <= ?"],
        params: (string | number)[] = [
          Math.ceil(from / 1000),
          Math.floor(cutoff / 1000),
        ];
      if (options.historical) {
        where.push(
          "datetime(collected_at) IS NOT NULL AND datetime(collected_at) <= ?",
        );
        params.push(localTime(cutoff));
      }
      if (options.after) {
        where.push("(ctime > ? OR (ctime = ? AND id > ?))");
        params.push(options.after.time, options.after.time, options.after.id);
      }
      if (options.before) {
        where.push("(ctime < ? OR (ctime = ? AND id < ?))");
        params.push(
          options.before.time,
          options.before.time,
          options.before.id,
        );
      }
      const query = options.query?.trim();
      if (query) {
        where.push(
          "(instr(coalesce(title, ''), ?) > 0 OR instr(coalesce(content, ''), ?) > 0)",
        );
        params.push(query, query);
      }
      const clause = where.join(" AND ");
      const count = (
        connection
          .prepare(`SELECT count(*) AS count FROM news WHERE ${clause}`)
          .get(...params) as { count: number }
      ).count;
      const order = options.after ? "ASC" : "DESC";
      const rows = connection
        .prepare(
          `SELECT id,ctime,collected_at,title,content,shareurl FROM news WHERE ${clause} ORDER BY ctime ${order},id ${order} LIMIT ? OFFSET ?`,
        )
        .all(
          ...params,
          limit,
          options.after || options.before ? 0 : page * limit,
        ) as Row[];
      const latest = connection
        .prepare("SELECT max(ctime) AS time FROM news WHERE ctime <= ?")
        .get(Math.floor(Date.now() / 1000)) as { time: number | null };
      const items: ClsNewsItem[] = rows.map((row) => {
        const collected =
          row.collected_at &&
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.collected_at)
            ? `${row.collected_at.replace(" ", "T")}+08:00`
            : null;
        return {
          id: row.id,
          publishedAt: new Date(row.ctime * 1000).toISOString(),
          collectedAt: collected,
          title: row.title ?? "",
          content: row.content ?? "",
          url:
            row.shareurl && /^https:\/\//i.test(row.shareurl)
              ? row.shareurl
              : null,
          hash: digest(row),
        };
      });
      return {
        items,
        count,
        cutoff: new Date(cutoff).toISOString(),
        fetchedAt: Date.now(),
        latestPublishedAt: latest.time
          ? new Date(latest.time * 1000).toISOString()
          : null,
        nextCursor:
          options.after && rows.length
            ? { time: rows.at(-1)!.ctime, id: rows.at(-1)!.id }
            : null,
        nextBefore:
          !options.after && rows.length
            ? { time: rows.at(-1)!.ctime, id: rows.at(-1)!.id }
            : null,
        historical: options.historical ?? false,
      };
    })();
  } finally {
    connection.close();
  }
}

let sharedCache:
  { key: string; expires: number; evidence: Evidence[] } | undefined;
export function sharedNewsEvidence(): Evidence[] {
  const path = settings().clsDbPath,
    now = Date.now(),
    key = path;
  if (sharedCache?.key === key && sharedCache.expires > now)
    return structuredClone(sharedCache.evidence);
  let evidence: Evidence[];
  try {
    const news = readClsNews(path, { cutoff: now, limit: 12 });
    const items = news.items.map((item) => ({
      ...item,
      content: item.content.slice(0, 1600),
    }));
    const version = digest(items);
    evidence = [
      {
        id: `CLS-${version}`,
        source: "财联社本地存档 / 当前研究新闻（非历史交易信号）",
        asOf: news.latestPublishedAt ?? "无已知发布时间",
        envelope: evidenceEnvelope(news.items, {
          source: "cls-local",
          symbol: null,
          type: "news",
          asOf: news.latestPublishedAt,
          publishedAt: news.latestPublishedAt,
          fetchedAt: news.fetchedAt,
          currency: null,
          unit: {},
          adjustment: "not-applicable",
          reportPeriod: null,
          quality: "partial",
          warnings: [
            "最近七天最多十二条存档，不保证实时完整；各条发布和采集时间分别保留。",
            "新闻不代替市场量化指标，正文可能截断；hash 对应截断前的新闻集合。",
          ],
        }),
        text: JSON.stringify({
          items,
          latestPublishedAt: news.latestPublishedAt,
          coverage: "最近七天，最多十二条；存档不保证实时或完整",
          warning:
            "只提供新闻事实，不能用此替代行业/市场量化指标；与候选旧行情时点分开解释。",
        }),
      },
    ];
  } catch {
    evidence = [
      {
        id: "CLS-unavailable",
        source: "财联社新闻可用性",
        asOf: new Date(now).toISOString().slice(0, 10),
        text: "未能读取本地财联社存档，新闻背景缺失，不得编造消息。",
      },
    ];
  }
  sharedCache = { key, expires: now + 30000, evidence };
  return structuredClone(evidence);
}
