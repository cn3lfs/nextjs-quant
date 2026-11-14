import { z } from "zod";
import type { MaBaselineArchive } from "../backtest/ma-baseline-work";
import { sqlite } from "./index";
import { jobIdSchema } from "./jobs";
import { readJobResultSnapshot } from "./job-results";
import { readSnapshot } from "./snapshot";

const pageSchema = z.number().int().min(0).max(1000000);
const orderStatusSchema = z.enum(["all", "filled", "rejected", "pending"]);
function baselineStatus(id: string) {
  jobIdSchema.parse(id);
  const row = sqlite()
    .prepare(
      `SELECT json_extract(payload,'$.status') status FROM records
    WHERE kind='job' AND id=? AND json_extract(payload,'$.type')='backtest'
    AND json_extract(payload,'$.input.type')='ma-baseline'`,
    )
    .get(id) as { status: string } | undefined;
  if (!row) throw new Error("策略实验任务不存在");
  return row.status;
}

/** Visible result pages do not deserialize frozen bars or unrequested orders. */
export function readMaBaselineResultPage(id: string, pageIndex: number) {
  pageSchema.parse(pageIndex);
  return readSnapshot(() => {
    if (baselineStatus(id) !== "completed") return null;
    const row = sqlite()
      .prepare(
        `SELECT json_object(
      'summary',json_remove(json_extract(payload,'$.result.result'),'$.fills','$.orders'),
      'manifest',json_extract(payload,'$.result.manifest'),
      'fills',json((SELECT json_group_array(json(value)) FROM
        (SELECT value FROM json_each(records.payload,'$.result.result.fills') ORDER BY CAST(key AS INTEGER) LIMIT 50 OFFSET @offset))),
      'fillCount',json_array_length(payload,'$.result.result.fills'),
      'orderCount',json_array_length(payload,'$.result.result.orders'),
      'rejectedCount',(SELECT count(*) FROM json_each(records.payload,'$.result.result.orders') WHERE json_extract(value,'$.status')='rejected'),
      'pending',json((SELECT json_group_array(json(value)) FROM json_each(records.payload,'$.result.result.orders') WHERE json_extract(value,'$.status')='pending'))
      ) page FROM records WHERE kind='job' AND id=@id`,
      )
      .get({ id, offset: pageIndex * 50 }) as { page: string };
    return JSON.parse(row.page) as {
      summary: Omit<MaBaselineArchive["result"], "fills" | "orders">;
      manifest: MaBaselineArchive["manifest"];
      fills: MaBaselineArchive["result"]["fills"];
      fillCount: number;
      orderCount: number;
      rejectedCount: number;
      pending: MaBaselineArchive["result"]["orders"];
    };
  });
}

export function readMaBaselineOrderPage(
  id: string,
  pageIndex: number,
  status: z.infer<typeof orderStatusSchema>,
) {
  pageSchema.parse(pageIndex);
  orderStatusSchema.parse(status);
  return readSnapshot(() => {
    if (baselineStatus(id) !== "completed") return null;
    const row = sqlite()
      .prepare(
        `WITH selected AS MATERIALIZED (
      SELECT j.value,CAST(j.key AS INTEGER) position FROM records r,json_each(r.payload,'$.result.result.orders') j
      WHERE r.kind='job' AND r.id=@id AND (@status='all' OR json_extract(j.value,'$.status')=@status)
    ) SELECT (SELECT count(*) FROM selected) rowCount,
      (SELECT json_group_array(json(value)) FROM (SELECT value FROM selected ORDER BY position LIMIT 50 OFFSET @offset)) orders`,
      )
      .get({ id, status, offset: pageIndex * 50 }) as {
      rowCount: number;
      orders: string;
    };
    return {
      orders: JSON.parse(row.orders) as MaBaselineArchive["result"]["orders"],
      rowCount: row.rowCount,
    };
  });
}

/** Full export / evaluation explicitly request complete frozen evidence.
 * Assembly retains the complete archive; each transfer is byte/row bounded. */
export function readMaBaselineArchive(id: string): MaBaselineArchive | null {
  return readSnapshot(() => {
    if (baselineStatus(id) !== "completed") return null;
    return readJobResultSnapshot(id, ({ json, array }) => {
      const archive = json<MaBaselineArchive>("$.result", [
        "$.result.fills",
        "$.result.orders",
        "$.result.equity",
        "$.inputSnapshot.bars",
      ]);
      archive.result.fills = [
        ...array<MaBaselineArchive["result"]["fills"][number]>(
          "$.result.result.fills",
        ),
      ];
      archive.result.orders = [
        ...array<MaBaselineArchive["result"]["orders"][number]>(
          "$.result.result.orders",
        ),
      ];
      archive.result.equity = [
        ...array<MaBaselineArchive["result"]["equity"][number]>(
          "$.result.result.equity",
        ),
      ];
      if (archive.inputSnapshot)
        archive.inputSnapshot.bars = [
          ...array<MaBaselineArchive["inputSnapshot"]["bars"][number]>(
            "$.result.inputSnapshot.bars",
          ),
        ];
      return archive;
    });
  });
}
