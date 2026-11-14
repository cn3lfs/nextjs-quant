import { createHash } from "node:crypto";
import type { Bar } from "trading-strategy-core/bars";
import { readBars, type ReadBarsInput } from "../market/bar-store/read-bars";
import { readColumnCache } from "../market/bar-store/column-cache";
import { cryptoPeriodMs } from "~/lib/market/crypto-aggregation";

/** Research quarantines malformed time labels, never repairs them or weakens
 * the chart aggregator. Original rows remain in the isolated raw BarStore.
 * Binance's 2023-03-24 outage includes off-grid candle closing timestamps.
 */
export function quarantineCryptoTimes(bars: readonly Bar[], step: number) {
  const excluded: Bar[] = [],
    accepted: Bar[] = [];
  for (const bar of bars) {
    const time = Date.parse(bar.date);
    if (!Number.isFinite(time) || time % step !== 0) excluded.push(bar);
    else accepted.push(bar);
  }
  return { accepted, excluded };
}

function researchQuery(input: ReadBarsInput): ReadBarsInput {
  if (
    input.instrument.market === "crypto" &&
    input.period === "15m" &&
    input.cryptoSource === "binance"
  )
    return { ...input, cryptoNative15m: true };
  return input;
}

/** Project an already verified cache generation without another network read.
 * A failed older page must not discard valid history already observed.
 */
export async function readCachedResearchCryptoWindow(value: ReadBarsInput) {
  const input = researchQuery(value);
  if (input.instrument.market !== "crypto" || input.cryptoSource !== "binance")
    throw new Error(
      "Cached research projection requires explicit Binance crypto",
    );
  const base = input.cryptoNative15m
    ? "15m"
    : ["15m", "30m", "5m"].includes(input.period)
      ? "5m"
      : ["4h", "1h", "60m"].includes(input.period)
        ? "1h"
        : "day";
  const cached = readColumnCache(
    `crypto:${input.instrument.symbol}:${base}:binance`,
  );
  if (!cached) return null;
  const source = cached.metadata.source;
  if (
    source.source !== "binance-spot" ||
    source.symbol !== input.instrument.symbol ||
    source.period !== base ||
    !Array.isArray(source.sourceVersions) ||
    !source.sourceVersions.every((v) => typeof v === "string")
  )
    throw new Error("Cached research source identity mismatch");
  const { accepted, excluded } =
    base === "day"
      ? { accepted: cached.bars, excluded: [] as Bar[] }
      : quarantineCryptoTimes(cached.bars, cryptoPeriodMs[base]!);
  const hash = excluded.length
    ? createHash("sha256")
        .update(
          JSON.stringify({
            source: cached.metadata.fingerprint,
            quarantine: excluded,
            rule: "exclude-off-grid-source-times-1",
          }),
        )
        .digest("hex")
    : cached.metadata.fingerprint;
  const snapshot = await readBars(input, {
    ...source,
    id: `snapshot-research-${hash}`,
    symbol: input.instrument.symbol,
    name:
      typeof source.name === "string" ? source.name : input.instrument.symbol,
    period: base,
    adjustment: "none",
    source: "binance-spot",
    sourceUrl:
      typeof source.sourceUrl === "string" ? source.sourceUrl : undefined,
    sourceVersions: excluded.length
      ? [cached.metadata.fingerprint, "exclude-off-grid-source-times-1"]
      : source.sourceVersions,
    hash,
    createdAt: Date.now(),
    bars: accepted,
    ...(excluded.length
      ? {
          sourceNote:
            "Research-only quarantine of off-grid source times; raw rows retained, no timestamp repair or synthetic candles",
        }
      : {}),
  });
  snapshot.barStore.excluded.push(
    ...excluded.map((bar) => ({
      date: bar.date,
      reason:
        "币安原始收线时间不在周期网格，隔离原记录；不改写时间、不补造缺失bar",
    })),
  );
  return { snapshot, quarantined: excluded };
}

export async function readResearchCryptoWindow(value: ReadBarsInput) {
  const input = researchQuery(value);
  try {
    return { snapshot: await readBars(input), quarantined: [] as Bar[] };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "数字货币聚合源行情无效" ||
      input.instrument.market !== "crypto" ||
      input.cryptoSource !== "binance"
    )
      throw error;
    const projected = await readCachedResearchCryptoWindow(input);
    if (!projected?.quarantined.length) throw error;
    return projected;
  }
}
