import { createHash } from "node:crypto";
import { z } from "zod";
import { symbolSchema } from "~/lib/domain";
import {
  chinaDate,
  type SecurityTradingStatus,
} from "~/lib/market/security-trading-status";
import { get, put } from "../db";
import { isAStock } from "../data-sources/tdx/tdx";
import { request } from "../data-sources/hithink/hithink-context";

const table = z.object({
  status_code: z.literal(0),
  code_count: z.literal(1),
  datas: z.array(z.record(z.unknown())).length(1),
  columns: z.array(
    z.object({
      key: z.string(),
      index_name: z.string().optional(),
      type: z.string().optional(),
      timestamp: z.string().optional(),
    }),
  ),
});
export function parseSecurityTradingStatus(
  symbol: string,
  raw: unknown,
  fetchedAt: number,
): SecurityTradingStatus {
  symbolSchema.parse(symbol);
  if (!isAStock(symbol)) throw new Error("仅支持 A 股交易状态核验");
  const data = table.parse(raw),
    row = data.datas[0]!;
  if (row.股票代码 !== `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`)
    throw new Error("交易状态证券身份不匹配");
  const today = chinaDate(fetchedAt),
    stamp = today.replaceAll("-", "");
  const statusKey = `交易状态[${stamp}]`,
    suspendedKey = `停牌[${stamp}]`;
  const validColumn = (key: string, index: string, type: string) => {
    const columns = data.columns.filter((column) => column.key === key);
    return (
      columns.length === 1 &&
      columns[0]!.index_name === index &&
      columns[0]!.type === type &&
      columns[0]!.timestamp === stamp
    );
  };
  const valid =
    validColumn(statusKey, "交易状态", "STR") &&
    validColumn(suspendedKey, "停牌", "BOOLEAN");
  const value = row[statusKey],
    suspended = row[suspendedKey];
  const status = !valid
    ? "unknown"
    : value === "交易" && suspended === false
      ? "trading"
      : value === "停牌" && suspended === true
        ? "suspended"
        : "unknown";
  const reason = !valid
    ? "来源未提供当日一致的状态日期、类型和指标语义"
    : status === "trading"
      ? "来源当日状态为交易，停牌标志为否"
      : status === "suspended"
        ? "来源当日状态为停牌，停牌标志为是"
        : "交易状态与停牌标志缺失、冲突或未识别";
  const columns = data.columns.filter(
    (column) =>
      column.key === "股票代码" || /^(交易状态|停牌)\[/.test(column.key),
  );
  const keys = new Set(["股票代码", ...columns.map((column) => column.key)]);
  const evidence = {
    row: Object.fromEntries(
      Object.entries(row).filter(([key]) => keys.has(key)),
    ),
    columns,
  };
  return {
    version: "security-trading-status-1",
    symbol,
    status,
    asOf: valid ? today : null,
    fetchedAt,
    source: "同花顺问财 / hithink-market-query",
    reason,
    evidence,
    evidenceHash: createHash("sha256")
      .update(JSON.stringify(evidence))
      .digest("hex"),
  };
}
export function storedSecurityTradingStatus(symbol: string) {
  return (
    get<SecurityTradingStatus>(`security-trading-status-${symbol}`) ?? null
  );
}
const inflight = new Map<string, Promise<SecurityTradingStatus>>();
export async function verifySecurityTradingStatus(symbol: string) {
  symbolSchema.parse(symbol);
  if (!isAStock(symbol)) throw new Error("仅支持 A 股交易状态核验");
  const now = Date.now(),
    saved = storedSecurityTradingStatus(symbol);
  if (
    saved?.version === "security-trading-status-1" &&
    saved.asOf === chinaDate(now) &&
    now >= saved.fetchedAt &&
    now - saved.fetchedAt < 60000
  )
    return saved;
  const active = inflight.get(symbol);
  if (active) return active;
  const pending = (async () => {
    if (!process.env.IWENCAI_API_KEY)
      throw new Error("未配置问财凭证，交易状态未核验");
    const code = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
    const raw = await request(
      "hithink-market-query",
      `${code} 股票代码 交易状态 停牌状态 最新交易日`,
    );
    const result = parseSecurityTradingStatus(symbol, raw, Date.now());
    return put(
      "security-trading-status",
      `security-trading-status-${symbol}`,
      result,
    );
  })();
  inflight.set(symbol, pending);
  try {
    return await pending;
  } finally {
    if (inflight.get(symbol) === pending) inflight.delete(symbol);
  }
}
