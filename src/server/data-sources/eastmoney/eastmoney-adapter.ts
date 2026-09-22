import { z } from "zod";
import type { Bar } from "~/lib/domain";
import { chartPeriodSchema, isMinutePeriod } from "~/lib/chart-view";
import {
  eastmoneyIdentity,
  eastmoneySymbolSchema,
  parseOnlineChart,
} from "./eastmoney-bars";

export const EASTMONEY_ADAPTER_VERSION = "eastmoney-adapter-1";
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
    "日期无效",
  );
const inputSchema = z
  .object({
    symbols: z
      .array(z.string().min(1).max(24))
      .min(1)
      .max(80)
      .refine((values) => new Set(values).size === values.length, "证券重复"),
    period: chartPeriodSchema,
    limit: z.number().int().min(1).max(20000).default(2000),
    start: day.optional(),
    end: day.optional(),
    adjustment: z.enum(["none", "qfq", "hfq"]).default("none"),
  })
  .strict();
export type EastmoneyKlineInput = z.input<typeof inputSchema>;
export type EastmoneyKlineItem =
  | {
      symbol: string;
      status: "ok";
      name: string;
      bars: Bar[];
      sourceUrl: string;
      historyExhausted: boolean;
      returnedCount: number;
    }
  | {
      symbol: string;
      status: "unsupported" | "unavailable" | "invalid";
      message: string;
    };

async function readJson(response: Response) {
  if (!response.ok) throw new Error(`东方财富 HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("东方财富响应为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error("东方财富响应超过读取上限");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** 批量逐项执行；不重试、不跨源。原生板块用 emBKxxxx 标识，不能冒充 pt 板块。 */
export async function eastmoneyKlines(
  input: EastmoneyKlineInput,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const value = inputSchema.parse(input);
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  if (
    (value.start && value.start > today) ||
    (value.end && value.end > today) ||
    (value.start && value.end && value.start > value.end)
  )
    throw new Error("日期范围无效");
  const startedAt = Date.now();
  const items: EastmoneyKlineItem[] = [];
  for (const symbol of value.symbols) {
    signal?.throwIfAborted();
    if (!eastmoneySymbolSchema.safeParse(symbol).success) {
      items.push({
        symbol,
        status: "unsupported",
        message: "东方财富仅接受沪深北证券或原生 emBK 板块代码",
      });
      continue;
    }
    const { market, code } = eastmoneyIdentity(symbol);
    const url = new URL(
      "https://push2his.eastmoney.com/api/qt/stock/kline/get",
    );
    url.search = new URLSearchParams({
      secid: `${market}.${code}`,
      fields1: "f1,f2,f3,f4,f5,f6",
      fields2: "f51,f52,f53,f54,f55,f56,f57",
      klt: {
        day: "101",
        week: "102",
        month: "103",
        "5m": "5",
        "15m": "15",
        "30m": "30",
        "60m": "60",
      }[value.period],
      fqt: { none: "0", qfq: "1", hfq: "2" }[value.adjustment],
      beg: value.start?.replaceAll("-", "") ?? "0",
      end: (value.end ?? today).replaceAll("-", ""),
      lmt: String(value.limit),
    }).toString();
    let raw: unknown;
    try {
      const timeout = AbortSignal.timeout(15000);
      raw = await readJson(
        await fetcher(url, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        }),
      );
    } catch (error) {
      signal?.throwIfAborted();
      items.push({
        symbol,
        status: "unavailable",
        message: error instanceof Error ? error.message : "东方财富请求失败",
      });
      continue;
    }
    signal?.throwIfAborted();
    try {
      const envelope = z
        .object({ rc: z.number(), data: z.unknown() })
        .safeParse(raw);
      if (
        envelope.success &&
        (envelope.data.rc !== 0 || envelope.data.data === null)
      ) {
        items.push({
          symbol,
          status: "unavailable",
          message: `东方财富无可用数据（rc=${envelope.data.rc}）`,
        });
        continue;
      }
      const parsed = parseOnlineChart(
        raw,
        symbol,
        isMinutePeriod(value.period) ? "5m" : "day",
      );
      const range = parsed.bars.filter(
        (bar) =>
          (!value.start || bar.date.slice(0, 10) >= value.start) &&
          bar.date.slice(0, 10) <= (value.end ?? today),
      );
      if (!range.length) {
        items.push({
          symbol,
          status: "unavailable",
          message: "东方财富未返回请求区间行情",
        });
        continue;
      }
      items.push({
        symbol,
        status: "ok",
        name: parsed.name,
        bars: range.slice(-value.limit),
        sourceUrl: url.toString(),
        returnedCount: parsed.bars.length,
        historyExhausted: false,
      });
    } catch (error) {
      items.push({
        symbol,
        status: "invalid",
        message: error instanceof Error ? error.message : "东方财富行情无效",
      });
    }
  }
  return {
    version: EASTMONEY_ADAPTER_VERSION,
    source: "eastmoney-online" as const,
    period: value.period,
    adjustment: value.adjustment,
    volumeUnit: "手",
    startedAt,
    completedAt: Date.now(),
    items,
    warnings: [
      "公共接口历史深度未确认；未满请求数量不代表全历史",
      "量额保留源口径，不自动与其他源拼接",
    ],
  };
}
