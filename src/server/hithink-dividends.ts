import { createHash } from "node:crypto";
import { z } from "zod";
import { request } from "./hithink-context";
import { isAStock } from "./tdx";
import { sharedRead } from "./shared-read";

const date = z
  .string()
  .regex(/^\d{8}$/)
  .refine((v) => {
    const day = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}`;
    const n = Date.parse(day);
    return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === day;
  });
const definitions = {
  announcement: ["实施公告日", "分红实施公告日", "DATE", ""],
  record: ["股权登记日", "股权登记日", "DATE", ""],
  ex: ["除权除息日", "除权除息日", "DATE", ""],
  pay: ["派息日", "派息日", "DATE", ""],
  listing: ["红股上市日", "红股上市交易日", "DATE", ""],
  dividend: ["税前每股股利", "每股股利(税前)", "DOUBLE", "元"],
  transfer: ["每股转增股本", "每股转增股本", "DOUBLE", "股"],
} as const;
const schema = z.object({
  status_code: z.literal(0),
  code_count: z.literal(1),
  row_count: z.literal(1),
  datas: z.array(z.record(z.unknown())).length(1),
  columns: z
    .array(
      z.object({
        key: z.string(),
        index_name: z.string(),
        type: z.string(),
        unit: z.string().optional(),
        timestamp: z.string().optional(),
      }),
    )
    .max(2000),
});
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function dividendSchedule(
  symbol: string,
  raw: unknown,
  fetchedAt: number,
) {
  if (!isAStock(symbol) || !Number.isFinite(fetchedAt) || fetchedAt <= 0)
    throw new Error("分红来源身份或采集时间非法");
  const table = schema.parse(raw),
    row = table.datas[0]!;
  if (
    row["股票代码"] !== `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`
  )
    throw new Error("分红证券身份不符");
  const columns = new Map(table.columns.map((c) => [c.key, c]));
  if (columns.size !== table.columns.length) throw new Error("分红列重复");
  const periods = table.columns
    .filter((c) => c.index_name === "除权除息日")
    .map((c) => date.parse(c.timestamp));
  if (!periods.length || new Set(periods).size !== periods.length)
    throw new Error("分红报告期缺失或重复");
  const today = new Date(fetchedAt + 8 * 3600000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
  const events = [];
  let withoutExDate = 0;
  for (const period of periods) {
    const fields: Record<keyof typeof definitions, string | number | null> =
      {} as never;
    for (const [name, [prefix, index, type, unit]] of Object.entries(
      definitions,
    )) {
      const key = `${prefix}[${period}]`,
        column = columns.get(key);
      if (
        !column ||
        column.index_name !== index ||
        column.type !== type ||
        (column.unit ?? "") !== unit ||
        column.timestamp !== period
      )
        throw new Error(
          `分红明细字段口径不符：${name}；不能使用年度汇总替代单次金额`,
        );
      const v = row[key];
      fields[name as keyof typeof definitions] =
        v === undefined || v === null || v === "--"
          ? null
          : type === "DATE"
            ? date.parse(v)
            : z.number().finite().nonnegative().parse(v);
    }
    if (fields.ex === null) {
      withoutExDate++;
      continue;
    }
    if (typeof fields.ex !== "string" || fields.ex > today)
      throw new Error("分红除权时点晚于采集日");
    for (const k of ["announcement", "record", "pay", "listing"] as const)
      if (fields[k] !== null && typeof fields[k] !== "string")
        throw new Error("分红日期类型错误");
    if (fields.record && fields.record >= fields.ex)
      throw new Error("登记日未早于除权日");
    if (
      fields.announcement &&
      fields.record &&
      fields.announcement > fields.record
    )
      throw new Error("实施公告晚于登记日");
    if (fields.pay && fields.pay < fields.ex)
      throw new Error("派息日早于除权日");
    if (fields.listing && fields.listing < fields.ex)
      throw new Error("红股上市早于除权日");
    events.push({ period, ...fields });
  }
  events.sort((a, b) => String(a.ex).localeCompare(String(b.ex)));
  if (new Set(events.map((e) => e.ex)).size !== events.length)
    throw new Error("同除权日对应多条明细，尚未核验事件合并");
  const payload = {
    version: "hithink-dividends-1" as const,
    symbol,
    fetchedAt,
    source: "同花顺问财",
    events,
    withoutExDate,
    warnings: [
      "报告期不是到账日期；每股股利(税前)为当前明细口径，不使用年度税前每股股利汇总。",
      "缺失日期保留null；无除权日的报告期不作为已实施事件。当前历史查询不是公告当时的采集档案。",
      "转增不等于全部送股；未提供差别化红利税、逐批持仓税基及配股选择，尚不能直接生成净现金流水。",
    ],
    raw: table,
  };
  return { ...payload, hash: digest(payload) };
}
const shared = sharedRead<ReturnType<typeof dividendSchedule>>();
export function queryDividendSchedule(symbol: string, signal?: AbortSignal) {
  if (!isAStock(symbol)) throw new Error("分红查询仅支持A股");
  return shared(
    symbol,
    async (s) => {
      if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
      const query = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()} 历史分红明细 分红实施公告日 股权登记日 除权除息日 派息日 红股上市日 每10股派现(含税) 每10股送股 每10股转增`;
      const raw = await request("hithink-event-query", query, s, 1, 10);
      s.throwIfAborted();
      return dividendSchedule(symbol, raw, Date.now());
    },
    signal,
  );
}
