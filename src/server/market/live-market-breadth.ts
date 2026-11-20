import { z } from "zod";
import { emFetch } from "../data-sources/eastmoney/em-fetch";

/**
 * 全市场实时涨跌家数与沪深京成交额（东方财富实时快照）。
 *
 * 单次请求拉取上证指数（1.000001）、深证成指（0.399001）、北证50（0.899050）
 * 对应的分市场实时上涨/下跌/平盘家数（f104/f105/f106）与成交额（f6，元），
 * 经由 emFetch 节流与 WAF 冷却保护，避免触发限流。
 */
export const LIVE_MARKET_BREADTH_VERSION = "live-market-breadth-1";

const BREADTH_URL =
  "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f14,f2,f3,f6,f104,f105,f106&secids=1.000001,0.399001,0.899050";

const MARKET_META = [
  { code: "000001", key: "sh", label: "沪市" },
  { code: "399001", key: "sz", label: "深市" },
  { code: "899050", key: "bj", label: "北交所" },
] as const;

export type LiveMarketBreadthSegment = {
  key: "sh" | "sz" | "bj";
  label: string;
  up: number;
  down: number;
  flat: number;
  amount: number;
};

export type LiveMarketBreadth = {
  version: string;
  source: "东方财富实时";
  quoteDate: string;
  fetchedAt: number;
  up: number;
  down: number;
  flat: number;
  total: number;
  /** 沪深京总成交额（元）。 */
  amount: number;
  markets: LiveMarketBreadthSegment[];
};

const rowSchema = z.object({
  f12: z.string(),
  f6: z.number().finite().nonnegative(),
  f104: z.number().int().nonnegative(),
  f105: z.number().int().nonnegative(),
  f106: z.number().int().nonnegative(),
});

const payloadSchema = z.object({
  rc: z.number().optional(),
  data: z
    .object({
      diff: z.array(z.unknown()),
    })
    .nullable(),
});

function beijingDate(now: number) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

export function parseLiveMarketBreadth(
  raw: unknown,
  now = Date.now(),
): LiveMarketBreadth {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.data)
    throw new Error("东方财富实时市场宽度响应格式异常");

  const byCode = new Map<string, z.infer<typeof rowSchema>>();
  for (const item of parsed.data.data.diff) {
    const row = rowSchema.safeParse(item);
    if (!row.success) continue;
    byCode.set(row.data.f12, row.data);
  }

  const markets: LiveMarketBreadthSegment[] = [];
  for (const meta of MARKET_META) {
    const row = byCode.get(meta.code);
    if (!row)
      throw new Error(`东方财富实时市场宽度缺少${meta.label}（${meta.code}）`);
    if (
      !Number.isSafeInteger(row.f104) ||
      !Number.isSafeInteger(row.f105) ||
      !Number.isSafeInteger(row.f106)
    )
      throw new Error(`东方财富实时市场宽度${meta.label}家数超出安全整数`);
    markets.push({
      key: meta.key,
      label: meta.label,
      up: row.f104,
      down: row.f105,
      flat: row.f106,
      amount: row.f6,
    });
  }

  let up = 0;
  let down = 0;
  let flat = 0;
  let amount = 0;
  for (const segment of markets) {
    up += segment.up;
    down += segment.down;
    flat += segment.flat;
    amount += segment.amount;
  }

  return {
    version: LIVE_MARKET_BREADTH_VERSION,
    source: "东方财富实时",
    quoteDate: beijingDate(now),
    fetchedAt: now,
    up,
    down,
    flat,
    total: up + down + flat,
    amount,
    markets,
  };
}

export async function fetchLiveMarketBreadth(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<LiveMarketBreadth> {
  const response = await emFetch(BREADTH_URL, { signal }, fetcher);
  if (!response.ok)
    throw new Error(`东方财富实时市场宽度请求失败（HTTP ${response.status}）`);
  const json: unknown = await response.json();
  return parseLiveMarketBreadth(json, Date.now());
}
