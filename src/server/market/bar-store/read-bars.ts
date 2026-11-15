import { join } from "node:path";
import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  adjustmentFactors,
  applyAdjustmentByDate,
  resolveTdxRoot,
} from "tstdx/local";
import type { Snapshot, Bar } from "~/lib/domain";
import { instrumentSchema } from "~/lib/market/instrument";
import { basePeriod, periodSchema, marketPeriods } from "~/lib/market/periods";
import { aggregateChartBars } from "~/lib/market/bar-aggregation";
import {
  aggregateCryptoBars,
  cryptoPeriodMs,
} from "~/lib/market/crypto-aggregation";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import type { BarMetadata } from "~/lib/market/bar-metadata";
import { cryptoDisplayName, cryptoSourceSchema } from "~/lib/market/crypto";
import { beijingClock, marketSession } from "~/lib/market/market-session";
import { localBars } from "./local-source";
import { corporateActions } from "./corporate-actions";
import { readColumnCache, writeColumnCache } from "./column-cache";
import { cryptoKlines } from "./crypto-source";
import { binanceArchiveSource } from "./binance-archive-source";
import { refreshPublicDataLive } from "../../data-sources/binance/public-data-store";
import {
  BinanceNoKlinesError,
  BINANCE_KLINES_VERSION,
} from "../../data-sources/binance/binance-klines";
import { settings } from "../../infra/settings";
import { freeChartHistory } from "../free-chart-sources";
import { mergeOnlineDailyTail } from "../chart-online-delta";
import { marketSourceSchema } from "~/lib/market/market-source";

export const readBarsInput = z
  .object({
    instrument: instrumentSchema,
    period: z.union([periodSchema, z.literal("month")]),
    adjustment: z.enum(["none", "forward", "backward"]),
    from: z
      .string()
      .refine((v) => Number.isFinite(Date.parse(v)))
      .optional(),
    to: z
      .string()
      .refine((v) => Number.isFinite(Date.parse(v)))
      .optional(),
    limit: z.number().int().min(1).max(2000000).optional(),
    live: z.boolean().default(false),
    root: z.string().optional(),
    chartFunds: z.boolean().default(false),
    freezeRaw: z.boolean().default(false),
    source: marketSourceSchema.optional(),
    cryptoSource: cryptoSourceSchema.default("auto"),
    /** Research can fetch Binance's own 15m candles instead of 3x as many 5m rows. */
    cryptoNative15m: z.boolean().default(false),
    now: z.number().finite().optional(),
    calendar: z
      .object({
        days: z.array(z.string()),
        closedDays: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .strict()
  .refine(
    (v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to),
    "行情区间非法",
  )
  .refine(
    (v) =>
      !v.cryptoNative15m ||
      (v.instrument.market === "crypto" &&
        v.period === "15m" &&
        v.cryptoSource === "binance"),
    "Native 15m research requires Binance crypto 15m",
  );
export type ReadBarsInput = z.input<typeof readBarsInput>;
export type BarSeries = Omit<Snapshot, "period"> & {
  period: ChartPeriod;
  market: z.infer<typeof instrumentSchema>["market"];
  barStore: BarMetadata;
};
type SourceSeries = Snapshot & {
  historyExhausted?: boolean;
  formingDates?: string[];
};
const withinEnd = (date: string, end?: string) =>
  !end ||
  (end.length === 10
    ? date.slice(0, 10) <= end
    : Date.parse(date) <= Date.parse(end));
const withinStart = (date: string, start?: string) =>
  !start ||
  (start.length === 10
    ? date.slice(0, 10) >= start
    : Date.parse(date) >= Date.parse(start));
const hashOf = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function completedDailySource(bars: Bar[], now: number, adjusted: boolean) {
  const today = beijingClock(now).date;
  const beforeClose = now < Date.parse(`${today}T15:00:00+08:00`);
  if (!adjusted && (!bars.length || bars.at(-1)!.date < today))
    return { bars, formingDates: [], excluded: [] };
  const formingDates: string[] = [];
  for (const bar of bars) {
    // The codec verified raw OHLC; adjustment can still overflow/underflow.
    if (
      adjusted &&
      (!Number.isFinite(bar.open) ||
        !Number.isFinite(bar.high) ||
        !Number.isFinite(bar.low) ||
        !Number.isFinite(bar.close) ||
        bar.low <= 0)
    )
      throw new Error("合成源行情日期、价格或成交量无效");
    if (bar.date > today || (bar.date === today && beforeClose))
      formingDates.push(bar.date);
  }
  return {
    bars,
    formingDates,
    excluded: [],
  };
}

async function cryptoBars(
  input: z.infer<typeof readBarsInput>,
  base: "day" | "5m" | "15m" | "1h",
  now: number,
): Promise<SourceSeries> {
  const { symbol } = input.instrument;
  const key = `crypto:${symbol}:${base}:${input.cryptoSource}`;
  let cached: ReturnType<typeof readColumnCache> = null;
  try {
    cached = readColumnCache(key);
  } catch {
    // Public source data can rebuild a damaged or obsolete derived cache.
  }
  const step = cryptoPeriodMs[base]!;
  const multiplier =
    input.period === "4h"
      ? 4
      : input.period === "week"
        ? 7
        : input.period === "month"
          ? 31
          : input.period === "15m" && base !== "15m"
            ? 3
            : input.period === "30m"
              ? 6
              : 1;
  const end = input.to
    ? Date.parse(input.to) + (input.to.length === 10 ? 86400000 : 1)
    : undefined;
  const requested = input.from
    ? Math.ceil(((end ?? now) - Date.parse(input.from)) / step) + multiplier
    : (input.limit ?? 2000) * multiplier;
  const needed = Math.min(5000, Math.max(1, requested));
  const historical = end !== undefined && end < now;
  const covered =
    cached?.bars.filter(
      (b) => withinEnd(b.date, input.to) && withinStart(b.date, input.from),
    ).length ?? 0;
  const fetched = Number(
    cached?.metadata.source[historical ? "historicalFetchedAt" : "fetchedAt"] ??
      0,
  );
  const expires = input.live ? 10000 : Math.min(step, 60000);
  if (
    cached &&
    now >= fetched &&
    now - fetched < expires &&
    (covered >= needed || cached.metadata.source.historyExhausted === true)
  )
    return { ...cached.metadata.source, bars: cached.bars } as SourceSeries;
  // Refresh only the elapsed tail (including the previous forming candle).
  // If the requested window grew, fetch that window instead of asserting coverage.
  const elapsed = Math.max(2, Math.ceil((now - fetched) / step) + 2);
  const count =
    !historical && cached && cached.bars.length >= needed && elapsed < needed
      ? elapsed
      : needed;
  let result: Awaited<ReturnType<typeof cryptoKlines>>;
  try {
    result = await cryptoKlines(
      symbol,
      base,
      Math.min(5000, count),
      input.cryptoSource,
      end,
    );
  } catch (error) {
    const first = cached?.bars[0];
    const firstOpening = first
      ? Date.parse(first.date) - (base === "day" ? 0 : step)
      : null;
    if (
      !(error instanceof BinanceNoKlinesError) ||
      input.cryptoSource !== "binance" ||
      !cached ||
      firstOpening === null ||
      end === undefined ||
      end > firstOpening ||
      cached.metadata.source.source !== "binance-spot" ||
      !Array.isArray(cached.metadata.source.sourceVersions) ||
      !cached.metadata.source.sourceVersions.includes(BINANCE_KLINES_VERSION)
    )
      throw error;
    // Empty before an already observed series proves a lower boundary. Keep
    // the cached prices intact; empty inside coverage or unknown pairs fail.
    const metadata: typeof cached.metadata.source = {
      ...cached.metadata.source,
      historyExhausted: true,
      historicalFetchedAt: now,
    };
    writeColumnCache(key, cached.bars, cached.metadata.fingerprint, metadata);
    return { ...metadata, bars: cached.bars } as SourceSeries;
  }
  const sameVenue =
    cached?.metadata.source.source === result.source &&
    (cached.metadata.source.sourceVersions as string[] | undefined)?.includes(
      result.version,
    );
  const merged = new Map<string, Bar>(
    sameVenue && cached ? cached.bars.map((b) => [b.date, b]) : [],
  );
  for (const bar of result.bars) merged.set(bar.date, bar);
  const bars = [...merged.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const hash = hashOf({ source: result.source, version: result.version, bars });
  const snapshot: SourceSeries = {
    historyExhausted: result.historyExhausted,
    formingDates: result.formingDates,
    id: `snapshot-crypto-${hash}`,
    symbol,
    market: "crypto",
    name: cryptoDisplayName(symbol),
    period: base,
    adjustment: "none",
    source: result.source,
    sourceUrl: result.sourceUrl,
    bars,
    hash,
    createdAt: now,
    sourceNote: result.sourceNote,
    sourceErrors: result.sourceErrors,
    sourceVersions: [result.version],
    cryptoSource: input.cryptoSource,
  };
  const { bars: _bars, ...metadata } = snapshot;
  writeColumnCache(key, bars, hash, {
    ...metadata,
    fetchedAt: historical
      ? Number(cached?.metadata.source.fetchedAt ?? 0)
      : now,
    historicalFetchedAt: historical
      ? now
      : cached?.metadata.source.historicalFetchedAt,
    formingDates: result.formingDates,
    historyExhausted: result.historyExhausted,
  });
  return snapshot;
}

/** One price-series entry. Raw cache is never overwritten by adjusted or live
 * prices. Bounds precede adjustment reference selection, so a historical cutoff
 * cannot inherit a future corporate-action denominator. */
export async function readBars<const T extends ReadBarsInput>(
  value: T,
  frozen?: Omit<Snapshot, "period"> & { period: ChartPeriod },
): Promise<BarSeries & { period: T["period"] }> {
  const input = readBarsInput.parse(value),
    now = input.now ?? Date.now();
  const { market, symbol } = input.instrument;
  if (input.period !== "month" && !marketPeriods[market].includes(input.period))
    throw new Error("该市场不支持所选周期");
  if (market === "futures")
    throw new Error("期货沿用现有合约来源，尚未接入 BarStore");
  if (market !== "cn-equity" && input.adjustment !== "none")
    throw new Error("数字货币不支持复权");
  const base = input.cryptoNative15m ? "15m" : basePeriod(market, input.period);
  const root = input.root ?? (market === "cn-equity" ? settings().tdxRoot : "");
  let raw: SourceSeries;
  if (frozen) {
    if (
      frozen.symbol !== symbol ||
      (frozen.period !== input.period && frozen.period !== base) ||
      frozen.adjustment !== "none"
    )
      throw new Error("冻结行情身份、周期或价格口径不匹配");
    raw = { ...frozen, period: base };
  } else if (market === "crypto") {
    if (
      input.live &&
      !input.to &&
      ["auto", "binance"].includes(input.cryptoSource) &&
      ["cxBTCUSDT", "cxETHUSDT"].includes(symbol) &&
      ["day", "4h", "1h", "60m", "15m", "5m"].includes(input.period)
    )
      await refreshPublicDataLive(
        symbol.slice(2),
        (input.period === "day"
          ? "1d"
          : input.period === "60m"
            ? "1h"
            : input.period) as "1d" | "4h" | "1h" | "15m" | "5m",
        { root: settings().binancePublicDataRoot || undefined, now },
      );
    const archive = ["auto", "binance"].includes(input.cryptoSource)
      ? await binanceArchiveSource({
          symbol,
          period: input.period,
          configuredRoot: settings().binancePublicDataRoot,
          from: input.from,
          to: input.to,
          limit: input.limit,
          now,
        })
      : null;
    raw = archive ?? (await cryptoBars(input, base, now));
  } else {
    const local = () =>
      localBars(root, symbol, base === "day" ? "day" : "5m", input.chartFunds);
    if (input.source && input.source !== "local") {
      try {
        if (input.source !== "auto") throw new Error("selected remote source");
        raw = await local();
      } catch {
        const remote = await freeChartHistory(
          symbol,
          base,
          Math.min(input.limit ?? 2000, 20000),
          input.source,
        );
        const hash = hashOf(remote.bars);
        raw = {
          ...remote,
          symbol,
          period: base,
          adjustment: "none",
          hash,
          id: `snapshot-${symbol}-${hash}`,
          createdAt: now,
          dataRoot: root,
        };
      }
    } else raw = await local();
  }
  const priceRepaired =
    raw.barStore?.priceRepaired ??
    (raw.source === "tdx-local" && Boolean(raw.sourceNote));
  let overlay: BarMetadata["overlay"] = null;
  if (input.live && market === "cn-equity" && base === "day" && !input.to) {
    const clock = beijingClock(now),
      session = marketSession(now);
    if (["morning", "lunch", "afternoon"].includes(session.kind)) {
      const remote = await freeChartHistory(symbol, "day", 20);
      if (remote.source === "tencent/westock-data")
        throw new Error("腾讯成交量单位未核验，不能拼接本地尾段");
      const merged = mergeOnlineDailyTail(raw, remote.bars, {
        source: remote.source,
        requests: 1,
      });
      raw = merged.snapshot;
      if (raw.bars.at(-1)?.date === clock.date)
        overlay = { source: remote.source, date: clock.date, completed: false };
    }
  }
  let bars = input.to
    ? raw.bars.filter((b) => withinEnd(b.date, input.to))
    : raw.bars;
  let adjustmentReference: string | null = null;
  const sourceVersions = [...(raw.sourceVersions ?? [raw.hash])];
  if (input.adjustment !== "none") {
    const daily =
      base === "day"
        ? { ...raw, bars }
        : await localBars(root, symbol, "day", input.chartFunds);
    const reference = input.to
      ? daily.bars.filter(
          (b) => !input.to || b.date.slice(0, 10) <= input.to.slice(0, 10),
        )
      : daily.bars;
    const gbbq = await corporateActions(root);
    const actionFingerprint = gbbq.fingerprint;
    const factors = adjustmentFactors(reference, gbbq.events.get(symbol) ?? []);
    bars = applyAdjustmentByDate(bars, factors, input.adjustment);
    adjustmentReference = `${actionFingerprint}:${reference.at(-1)?.date ?? "empty"}:${factors.at(-1)?.factor ?? 1}`;
    sourceVersions.push(actionFingerprint);
  }
  const aggregated =
    (!frozen &&
      raw.source === "binance-public-data" &&
      (raw.period === input.period ||
        (raw.period === "1h" && input.period === "60m"))) ||
    (frozen && frozen.period === input.period && input.period !== base)
      ? { bars, formingDates: [], excluded: [] }
      : !frozen &&
          market === "cn-equity" &&
          base === "day" &&
          input.period === "day" &&
          (raw.source === "tdx-local" || raw.source === "tdx-full-package")
        ? // Source codec and column decoder validate base bars on the IO boundary.
          completedDailySource(bars, now, input.adjustment !== "none")
        : market === "crypto"
          ? aggregateCryptoBars(bars, base, input.period, now, raw.formingDates)
          : aggregateChartBars(
              bars,
              base === "day" ? "day" : "5m",
              input.period,
              now,
              input.calendar,
            );
  bars = input.from
    ? aggregated.bars.filter((b) => withinStart(b.date, input.from))
    : aggregated.bars;
  const total = bars.length;
  if (input.limit) bars = bars.slice(-input.limit);
  const selected = new Set(
    aggregated.formingDates.length ? bars.map((b) => b.date) : [],
  );
  let supported: ChartPeriod[] =
    market === "crypto"
      ? [...marketPeriods.crypto, "month"]
      : [...marketPeriods["cn-equity"], "month"];
  if (market === "cn-equity" && (!input.source || input.source === "local")) {
    try {
      const available = statSync(
        join(
          resolveTdxRoot(root),
          "vipdoc",
          symbol.slice(0, 2),
          "fzline",
          `${symbol}.lc5`,
        ),
        { throwIfNoEntry: false },
      );
      if (!available) supported = ["day", "week", "month"];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || !root.trim())
        supported = ["day", "week", "month"];
      else throw error;
    }
  }
  const metadata: BarMetadata = {
    availablePeriods: supported,
    priceRepaired,
    version: "bar-store-1",
    market,
    sourceFingerprint: raw.hash,
    sourceVersions,
    adjustment: input.adjustment,
    adjustmentReference,
    coverage: {
      from: bars[0]?.date ?? null,
      to: bars.at(-1)?.date ?? null,
      count: bars.length,
      historyExhausted:
        raw.historyExhausted !== false && bars.length === total && !input.from,
    },
    formingDates: aggregated.formingDates.filter((d) => selected.has(d)),
    excluded: aggregated.excluded,
    overlay,
  };
  const hash =
    input.adjustment === "none" &&
    input.period === base &&
    !input.limit &&
    !input.from &&
    !input.to &&
    !overlay
      ? raw.hash
      : // The raw content identity, action source/reference, derived exclusions
        // and selected coverage determine every value. Do not serialize a full
        // adjusted history a second time just to identify that deterministic view.
        hashOf({ base: raw.hash, period: input.period, metadata });
  return {
    ...raw,
    id:
      hash === raw.hash
        ? raw.id
        : `snapshot-${symbol}-${input.period}-${hash.slice(0, 20)}`,
    market,
    createdAt: now,
    ...(input.to ? { historicalAsOf: input.to.slice(0, 10) } : {}),
    period: input.period,
    adjustment: input.adjustment,
    bars,
    ...(input.freezeRaw && input.adjustment !== "none"
      ? { rawBars: raw.bars.filter((b) => withinEnd(b.date, input.to)) }
      : {}),
    hash,
    barStore: metadata,
  } as BarSeries & { period: T["period"] };
}
