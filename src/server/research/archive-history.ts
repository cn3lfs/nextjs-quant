import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { sqlite } from "../db";
import {
  archiveHistoryInput,
  archiveKinds,
  type ArchiveFilter,
} from "~/lib/research/workflow/archive-history";
import { symbolSchema } from "~/lib/domain";
import { taskTextPreview } from "../jobs/task-history";

/** SQL projection only. Original report bodies never enter the list response.
 * The transient JSONB tuple contains only: time, context ID, general title,
 * method title, Chan symbol, CAN SLIM symbol, Wyckoff symbol. No evidence bodies.
 */
const projection = `WITH source AS MATERIALIZED (
 SELECT id, kind, jsonb_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END, '$.createdAt', '$.contextId', '$.title', '$.result.title', '$.evidence.symbol', '$.dossier.symbol', '$.frames.symbol') AS body,
 json_valid(payload) AS valid FROM records WHERE kind IN ('report','chan-report','canslim-report','wyckoff-report')
), projected AS (
 SELECT r.id,r.kind,r.valid,
 CASE WHEN json_type(r.body,'$[0]') IN ('integer','real') AND json_extract(r.body,'$[0]') BETWEEN 0 AND 8640000000000000
 THEN json_extract(r.body,'$[0]') ELSE -1 END AS createdAt,
 CASE WHEN r.kind='report' THEN json_extract(r.body,'$[2]') ELSE json_extract(r.body,'$[3]') END AS title,
 CASE WHEN r.kind='chan-report' THEN json_extract(r.body,'$[4]')
 WHEN r.kind='canslim-report' THEN json_extract(r.body,'$[5]')
 WHEN r.kind='wyckoff-report' THEN json_extract(r.body,'$[6]')
 WHEN c.kind='snapshot' THEN json_extract(c.payload,'$.symbol')
 WHEN c.kind='signal' AND (json_extract(s.payload,'$.symbol') IS NULL OR json_extract(s.payload,'$.symbol')=json_extract(c.payload,'$.symbol')) THEN json_extract(c.payload,'$.symbol')
 WHEN c.kind='job' AND json_extract(c.payload,'$.type') IN ('backtest','walk-forward') THEN json_extract(s.payload,'$.symbol') END AS symbol,
 CASE WHEN c.kind='snapshot' THEN json_extract(c.payload,'$.name') ELSE json_extract(s.payload,'$.name') END AS archivedName
 FROM source r
 LEFT JOIN records c ON r.kind='report' AND c.id=json_extract(r.body,'$[1]')
 LEFT JOIN records s ON s.kind='snapshot' AND s.id=CASE WHEN c.kind='signal' THEN json_extract(c.payload,'$.snapshotId') WHEN c.kind='job' THEN json_extract(c.payload,'$.input.snapshotId') END
)
`;

export function researchArchiveHistory(
  raw: ArchiveFilter & { cursor?: unknown },
) {
  const input = archiveHistoryInput.parse(raw);
  const kinds = [...new Set(input.kinds ?? archiveKinds)].sort();
  const filters = {
    kinds,
    symbol: input.symbol ?? null,
    keyword: input.keyword ?? "",
    from: input.from ?? null,
    to: input.to ?? null,
  };
  const filter = createHash("sha256")
    .update(JSON.stringify(filters))
    .digest("hex");
  if (input.cursor && input.cursor.filter !== filter)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "筛选条件已改变，请回到最新报告。",
    });
  const where = [`kind IN (${kinds.map(() => "?").join(",")})`];
  const args: (string | number)[] = [...kinds];
  if (input.symbol) {
    where.push("symbol=?");
    args.push(input.symbol);
  }
  if (input.keyword) {
    where.push(
      "(instr(lower(CAST(title AS TEXT)),lower(?))>0 OR instr(lower(id),lower(?))>0)",
    );
    args.push(input.keyword, input.keyword);
  }
  if (input.from) {
    where.push("createdAt>=?");
    args.push(Date.parse(`${input.from}T00:00:00+08:00`));
  }
  // Unknown timestamps are never part of a date interval, including to-only
  // filters or a range whose lower bound predates the Unix epoch.
  if (input.from || input.to) where.push("createdAt>=0");
  if (input.to) {
    where.push("createdAt<?");
    args.push(Date.parse(`${input.to}T00:00:00+08:00`) + 86400000);
  }
  const condition = where.join(" AND ");
  const db = sqlite();
  return db.transaction(() => {
    const pageArgs = [...args];
    let boundary = "";
    if (input.cursor) {
      boundary = " WHERE (createdAt,kind,id)<(?,?,?)";
      pageArgs.push(input.cursor.createdAt, input.cursor.kind, input.cursor.id);
    }
    // Materialize bounded metadata once for both count and page. JSONB is only
    // an in-query parse representation; stored reports remain original text.
    const result = db
      .prepare(
        projection +
          `, filtered AS MATERIALIZED (
            SELECT id,kind,createdAt,substr(CAST(title AS TEXT),1,128) title,symbol,substr(CAST(archivedName AS TEXT),1,80) archivedName,valid,typeof(title) titleType FROM projected WHERE ${condition}
          )
          SELECT page.*, totals.n FROM (SELECT count(*) n FROM filtered) totals
          LEFT JOIN (SELECT * FROM filtered${boundary} ORDER BY createdAt DESC,kind DESC,id DESC LIMIT 21) page ON 1
          ORDER BY page.createdAt DESC,page.kind DESC,page.id DESC`,
      )
      .all(...pageArgs) as {
      id: string | null;
      n: number;
      kind: (typeof archiveKinds)[number];
      createdAt: number;
      title: string | null;
      symbol: unknown;
      archivedName: string | null;
      valid: number;
      titleType: string;
    }[];
    const filteredTotal = result[0]!.n;
    const rows = result.filter(
      (row): row is typeof row & { id: string } => row.id !== null,
    );
    const items = rows.slice(0, 20).map((row) => {
      const symbol = symbolSchema.safeParse(row.symbol);
      const readable =
        !!row.valid &&
        row.titleType === "text" &&
        !!row.title &&
        (row.kind === "report" ||
          new RegExp(`^${row.kind}-[a-f0-9]{64}$`).test(row.id));
      return {
        id: row.id,
        kind: row.kind,
        createdAt: row.createdAt === -1 ? null : row.createdAt,
        title: readable ? taskTextPreview(row.title!, 128) : "报告元数据不完整",
        readable,
        securityContext: symbol.success
          ? { symbol: symbol.data, archivedName: row.archivedName ?? undefined }
          : null,
      };
    });
    const last = rows[Math.min(rows.length, 20) - 1];
    return {
      items,
      filteredTotal,
      nextCursor:
        rows.length > 20 && last
          ? { createdAt: last.createdAt, kind: last.kind, id: last.id, filter }
          : null,
    };
  })();
}
