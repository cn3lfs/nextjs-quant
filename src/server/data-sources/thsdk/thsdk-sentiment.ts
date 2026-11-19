import { z } from "zod";
import { isAShareStockSymbol } from "~/lib/market/security-classification";
import type {
  ThsdkCallAuctionUnusualResult,
  ThsdkLimitUpAttribution,
  ThsdkMarketChangeEventsResult,
  ThsdkRealtimeSignalResult,
} from "~/lib/market/thsdk-sentiment";
import {
  readThsdk,
  thsdkFailure,
  THSDK_ADAPTER_VERSION,
  type ThsdkInvoker,
} from "./thsdk-adapter";
import {
  fromThsdkSecurity,
  ThsdkError,
  toThsdkSecurity,
} from "./thsdk-contract";

const security = z.object({ code: z.string(), market: z.string() });
const optionalText = z.string().trim().min(1).nullish().catch(null);
const attribution = z.object({
  security,
  date: optionalText,
  status_code: optionalText,
  status_message: optionalText,
  text: optionalText,
});
const realtimeRows = z
  .array(
    z.object({
      security,
      fields: z
        .array(z.object({ name: z.string(), value: z.unknown() }))
        .nullish(),
    }),
  )
  .nullable();
const marketEvents = z
  .array(
    z.object({
      title: optionalText,
      main_title: optionalText,
      type: optionalText,
      third_party_id: optionalText,
      published_at: optionalText,
      securities: z.array(security).nullish(),
      unresolved_codes: z.array(z.string()).nullish(),
      source_security_list: optionalText,
    }),
  )
  .nullable();
const auctionEvents = z
  .array(
    z.object({
      security,
      name: optionalText,
      event_type: z.number().int().nonnegative().nullish().catch(null),
      event_name: optionalText,
      description: optionalText,
      time: optionalText,
      gains: z.number().finite().nullish().catch(null),
    }),
  )
  .nullable();

const source = "thsdk-hq";
const version = THSDK_ADAPTER_VERSION;

function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  raw: unknown,
): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw thsdkFailure("invalid_response");
  return result.data;
}

function numberField(value: unknown): number | null {
  const numeric =
    typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric)
    ? numeric
    : null;
}

function inferSymbol(code: string): string | null {
  for (const market of ["sh", "sz", "bj"]) {
    const symbol = `${market}${code}`;
    if (isAShareStockSymbol(symbol)) return symbol;
  }
  return null;
}

export async function thsdkLimitUpAnalysis(
  symbol: string,
  date?: string,
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
): Promise<ThsdkLimitUpAttribution> {
  const requestedDate =
    date ?? new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const requestedSecurity = toThsdkSecurity(symbol);
  const raw = await readThsdk(
    "analyze_security_limit_up",
    {
      security: requestedSecurity,
      ...(date ? { date: `${date}T00:00:00+08:00` } : {}),
    },
    signal,
    invoke,
  );
  const result = parse(attribution, raw);
  if (
    result.security.code !== requestedSecurity.code ||
    result.security.market !== requestedSecurity.market
  )
    throw thsdkFailure("invalid_response");

  const reportedDate = result.date?.replace(
    /^(\d{4})(\d{2})(\d{2})$/,
    "$1-$2-$3",
  );
  if (
    reportedDate &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(reportedDate) ||
      (date && reportedDate !== date))
  )
    throw thsdkFailure("invalid_response");
  const reason = result.status_code === "0" ? (result.text ?? null) : null;
  return {
    version,
    source,
    symbol,
    date: reportedDate ?? requestedDate,
    fetchedAt: Date.now(),
    available: reason !== null,
    statusMessage: result.status_message ?? null,
    reason,
    reasons: reason === null ? [] : [reason],
    concepts: [],
    firstLimitUpTime: null,
    lastLimitUpTime: null,
    openCount: null,
    streakDays: null,
    highDays: null,
    limitUpType: null,
  };
}

export async function thsdkRealtimeSignal(
  kind: ThsdkRealtimeSignalResult["signal"],
  markets: ThsdkRealtimeSignalResult["markets"],
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
): Promise<ThsdkRealtimeSignalResult> {
  const rows = await readThsdk(
    "list_securities_by_realtime_signal",
    { markets, signal: kind },
    signal,
    invoke,
  ).catch((error: unknown) => {
    if (error instanceof ThsdkError && error.code === "no_data") return null;
    throw error;
  });
  const items = (parse(realtimeRows, rows) ?? []).map((row) => {
    const fields = new Map(row.fields?.map(({ name, value }) => [name, value]));
    return {
      symbol: fromThsdkSecurity(row.security),
      ...row.security,
      name: optionalText.parse(fields.get("名称")) ?? null,
      price: numberField(fields.get("最新价")),
      changePct: numberField(fields.get("涨幅")),
      signalTime:
        kind === "limit_up"
          ? (optionalText.parse(fields.get("首次涨停时间")) ?? null)
          : null,
      reason: optionalText.parse(fields.get("涨停原因")) ?? null,
    };
  });
  return {
    version,
    source,
    signal: kind,
    markets,
    fetchedAt: Date.now(),
    available: items.length > 0,
    emptyReason: items.length ? null : "当前非交易时段或暂无该实时信号样本",
    items,
  };
}

export async function thsdkMarketChangeEvents(
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
): Promise<ThsdkMarketChangeEventsResult> {
  const raw = await readThsdk(
    "list_market_change_events",
    null,
    signal,
    invoke,
  );
  const items = (parse(marketEvents, raw) ?? []).map((row) => {
    const related = new Map<
      string,
      { symbol: string | null; code: string; name: string }
    >();
    for (const entry of [
      ...(row.unresolved_codes ?? []),
      ...(row.source_security_list?.split(",") ?? []),
    ]) {
      const [rawCode, ...parts] = entry.split(":");
      const code = rawCode?.trim();
      if (code && !related.has(code))
        related.set(code, {
          symbol: inferSymbol(code),
          code,
          name: parts.join(":").trim(),
        });
    }
    for (const sec of row.securities ?? []) {
      const parsed = related.get(sec.code);
      related.set(sec.code, {
        symbol: fromThsdkSecurity(sec),
        code: sec.code,
        name: parsed?.name ?? "",
      });
    }
    const title = row.title ?? row.main_title ?? "";
    const mainTitle = row.main_title ?? title;
    return {
      id:
        row.third_party_id ??
        JSON.stringify([row.published_at ?? null, title, mainTitle]),
      title,
      mainTitle,
      eventType: row.type ?? null,
      publishedAt: row.published_at ?? null,
      relatedSecurities: [...related.values()],
    };
  });
  return { version, source, fetchedAt: Date.now(), items };
}

export async function thsdkCallAuctionUnusual(
  market: ThsdkCallAuctionUnusualResult["market"],
  tradeDate?: string,
  signal?: AbortSignal,
  invoke?: ThsdkInvoker,
): Promise<ThsdkCallAuctionUnusualResult> {
  const raw = await readThsdk(
    "list_market_call_auction_unusual_events",
    {
      market,
      ...(tradeDate ? { trade_date: tradeDate.replaceAll("-", "") } : {}),
    },
    signal,
    invoke,
  ).catch((error: unknown) => {
    if (error instanceof ThsdkError && error.code === "no_data") return null;
    throw error;
  });
  const items = (parse(auctionEvents, raw) ?? []).map((row) => ({
    symbol: fromThsdkSecurity(row.security),
    code: row.security.code,
    name: row.name ?? null,
    eventType: row.event_type != null ? String(row.event_type) : null,
    title: row.event_name ?? row.description ?? "",
    detail: row.description ?? null,
    eventTime: row.time ?? null,
    changePct: row.gains ?? null,
  }));
  return {
    version,
    source,
    market,
    tradeDate: tradeDate ?? null,
    fetchedAt: Date.now(),
    available: items.length > 0,
    emptyReason: items.length ? null : "暂无集合竞价异动样本",
    items,
  };
}
