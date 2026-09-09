import { createHash } from "node:crypto";
import { z } from "zod";
import { symbolSchema } from "~/lib/domain";
import { get, put } from "./db";
import { request } from "./hithink-context";
import { isAStock } from "./tdx";

const responseSchema = z.object({
  status_code: z.literal(0),
  code_count: z.number().int().nonnegative(),
  datas: z.array(z.record(z.unknown())),
  columns: z.array(
    z.object({
      key: z.string(),
      type: z.string().optional(),
      index_name: z.string().optional(),
    }),
  ),
});
export function parseSecurityLifecycle(
  symbol: string,
  raw: unknown,
  fetchedAt: number,
) {
  symbolSchema.parse(symbol);
  if (!isAStock(symbol)) throw new Error("仅支持 A 股上市资料核验");
  const data = responseSchema.parse(raw);
  if (data.code_count === 0 && data.datas.length === 0)
    throw new Error(
      "同花顺问财未返回该证券的上市资料；不代表该证券未上市或未退市",
    );
  if (data.code_count !== 1 || data.datas.length !== 1)
    throw new Error("上市资料未唯一、完整返回，不能核验证券日期");
  const row = data.datas[0]!;
  const market = { sh: "上海", sz: "深圳", bj: "北京" }[symbol.slice(0, 2)];
  if (
    row.股票代码 !== `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}` ||
    row.上市地点 !== market
  )
    throw new Error("上市资料代码或交易所不匹配");
  const warnings: string[] = [];
  function date(key: string) {
    const columns = data.columns.filter((column) => column.key === key);
    const value = row[key];
    if (
      columns.length !== 1 ||
      columns[0]!.type !== "DATE" ||
      columns[0]!.index_name !==
        (key === "上市日期" ? "新股上市日期" : "退市@退市日期") ||
      typeof value !== "string" ||
      !/^\d{8}$/.test(value)
    ) {
      warnings.push(`${key}缺失或字段类型未核验`);
      return null;
    }
    const formatted = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    const time = Date.parse(formatted);
    if (
      !Number.isFinite(time) ||
      new Date(time).toISOString().slice(0, 10) !== formatted
    ) {
      warnings.push(`${key}不是有效日期`);
      return null;
    }
    return formatted;
  }
  const listingDate = date("上市日期");
  let delistingDate = date("退市日期");
  if (listingDate && delistingDate && delistingDate < listingDate) {
    warnings.push("退市日期早于上市日期，未采纳退市日期");
    delistingDate = null;
  }
  // Only retain the fields used for identity/date verification, never remote tokens.
  const fields = ["股票代码", "上市地点", "上市日期", "退市日期"];
  const evidence = {
    row: Object.fromEntries(
      fields.filter((key) => key in row).map((key) => [key, row[key]]),
    ),
    columns: data.columns.filter((column) => fields.includes(column.key)),
  };
  return {
    version: "security-lifecycle-2" as const,
    symbol,
    source: "同花顺问财 / hithink-basicinfo-query" as const,
    fetchedAt,
    listingDate,
    delistingDate,
    evidence,
    evidenceHash: createHash("sha256")
      .update(JSON.stringify(evidence))
      .digest("hex"),
    warnings,
  };
}
export type SecurityLifecycle = ReturnType<typeof parseSecurityLifecycle>;
export function storedSecurityLifecycle(symbol: string) {
  return get<SecurityLifecycle>(`security-lifecycle-${symbol}`) ?? null;
}
const inflight = new Map<string, Promise<SecurityLifecycle>>();
export async function verifySecurityLifecycle(symbol: string) {
  symbolSchema.parse(symbol);
  if (!isAStock(symbol)) throw new Error("仅支持 A 股上市资料核验");
  const saved = storedSecurityLifecycle(symbol);
  if (
    saved?.version === "security-lifecycle-2" &&
    Date.now() - saved.fetchedAt < 86400000
  )
    return saved;
  const running = inflight.get(symbol);
  if (running) return running;
  const pending = (async () => {
    if (!process.env.IWENCAI_API_KEY)
      throw new Error("未配置问财凭证，上市资料暂不可核验");
    const code = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
    const query = `${code} A股 股票代码 股票简称 上市日期 退市日期`;
    const raw = await request("hithink-basicinfo-query", query);
    const result = parseSecurityLifecycle(symbol, raw, Date.now());
    return put("security-lifecycle", `security-lifecycle-${symbol}`, result);
  })();
  inflight.set(symbol, pending);
  try {
    return await pending;
  } finally {
    if (inflight.get(symbol) === pending) inflight.delete(symbol);
  }
}
