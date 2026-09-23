import { z } from "zod";
import { chartPeriodSchema, isMinutePeriod } from "~/lib/chart/chart-view";
import type { Bar } from "~/lib/domain";
import { isMarketIndex } from "~/lib/market/market-indices";
import { query, westockScriptPath } from "./westock-data";
import { parseWestockBars } from "./westock-bars";

export const WESTOCK_ADAPTER_VERSION = "westock-adapter-2";
const symbol = z.string().regex(/^(?:(?:sh|sz|bj)\d{6}|pt[0-9A-Z]{6,12})$/);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const time = Date.parse(value);
    return (
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === value
    );
  }, "日期无效");
const inputSchema = z
  .object({
    symbols: z
      .array(symbol)
      .min(1)
      .max(80)
      .refine((v) => new Set(v).size === v.length, "证券重复"),
    period: chartPeriodSchema,
    limit: z.number().int().min(1).max(20000).default(2000),
    adjustment: z.enum(["none", "qfq", "hfq"]).default("none"),
    start: day.optional(),
    end: day.optional(),
  })
  .strict();
export type WestockKlineInput = z.input<typeof inputSchema>;
export type WestockKlineItem =
  | {
      symbol: string;
      status: "ok";
      bars: Bar[];
      rows: Record<string, unknown>[];
    }
  | {
      symbol: string;
      status: "unsupported" | "unavailable" | "invalid";
      message: string;
    };
type Execute = typeof query;
export function westockAssetKind(code: string) {
  symbol.parse(code);
  if (code.startsWith("pt")) return "sector";
  if (isMarketIndex(code)) return "index";
  if (code.startsWith("bj")) return "beijing";
  return "security";
}

/** Domestic chart adapter. Other skill dimensions retain their own schemas, never cast as OHLC. */
export async function westockKlines(
  input: WestockKlineInput,
  signal?: AbortSignal,
  execute: Execute = query,
) {
  const value = inputSchema.parse(input);
  signal?.throwIfAborted();
  const minute = isMinutePeriod(value.period);
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const earliest = new Date(Date.parse(today) - 28 * 86400000)
    .toISOString()
    .slice(0, 10);
  const start = value.start ?? (minute ? earliest : undefined);
  const end = value.end ?? (minute ? today : undefined);
  if (
    (start && end && start > end) ||
    (end && end > today) ||
    (start && start > today)
  )
    throw new Error("westock-data 日期区间非法或位于未来");
  if (minute && (value.adjustment !== "none" || start! < earliest))
    throw new Error("westock-data 分钟线只接受近28天的不复权数据");
  const count = Math.min(value.limit, 2000);
  const warnings: string[] =
    value.limit > count ? ["请求深度超过上限，限制为2000根"] : [];
  warnings.push("部分量额字段可能取整，保留原值；未核验单位不得跨源拼接");
  if (value.symbols.some((code) => westockAssetKind(code) === "index"))
    warnings.push("指数成交量与其他源存在倍率差异，不能统一解释为股或手");
  const items = new Map<string, WestockKlineItem>();
  const eligible = value.symbols.filter((code) => {
    if (
      minute &&
      ["beijing", "index", "sector"].includes(westockAssetKind(code))
    ) {
      items.set(code, {
        symbol: code,
        status: "unsupported",
        message: `westock-data 当前不支持 ${code} 的${value.period}分钟线（KLINE_001）`,
      });
      return false;
    }
    return true;
  });
  const requests: {
    symbols: string[];
    args: string[];
    startedAt: number;
    completedAt?: number;
  }[] = [];
  async function fetchBatch(codes: string[]) {
    signal?.throwIfAborted();
    const args = [
      "kline",
      codes.join(","),
      "--period",
      minute ? `m${value.period.slice(0, -1)}` : value.period,
      "--limit",
      String(count),
      "--fq",
      value.adjustment === "none" ? "bfq" : value.adjustment,
      ...(start ? ["--start", start] : []),
      ...(end ? ["--end", end] : []),
    ];
    const request = {
      symbols: codes,
      args,
      startedAt: Date.now(),
      completedAt: undefined as number | undefined,
    };
    requests.push(request);
    try {
      const raw = await execute(westockScriptPath(), args, signal);
      signal?.throwIfAborted();
      if (!Array.isArray(raw)) throw new Error("westock-data K线响应不是数组");
      const rows = raw.map((row) => z.record(z.unknown()).parse(row));
      if (
        rows.some((row) =>
          row.symbol !== undefined
            ? !codes.includes(String(row.symbol))
            : codes.length !== 1,
        )
      )
        throw new Error("westock-data 批量返回未知证券或缺少身份字段");
      for (const code of codes) {
        const selected = rows.filter(
          (row) => codes.length === 1 || row.symbol === code,
        );
        if (!selected.length) continue;
        try {
          const bars = parseWestockBars(selected, code, value.period);
          if (
            bars.length > count ||
            bars.some(
              (bar) =>
                (start && bar.date.slice(0, 10) < start) ||
                (end && bar.date.slice(0, 10) > end) ||
                bar.date.slice(0, 10) > today,
            )
          )
            throw new Error("行情超出请求日期或数量范围");
          items.set(code, {
            symbol: code,
            status: "ok",
            bars,
            rows: selected.map((row) => ({ ...row, symbol: code })),
          });
        } catch (error) {
          items.set(code, {
            symbol: code,
            status: "invalid",
            message: String(error),
          });
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      for (const code of codes)
        items.set(code, {
          symbol: code,
          status: "unavailable",
          message:
            error instanceof Error ? error.message : "westock-data 查询失败",
        });
    } finally {
      request.completedAt = Date.now();
    }
  }
  if (eligible.length) await fetchBatch(eligible);
  // Observed SDK defect: index+sector+ETF drops the ETF. Retry ONLY missing codes once,
  // as one batch on the same source; retain provenance and never silently accept omission.
  const missing = eligible.filter((code) => !items.has(code));
  if (missing.length && eligible.length > 1) {
    warnings.push(`首次批量遗漏 ${missing.join(",")}，已在同源补查一次`);
    await fetchBatch(missing);
  }
  for (const code of eligible)
    if (!items.has(code))
      items.set(code, {
        symbol: code,
        status: "unavailable",
        message: "westock-data 未返回行情，缺失不得补造",
      });
  return {
    version: WESTOCK_ADAPTER_VERSION,
    source: "tencent/westock-data" as const,
    adjustment: value.adjustment,
    period: value.period,
    limit: count,
    start,
    end,
    currency: "CNY",
    volumeUnit: "源单位未独立核验",
    delayed: true,
    warnings,
    requests,
    items: value.symbols.map((code) => items.get(code)!),
  };
}

export function requireWestockRows(
  result: Awaited<ReturnType<typeof westockKlines>>,
) {
  const failures = result.items.filter((item) => item.status !== "ok");
  if (failures.length)
    throw new Error(
      failures.map((item) => `${item.symbol}: ${item.message}`).join("；"),
    );
  return result.items.flatMap((item) =>
    item.status === "ok" ? item.rows : [],
  );
}

const searchSchema = z.object({
  keyword: z.string().trim().min(1).max(100),
  type: z
    .enum(["stock", "etf", "index", "sector", "bond", "futures", "forex"])
    .default("stock"),
  limit: z.number().int().min(1).max(100).default(20),
});
export async function westockSearch(
  input: z.input<typeof searchSchema>,
  signal?: AbortSignal,
) {
  const value = searchSchema.parse(input);
  const raw = await query(
    westockScriptPath(),
    [
      "search",
      value.keyword,
      "--type",
      value.type,
      "--limit",
      String(value.limit),
    ],
    signal,
  );
  return z
    .array(
      z
        .object({
          code: z.string().min(1),
          name: z.string().min(1),
          type: z.string().optional(),
          分类: z.string().optional(),
        })
        .passthrough(),
    )
    .parse(raw);
}
