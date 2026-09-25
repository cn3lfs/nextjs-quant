import type { Bar } from "~/lib/domain";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import {
  cryptoBarDate,
  venueSymbol,
  type CryptoVenue,
} from "~/lib/market/crypto";
import {
  outboundFetch,
  routeLabel,
  type OutboundOptions,
  type OutboundRoute,
} from "../../infra/outbound";

/** One parsed candle before bar labelling; any page order is accepted. */
export type VenueRow = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Quote volume; null when the venue does not publish it. */
  amount: number | null;
  /** Venue-reported completion, when available. */
  closed?: boolean;
};

/**
 * Differences between public spot kline APIs. Paging always walks backwards:
 * `before` is the open time (ms) of the oldest candle already read, and a
 * page must only contain candles strictly older than it.
 */
export type VenueSpec = {
  id: Exclude<CryptoVenue, "binance">;
  name: string;
  version: string;
  host: string;
  pageSize: number;
  interval: (period: ChartPeriod) => string | null;
  url: (
    pair: string,
    interval: string,
    size: number,
    period: ChartPeriod,
    before?: number,
  ) => URL;
  parse: (raw: unknown) => VenueRow[];
  /** Venues that return short pages mid-history (time-window APIs) end
   *  paging only on an empty page. */
  shortPages?: boolean;
  /** Error text meaning "no older history", which ends paging normally. */
  exhausted?: (message: string) => boolean;
  note?: string;
};

const minute = 60_000;
const periodMs: Partial<Record<ChartPeriod, number>> = {
  "5m": 5 * minute,
  "15m": 15 * minute,
  "30m": 30 * minute,
  "60m": 60 * minute,
  day: 1440 * minute,
  week: 7 * 1440 * minute,
};
/** Exclusive end of a candle; months follow the UTC calendar. */
export function candleEnd(openTime: number, period: ChartPeriod) {
  if (period !== "month") return openTime + periodMs[period]!;
  const d = new Date(openTime);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
export const periodSeconds = (period: ChartPeriod) =>
  (periodMs[period] ?? 0) / 1000;

class VenueError extends Error {}
async function readJson(response: Response, name: string) {
  const text = await response.text();
  if (!response.ok)
    throw new VenueError(
      `${name} HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ""}`,
    );
  if (text.length > 8 * 1024 * 1024)
    throw new VenueError(`${name}响应超过读取上限`);
  return JSON.parse(text) as unknown;
}

/** Rejects malformed candles instead of repairing them. */
function checked(row: VenueRow, name: string) {
  const { open, high, low, close, volume, amount } = row;
  if (
    !Number.isFinite(row.openTime) ||
    ![open, high, low, close].every((x) => Number.isFinite(x) && x > 0) ||
    !(Number.isFinite(volume) && volume >= 0) ||
    (amount !== null && !(Number.isFinite(amount) && amount >= 0)) ||
    high < Math.max(open, close) ||
    low > Math.min(open, close)
  )
    throw new VenueError(`${name} K 线价格或时间无效`);
  return row;
}

export async function venueKlines(
  spec: VenueSpec,
  input: { symbol: string; period: ChartPeriod; limit: number },
  options: OutboundOptions & { now?: () => number } = {},
) {
  const { symbol, period, limit } = input;
  const pair = venueSymbol(spec.id, symbol);
  if (!pair) throw new Error(`${spec.name}无法识别该交易对`);
  const interval = spec.interval(period);
  if (!interval) throw new Error(`${spec.name}不提供该周期 K 线，请换数据源`);
  const byOpen = new Map<number, VenueRow>();
  const routes = new Set<OutboundRoute>();
  let before: number | undefined;
  let exhausted = false;
  while (byOpen.size < limit) {
    const size = Math.min(spec.pageSize, limit - byOpen.size);
    let page: VenueRow[];
    try {
      const { response, route } = await outboundFetch(
        spec.url(pair, interval, size, period, before).toString(),
        {},
        options,
      );
      routes.add(route);
      page = spec
        .parse(await readJson(response, spec.name))
        .map((row) => checked(row, spec.name))
        .filter((row) => before === undefined || row.openTime < before);
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取失败";
      if (byOpen.size && spec.exhausted?.(message)) {
        exhausted = true;
        break;
      }
      throw error;
    }
    for (const row of page) byOpen.set(row.openTime, row);
    if (spec.shortPages ? !page.length : page.length < size) {
      exhausted = true;
      break;
    }
    before = Math.min(...page.map((row) => row.openTime));
  }
  const rows = [...byOpen.values()]
    .sort((a, b) => a.openTime - b.openTime)
    .slice(-limit);
  if (!rows.length) throw new Error(`${spec.name}没有该交易对的 K 线`);
  const current = (options.now ?? Date.now)();
  const bars = rows.map((row) => {
    const end = candleEnd(row.openTime, period);
    return {
      row,
      end,
      bar: {
        date: cryptoBarDate(row.openTime, end - 1, period),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        amount: row.amount ?? 0,
      } satisfies Bar,
    };
  });
  return {
    version: spec.version,
    source: `${spec.id}-spot`,
    sourceUrl: `${spec.host}（${pair}）`,
    bars: bars.map((b) => b.bar),
    formingDates: bars
      .filter((b) => b.row.closed === false || b.end > current)
      .map((b) => b.bar.date),
    historyExhausted: exhausted,
    sourceNote: [
      `${spec.version}；${spec.name}现货公开 K 线 ${pair}（UTC 收线，7×24 交易）`,
      ...(spec.note ? [spec.note] : []),
      `${new URL(spec.host).host} ${[...routes].map(routeLabel).join("/")}`,
    ].join("；"),
  };
}
