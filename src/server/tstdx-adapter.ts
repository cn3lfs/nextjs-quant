import { z } from "zod";
import {
  adjustBars,
  createTdxClient,
  isAStock,
  isIndexSymbol,
  type TdxClient,
} from "tstdx";
import {
  chartPeriodSchema,
  isMinutePeriod,
  type ChartPeriod,
} from "~/lib/chart-view";
import type { Bar } from "~/lib/domain";
import { isMarketIndex } from "~/lib/market-indices";
import { isPriceScaleThreeFund } from "~/lib/security-classification";
import { configuredHosts } from "./tdx-quotes";

export const TSTDX_ADAPTER_VERSION = "tstdx-adapter-2";
const symbolSchema = z
  .string()
  .regex(/^(?:(?:sh|sz|bj)\d{6}|pt[0-9A-Z]{6,12})$/);
const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const t = Date.parse(v);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
  }, "日期无效");
const inputSchema = z
  .object({
    symbols: z
      .array(symbolSchema)
      .min(1)
      .max(80)
      .refine((v) => new Set(v).size === v.length, "证券重复"),
    period: chartPeriodSchema,
    limit: z.number().int().min(1).max(20000).default(2000),
    adjustment: z.enum(["none", "qfq", "hfq"]).default("none"),
    start: daySchema.optional(),
    end: daySchema.optional(),
  })
  .strict();
export type TstdxKlineInput = z.input<typeof inputSchema>;
export type TstdxKlineItem =
  | {
      symbol: string;
      status: "ok";
      bars: Bar[];
      rows: Record<string, unknown>[];
      historyExhausted: boolean;
    }
  | {
      symbol: string;
      status: "unsupported" | "unavailable" | "invalid";
      message: string;
    };
type Client = Pick<
  TdxClient,
  | "barPage"
  | "indexBarPage"
  | "xdxr"
  | "stocks"
  | "blockInfo"
  | "minutes"
  | "historyMinutes"
  | "close"
>;
type Factory = () => Client;
const factory: Factory = () => createTdxClient({ hosts: configuredHosts() });
const today = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
class InvalidData extends Error {}
const numeric = z.number().finite();
const barSchema = z.object({
  date: z.string(),
  open: numeric.positive(),
  high: numeric.positive(),
  low: numeric.positive(),
  close: numeric.positive(),
  volume: numeric.nonnegative(),
  amount: numeric.nonnegative(),
});
export function tstdxAssetKind(symbol: string) {
  symbolSchema.parse(symbol);
  if (symbol.startsWith("pt")) return "foreign-sector";
  if (/^sh88\d{4}$/.test(symbol)) return "sector";
  if (isMarketIndex(symbol) || isIndexSymbol(symbol)) return "index";
  if (isPriceScaleThreeFund(symbol)) return "etf";
  return isAStock(symbol) ? "stock" : "security";
}
function checkedBars(raw: unknown, period: ChartPeriod, count: number): Bar[] {
  try {
    const bars = z.array(barSchema).max(count).parse(raw);
    for (const [i, b] of bars.entries()) {
      daySchema.parse(b.date.slice(0, 10));
      const format = isMinutePeriod(period)
        ? /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00\+08:00$/
        : /^\d{4}-\d{2}-\d{2}$/;
      if (
        !format.test(b.date) ||
        b.date.slice(0, 10) > today() ||
        b.low > Math.min(b.open, b.close) ||
        b.high < Math.max(b.open, b.close) ||
        b.date <= (bars[i - 1]?.date ?? "")
      )
        throw Error("日期、顺序或 OHLC 不合法");
    }
    return bars;
  } catch (e) {
    throw new InvalidData(`tstdx 行情校验失败：${String(e)}`);
  }
}
async function withClient<T>(
  make: Factory,
  signal: AbortSignal | undefined,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const client = make();
  const cancel = () => {
    void client.close().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await run(client);
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener("abort", cancel);
    await client.close();
  }
}
export async function tstdxKlines(
  input: TstdxKlineInput,
  signal?: AbortSignal,
  make: Factory = factory,
) {
  const value = inputSchema.parse(input),
    end = value.end ?? today();
  if ((value.start && value.start > end) || end > today())
    throw Error("tstdx 日期区间非法或位于未来");
  signal?.throwIfAborted();
  const requests: {
    symbol: string;
    method: string;
    args: unknown[];
    startedAt: number;
    completedAt?: number;
    error?: string;
  }[] = [];
  const items: TstdxKlineItem[] = [];
  for (const symbol of value.symbols) {
    signal?.throwIfAborted();
    const kind = tstdxAssetKind(symbol),
      adjusted = value.adjustment !== "none";
    if (
      kind === "foreign-sector" ||
      (adjusted && (value.period !== "day" || kind !== "stock"))
    ) {
      items.push({
        symbol,
        status: "unsupported",
        message:
          kind === "foreign-sector"
            ? "腾讯 pt 板块代码不能映射为通达信代码"
            : "tstdx adapter 仅支持 A 股日线复权；其他品种/周期请使用不复权",
      });
      continue;
    }
    try {
      const result = await withClient(make, signal, async (client) => {
        async function request<T>(
          method: string,
          args: unknown[],
          run: () => Promise<T>,
        ) {
          signal?.throwIfAborted();
          const entry: (typeof requests)[number] = {
            symbol,
            method,
            args,
            startedAt: Date.now(),
          };
          requests.push(entry);
          try {
            const data = await run();
            signal?.throwIfAborted();
            return data;
          } catch (error) {
            entry.error = String(error);
            throw error;
          } finally {
            entry.completedAt = Date.now();
          }
        }
        const method =
          kind === "index" || kind === "sector" ? "indexBarPage" : "barPage";
        const rows = new Map<string, Bar>();
        let offset = 0,
          oldest: string | undefined,
          historyExhausted = false,
          stopped = false;
        while (offset <= 65535) {
          const count =
            adjusted || value.start || value.end
              ? 800
              : Math.min(800, value.limit - rows.size);
          const page = checkedBars(
            await request(method, [symbol, value.period, offset, count], () =>
              client[method](symbol, value.period, offset, count),
            ),
            value.period,
            count,
          );
          if (!page.length) {
            historyExhausted = true;
            stopped = true;
            break;
          }
          if (oldest && page[0]!.date >= oldest)
            throw new InvalidData("tstdx 分页无进展或重复");
          oldest = page[0]!.date;
          for (const bar of page) {
            if (
              bar.date.slice(0, 10) > end ||
              (!adjusted && value.start && bar.date.slice(0, 10) < value.start)
            )
              continue;
            const before = rows.get(bar.date);
            if (before && JSON.stringify(before) !== JSON.stringify(bar))
              throw new InvalidData("tstdx 分页重叠行情发生变化");
            rows.set(bar.date, bar);
          }
          if (
            page.length < count ||
            (!adjusted && value.start && oldest.slice(0, 10) <= value.start)
          ) {
            historyExhausted = true;
            stopped = true;
            break;
          }
          if (!adjusted && rows.size >= value.limit) {
            stopped = true;
            break;
          }
          offset += page.length;
        }
        if (!stopped)
          throw new InvalidData("tstdx 历史超过协议分页范围，拒绝不完整结果");
        let bars: Bar[] = [...rows.values()].sort((a, b) =>
          a.date.localeCompare(b.date),
        );
        if (!bars.length) throw Error("tstdx 未返回行情");
        if (adjusted) {
          const events = await request("xdxr", [symbol], () =>
            client.xdxr(symbol),
          );
          try {
            bars = adjustBars(bars, events, value.adjustment as "qfq" | "hfq");
          } catch (e) {
            throw new InvalidData(String(e));
          }
        }
        bars = bars.filter(
          (b) => !value.start || b.date.slice(0, 10) >= value.start,
        );
        if (bars.length > value.limit) historyExhausted = false;
        bars = bars.slice(-value.limit);
        if (!bars.length) throw Error("tstdx 请求区间未返回行情");
        return { bars, historyExhausted };
      });
      items.push({
        symbol,
        status: "ok",
        ...result,
        rows: result.bars.map((b) => ({ ...b, symbol })),
      });
    } catch (e) {
      signal?.throwIfAborted();
      items.push({
        symbol,
        status: e instanceof InvalidData ? "invalid" : "unavailable",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return {
    version: TSTDX_ADAPTER_VERSION,
    source: "tdx-7709" as const,
    adjustment: value.adjustment,
    period: value.period,
    limit: value.limit,
    start: value.start,
    end,
    currency: "CNY",
    volumeUnit: "源单位未独立核验",
    delayed: true,
    warnings: [
      "公网接口按调用判断可用性；量额单位未独立核验",
      ...(value.adjustment !== "none"
        ? ["复权锚点为查询截止日历史，未改变终端策略复权"]
        : []),
    ],
    requests,
    items,
  };
}
export function requireTstdxRows(
  result: Awaited<ReturnType<typeof tstdxKlines>>,
) {
  const failures = result.items.filter((i) => i.status !== "ok");
  if (failures.length)
    throw Error(failures.map((i) => `${i.symbol}: ${i.message}`).join("；"));
  return result.items.flatMap((i) => (i.status === "ok" ? i.rows : []));
}
const searchSchema = z
  .object({
    keyword: z.string().trim().min(1).max(100),
    type: z
      .enum(["stock", "etf", "index", "sector", "bond", "futures", "forex"])
      .default("stock"),
    limit: z.number().int().min(1).max(100).default(20),
    markets: z
      .array(z.enum(["sh", "sz", "bj"]))
      .min(1)
      .max(3)
      .default(["sh", "sz"]),
  })
  .strict();
export async function tstdxSearch(
  input: z.input<typeof searchSchema>,
  signal?: AbortSignal,
  make: Factory = factory,
) {
  const value = searchSchema.parse(input);
  if (["bond", "futures", "forex"].includes(value.type))
    throw Error(`tstdx adapter 尚不支持 ${value.type} 搜索`);
  return withClient(make, signal, async (client) => {
    const rows: { code: string; name: string; type: string }[] = [];
    if (value.type === "sector") {
      for (const file of ["block_gn.dat", "block_zs.dat", "block_fg.dat"]) {
        signal?.throwIfAborted();
        for (const block of await client.blockInfo(file)) {
          if (block.name.includes(value.keyword))
            rows.push({
              code: `${file}:${block.name}`,
              name: block.name,
              type: "sector-members-only",
            });
        }
      }
    } else {
      for (const market of [...new Set(value.markets)]) {
        signal?.throwIfAborted();
        for (const row of await client.stocks(market)) {
          if (
            tstdxAssetKind(row.symbol) === value.type &&
            (row.symbol.includes(value.keyword.toLowerCase()) ||
              row.name.includes(value.keyword))
          )
            rows.push({ code: row.symbol, name: row.name, type: value.type });
        }
      }
    }
    return rows.slice(0, value.limit);
  });
}
/** Price/volume points have no OHLC or independently verified wall-clock labels. */
export async function tstdxMinutes(
  input: { symbol: string; date?: string },
  signal?: AbortSignal,
  make: Factory = factory,
) {
  const value = z
    .object({
      symbol: z.string().regex(/^(sh|sz|bj)\d{6}$/),
      date: daySchema.optional(),
    })
    .strict()
    .parse(input);
  if (value.date && value.date > today()) throw Error("分时日期位于未来");
  const startedAt = Date.now();
  return withClient(make, signal, async (client) => {
    const method = value.date ? "historyMinutes" : "minutes";
    const raw = value.date
      ? await client.historyMinutes(
          value.symbol,
          Number(value.date.replaceAll("-", "")),
        )
      : await client.minutes(value.symbol);
    const points = z
      .array(
        z.object({ price: numeric.positive(), volume: numeric.nonnegative() }),
      )
      .min(1)
      .max(240)
      .parse(raw);
    return {
      version: TSTDX_ADAPTER_VERSION,
      source: "tdx-7709" as const,
      symbol: value.symbol,
      date: value.date ?? null,
      dateBasis: value.date
        ? "requested-historical-date"
        : "current-response-date-unverified",
      method,
      points,
      volumeUnit: isIndexSymbol(value.symbol)
        ? "指数源字段，不能作为股/手成交量"
        : "源单位未独立核验",
      volumeMeaning: isIndexSymbol(value.symbol)
        ? "index-source-value"
        : "source-volume",
      startedAt,
      completedAt: Date.now(),
    };
  });
}
