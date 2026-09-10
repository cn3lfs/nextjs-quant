import { z } from "zod";
import { sqlite } from "./db";
import { taskTextPreview } from "./task-history";
import { reportSecurityContext } from "./report-security";
import type { Report } from "~/lib/domain";

export const reportHistoryInput = z.object({
  cursor: z
    .object({
      createdAt: z.number().finite(),
      id: z.string().min(1).max(200),
    })
    .optional(),
});
export function reportHistory(input: z.infer<typeof reportHistoryInput>) {
  const connection = sqlite();
  return connection.transaction(() => {
    const rows = connection
      .prepare(
        `SELECT id,
      json_extract(payload, '$.createdAt') AS createdAt,
      json_extract(payload, '$.contextId') AS contextId,
      substr(json_extract(payload, '$.title'), 1, 128) AS title
      FROM records WHERE kind='report'
      AND (? IS NULL OR json_extract(payload, '$.createdAt') < ?
        OR (json_extract(payload, '$.createdAt') = ? AND id < ?))
      ORDER BY json_extract(payload, '$.createdAt') DESC, id DESC LIMIT 21
    `,
      )
      .all(
        input.cursor?.createdAt ?? null,
        input.cursor?.createdAt ?? null,
        input.cursor?.createdAt ?? null,
        input.cursor?.id ?? null,
      ) as {
      id: string;
      createdAt: number;
      title: string;
      contextId: string;
    }[];
    const items = rows.slice(0, 20).map(({ contextId, ...row }) => ({
      ...row,
      title: taskTextPreview(row.title ?? "", 128),
      securityContext: reportSecurityContext(contextId),
    }));
    const last = items.at(-1);
    return {
      items,
      total: (
        connection
          .prepare("SELECT count(*) AS n FROM records WHERE kind='report'")
          .get() as { n: number }
      ).n,
      nextCursor:
        rows.length > 20 && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  })();
}
export function archivedReport(id: string) {
  const row = sqlite()
    .prepare("SELECT payload FROM records WHERE kind='report' AND id=?")
    .get(id) as { payload: string } | undefined;
  if (!row) return null;
  const report = JSON.parse(row.payload) as Report;
  return {
    ...report,
    securityContext: reportSecurityContext(report.contextId),
  };
}
