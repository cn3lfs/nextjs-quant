import { readSnapshot } from "./snapshot";
import { z } from "zod";
import { sqlite } from "./index";
import type { Item, Batch } from "../jobs/five-minute-batch";
const pageIndex = z.number().int().min(0).max(1000000);
export function fiveMinuteItemsPage(id: string, page: number, filter: string) {
  z.string().uuid().parse(id);
  pageIndex.parse(page);
  const prefix = `tdx-import-item-${id}-`;
  return sqlite().transaction(() => {
    const where = "kind='tdx-import-item' AND id >= ? AND id < ?";
    const filters: Record<string, string> = {
      failed:
        "json_extract(payload, '$.state') = 'failed' OR json_extract(payload, '$.restoredError') IS NOT NULL",
      skipped: "json_extract(payload, '$.state') = 'skipped'",
      conflicts: "json_extract(payload, '$.conflicts') > 0",
      overflow: "json_array_length(payload, '$.overflowTimes') > 0",
      prepared: "json_extract(payload, '$.state') = 'prepared'",
      written: "json_extract(payload, '$.state') = 'written'",
      restored: "json_extract(payload, '$.state') = 'restored'",
    };
    if (filter && !filters[filter]) throw new Error("明细筛选无效");
    const selectedWhere = where + (filter ? ` AND (${filters[filter]})` : "");
    const args = [prefix, prefix + "\uffff"];
    const rows = sqlite()
      .prepare(
        `SELECT payload FROM records WHERE ${selectedWhere} ORDER BY id LIMIT 50 OFFSET ?`,
      )
      .all(...args, page * 50) as { payload: string }[];
    const count = sqlite()
      .prepare(`SELECT count(*) AS n FROM records WHERE ${selectedWhere}`)
      .get(...args) as { n: number };
    const summary = sqlite()
      .prepare(
        `SELECT
    coalesce(sum(json_extract(payload,'$.added')),0) AS added,
    coalesce(sum(json_extract(payload,'$.conflicts')),0) AS conflicts,
    coalesce(sum(json_extract(payload,'$.identical')),0) AS identical,
    coalesce(sum(CASE WHEN json_extract(payload,'$.state')='failed' OR json_extract(payload,'$.restoredError') IS NOT NULL THEN 1 ELSE 0 END),0) AS errors,
    coalesce(sum(CASE WHEN json_extract(payload,'$.state')='skipped' THEN 1 ELSE 0 END),0) AS skipped,
    coalesce(sum(CASE WHEN json_extract(payload,'$.state')='written' THEN 1 ELSE 0 END),0) AS written,
    coalesce(sum(CASE WHEN json_extract(payload,'$.targetMissing')=1 THEN 1 ELSE 0 END),0) AS newFiles,
    coalesce(sum(json_array_length(payload,'$.overflowTimes')),0) AS overflow,
    coalesce(sum(CASE WHEN json_extract(payload,'$.added')>0 THEN coalesce(json_extract(payload,'$.bytes'),0) ELSE 0 END),0) AS backupBytes
    FROM records WHERE ${where}`,
      )
      .get(...args) as {
      added: number;
      conflicts: number;
      identical: number;
      errors: number;
      skipped: number;
      written: number;
      newFiles: number;
      overflow: number;
      backupBytes: number;
    };
    return {
      total: count.n,
      items: rows.map((row) => JSON.parse(row.payload) as Item),
      summary,
    };
  })();
}
export function fiveMinuteHistoryPage(page: number) {
  pageIndex.parse(page);
  return sqlite().transaction(() => {
    const rows = sqlite()
      .prepare(
        "SELECT payload FROM records WHERE kind = 'tdx-import' ORDER BY updated_at DESC, id DESC LIMIT 50 OFFSET ?",
      )
      .all(page * 50) as { payload: string }[];
    const total = sqlite()
      .prepare("SELECT count(*) AS n FROM records WHERE kind = 'tdx-import'")
      .get() as { n: number };
    return {
      items: rows.map((row) => JSON.parse(row.payload) as Batch),
      total: total.n,
    };
  })();
}

export function loadFiveMinuteItems(id: string): Item[] {
  z.string().uuid().parse(id);
  const prefix = `tdx-import-item-${id}-`;
  return readSnapshot(() =>
    Array.from(
      sqlite()
        .prepare(
          "SELECT payload FROM records WHERE kind='tdx-import-item' AND id>=? AND id<? ORDER BY id",
        )
        .iterate(prefix, prefix + "\uffff") as Iterable<{ payload: string }>,
      (row) => JSON.parse(row.payload) as Item,
    ),
  );
}
