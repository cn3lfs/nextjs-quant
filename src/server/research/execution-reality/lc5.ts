import { createHash } from "node:crypto";
import {
  isAStock,
  isLocalFund,
  parseBars,
  type TdxLocalBar,
} from "tstdx/local";

export const executionWindows = {
  open: [],
  "09:35-09:40": ["09:40"],
  "09:45-09:50": ["09:50"],
  "10:00-10:05": ["10:05"],
  "09:35-10:05": ["09:40", "09:45", "09:50", "09:55", "10:00", "10:05"],
} as const;
export type ExecutionRealityWindow = keyof typeof executionWindows;
export type ExecutionRealitySliceEnd =
  (typeof executionWindows)["09:35-10:05"][number];

export type ExecutionRealityVolumeEvidence = {
  /** The externally audited byte stream. LC5 itself has no estimated-volume marker. */
  sourceHash: string;
  auditHash: string;
  byEnd: Readonly<
    Record<
      string,
      {
        quality: "actual" | "estimated" | "unknown";
        volumeUnit: "shares" | "fund-units" | "unknown";
        amountUnit: "CNY" | "unknown";
      }
    >
  >;
};

type MinuteFailure =
  | "missing-minute-source"
  | "missing-interval"
  | "duplicate-interval"
  | "invalid-interval"
  | "unverified-volume"
  | "estimated-volume"
  | "invalid-units"
  | "amount-volume-outside-ohlc";
type MinuteRow = Readonly<TdxLocalBar>;
type MinuteQuote =
  | { status: "unavailable"; reason: MinuteFailure; intervalEnd: string }
  | {
      status: "available";
      referencePrice: number;
      amount: number;
      quantity: number;
      low: number;
      high: number;
      volumeUnit: "shares" | "fund-units";
      intervalEnds: readonly string[];
    };
export type ExecutionRealityLc5 = Readonly<{
  symbol: string;
  sourceHash: string;
  referenceYear: number;
  volumeAuditHash: string | null;
  prefixRange: (
    date: string,
    end: ExecutionRealitySliceEnd,
  ) => {
    low: number;
    high: number;
  } | null;
  interval: (date: string, end: ExecutionRealitySliceEnd) => MinuteQuote;
  window: (
    date: string,
    window: Exclude<ExecutionRealityWindow, "open">,
  ) => MinuteQuote;
}>;

const supportedEnds = new Set<string>(executionWindows["09:35-10:05"]);
const morningEnds = ["09:35", ...supportedEnds];
const endMinutes = new Set(
  morningEnds.map((end) => +end.slice(0, 2) * 60 + +end.slice(3)),
);
const pad2 = (value: number) => String(value).padStart(2, "0");
const endLabel = (date: string, end: string) => `${date}T${end}:00+08:00`;
const knownHash = (value: string) => /^[a-f0-9]{64}$/.test(value);

/** The general parser drops duplicate/disordered rows and can repair OHLC.
 * Inspect affected labels when that happens so a surviving bar cannot mask an
 * ambiguous interval. Normalized prices and amounts still come from parseBars. */
function checkSourceAnomalies(bytes: Buffer, referenceYear: number) {
  const seen = new Map<
    string,
    "valid" | "invalid-interval" | "duplicate-interval"
  >();
  // Use the same reverse year unwrapping as LC5 parsing, including pre-2004 dates.
  let nextYear = referenceYear + 1;
  for (let offset = bytes.length - 32; offset >= 0; offset -= 32) {
    const packed = bytes.readUInt16LE(offset);
    let year = (packed >> 11) + 2004;
    while (year > nextYear) year -= 32;
    nextYear = year;
    const minute = bytes.readUInt16LE(offset + 2);
    if (!endMinutes.has(minute)) continue;
    const monthDay = packed & 2047;
    const label = endLabel(
      `${year}-${pad2(Math.floor(monthDay / 100))}-${pad2(monthDay % 100)}`,
      `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`,
    );
    if (seen.has(label)) {
      seen.set(label, "duplicate-interval");
      continue;
    }
    const repairs = { fixed: 0, dropped: 0 };
    parseBars(bytes.subarray(offset, offset + 32), "5m", year, 2, repairs);
    seen.set(
      label,
      repairs.fixed || repairs.dropped ? "invalid-interval" : "valid",
    );
  }
  return seen;
}

/** Builds a read-only research source from frozen LC5 bytes and independent
 * volume evidence. The caller supplies an explicit year to decode LC5 dates. */
export function parseExecutionRealityLc5(input: {
  symbol: string;
  bytes: Buffer;
  referenceYear: number;
  volumeEvidence?: ExecutionRealityVolumeEvidence;
}): ExecutionRealityLc5 {
  const { bytes, symbol, referenceYear, volumeEvidence } = input;
  if (
    !Number.isInteger(referenceYear) ||
    referenceYear < 1990 ||
    referenceYear > 9999
  )
    throw new Error("Invalid LC5 reference year");
  const volumeUnit = isLocalFund(symbol)
    ? "fund-units"
    : isAStock(symbol)
      ? "shares"
      : null;
  if (volumeUnit === null)
    throw new Error("LC5 execution requires a stock or ETF symbol");
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  if (
    volumeEvidence &&
    (volumeEvidence.sourceHash !== sourceHash ||
      !knownHash(volumeEvidence.auditHash))
  ) {
    throw new Error("LC5 volume evidence does not identify the frozen source");
  }
  const repairs = { fixed: 0, dropped: 0 };
  const bars = new Map(
    parseBars(bytes, "5m", referenceYear, 2, repairs)
      .filter((bar) => morningEnds.includes(bar.date.slice(11, 16)))
      .map((bar) => [bar.date, bar] as const),
  );
  const anomalies =
    repairs.fixed || repairs.dropped
      ? checkSourceAnomalies(bytes, referenceYear)
      : undefined;
  const certified = new Map(
    [...bars.keys()].map(
      (end) => [end, { ...volumeEvidence?.byEnd[end] }] as const,
    ),
  );
  function observedBar(label: string) {
    const anomaly = anomalies?.get(label);
    return anomaly && anomaly !== "valid" ? undefined : bars.get(label);
  }

  function quote(
    date: string,
    ends: readonly ExecutionRealitySliceEnd[],
  ): MinuteQuote {
    const intervalEnds = ends.map((end) => endLabel(date, end));
    const rows: MinuteRow[] = [];
    for (const intervalEnd of intervalEnds) {
      const unavailable = (reason: MinuteFailure) => ({
        status: "unavailable" as const,
        intervalEnd,
        reason,
      });
      const anomaly = anomalies?.get(intervalEnd);
      if (anomaly && anomaly !== "valid") return unavailable(anomaly);
      const bar = bars.get(intervalEnd);
      if (!bar) return unavailable("missing-interval");
      const evidence = certified.get(intervalEnd);
      if (evidence?.quality === "estimated")
        return unavailable("estimated-volume");
      if (evidence?.quality !== "actual")
        return unavailable("unverified-volume");
      if (evidence.volumeUnit !== volumeUnit || evidence.amountUnit !== "CNY")
        return unavailable("invalid-units");
      if (!(
        bar.amount > 0 &&
        Number.isSafeInteger(bar.volume) &&
        bar.volume > 0
      ))
        return unavailable("invalid-interval");
      const price = bar.amount / bar.volume;
      // Match the shared TDX volume-normalization tolerance for rounded OHLC.
      const tolerance = 0.001 + bar.high * 0.000001;
      if (price < bar.low - tolerance || price > bar.high + tolerance)
        return unavailable("amount-volume-outside-ohlc");
      rows.push(bar);
    }
    const amount = rows.reduce((sum, bar) => sum + bar.amount, 0);
    const quantity = rows.reduce((sum, bar) => sum + bar.volume, 0);
    return {
      status: "available",
      referencePrice: amount / quantity,
      amount,
      quantity,
      low: Math.min(...rows.map((bar) => bar.low)),
      high: Math.max(...rows.map((bar) => bar.high)),
      volumeUnit: volumeUnit!,
      intervalEnds,
    };
  }
  return {
    symbol,
    sourceHash,
    referenceYear,
    volumeAuditHash: volumeEvidence?.auditHash ?? null,
    prefixRange(date, end) {
      if (!supportedEnds.has(end))
        throw new Error("Invalid LC5 execution interval");
      // Price chronology only needs observed OHLC, independent of volume certification.
      let low = Infinity;
      let high = -Infinity;
      for (const time of morningEnds) {
        const bar = observedBar(endLabel(date, time));
        if (!bar) return null;
        low = Math.min(low, bar.low);
        high = Math.max(high, bar.high);
        if (time === end) return { low, high };
      }
      return null;
    },
    interval(date, end) {
      if (!supportedEnds.has(end))
        throw new Error("Invalid LC5 execution interval");
      return quote(date, [end]);
    },
    window(date, window) {
      return quote(date, executionWindows[window]);
    },
  };
}

export type ExecutionRealityMinuteFailure = MinuteFailure;
