import { z } from "zod";
import { emFetch } from "./em-fetch";

/**
 * 东方财富数据中心（datacenter-web）统一查询。事件、解禁、两融、大宗、股东户数、
 * 龙虎榜等报表共用同一入口，只是 reportName / filter 不同。
 * 报表名与字段参考 simonlin1212/a-stock-data（Apache-2.0）并经 2026-09 在线核对。
 */
export const DATACENTER_URL =
  "https://datacenter-web.eastmoney.com/api/data/v1/get";

export type DatacenterQuery = {
  report: string;
  filter?: string;
  sortColumns?: string;
  sortTypes?: string;
  pageSize?: number;
  columns?: string;
};

const envelopeSchema = z.object({
  success: z.boolean(),
  message: z.string().nullish(),
  result: z
    .object({ data: z.array(z.record(z.unknown())).nullish() })
    .nullish(),
});

export type DatacenterRow = Record<string, unknown>;

/** 查询无记录时东财返回 success=false「返回数据为空」，这里统一当作空表。 */
export function parseDatacenter(raw: unknown): DatacenterRow[] {
  const checked = envelopeSchema.safeParse(raw);
  if (!checked.success) throw new Error("东方财富数据中心响应格式无效");
  const { success, message, result } = checked.data;
  if (!success) {
    if (message?.includes("数据为空")) return [];
    throw new Error(`东方财富数据中心：${message ?? "查询失败"}`);
  }
  return result?.data ?? [];
}

export async function datacenterQuery(
  query: DatacenterQuery,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<DatacenterRow[]> {
  const url = new URL(DATACENTER_URL);
  url.search = new URLSearchParams({
    reportName: query.report,
    columns: query.columns ?? "ALL",
    filter: query.filter ?? "",
    pageNumber: "1",
    pageSize: String(query.pageSize ?? 50),
    sortColumns: query.sortColumns ?? "",
    sortTypes: query.sortTypes ?? "-1",
    source: "WEB",
    client: "WEB",
  }).toString();
  const response = await emFetch(url, { signal }, fetcher);
  if (!response.ok) throw new Error(`东方财富 HTTP ${response.status}`);
  return parseDatacenter(await response.json());
}

/** Field readers for loosely typed report rows. */
export const dcText = (row: DatacenterRow, key: string) => {
  const v = row[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
export const dcNum = (row: DatacenterRow, key: string) => {
  const v = row[key];
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
export const dcDay = (row: DatacenterRow, key: string) =>
  dcText(row, key)?.slice(0, 10) ?? null;
