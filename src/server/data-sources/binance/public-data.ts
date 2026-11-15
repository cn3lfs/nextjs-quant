import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { z } from "zod";
import type { Bar } from "trading-strategy-core/bars";
import { cryptoBarDate } from "~/lib/market/crypto";

export const archiveIntervals = ["1d", "4h", "1h", "15m", "5m"] as const;
export type ArchiveInterval = (typeof archiveIntervals)[number] | "1m";
export const archiveStep: Record<ArchiveInterval, number> = {
  "1d": 86400000,
  "4h": 14400000,
  "1h": 3600000,
  "15m": 900000,
  "5m": 300000,
  "1m": 60000,
};
export const archiveSymbolSchema = z.enum(["BTCUSDT", "ETHUSDT"]);
export const archiveIntervalSchema = z.enum([
  "1d",
  "4h",
  "1h",
  "15m",
  "5m",
  "1m",
]);
export type ArchiveRow = {
  openTime: number;
  closeTime: number;
  columns: string[];
  bar: Bar;
};
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
/** Official spot archives switched to microseconds on 2025-01-01. REST keeps
 * milliseconds unless the caller explicitly requests microseconds. */
export function archiveTimestamp(value: string) {
  if (!/^\d{13}$|^\d{16}$/.test(value))
    throw new Error("Invalid Binance timestamp precision");
  const raw = Number(value);
  if (!Number.isSafeInteger(raw)) throw new Error("Unsafe Binance timestamp");
  return value.length === 16 ? Math.floor(raw / 1000) : raw;
}
export function parseArchiveCsv(
  text: string,
  interval: ArchiveInterval,
  now = Date.now(),
) {
  const rows: ArchiveRow[] = [],
    quarantined: { line: number; openTime: number; reason: string }[] = [];
  let previous = -1;
  const step = archiveStep[interval];
  for (const [index, line] of text.trim().split(/\r?\n/).entries()) {
    if (!line) continue;
    const c = line.split(",");
    if (c.length !== 12 || c.some((v) => !v.trim()))
      throw new Error(`Binance CSV needs 12 columns at line ${index + 1}`);
    const openTime = archiveTimestamp(c[0]!),
      closeTime = archiveTimestamp(c[6]!);
    if (openTime <= previous)
      throw new Error("Binance time is not strictly increasing");
    previous = openTime;
    const values = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11].map((i) => Number(c[i]));
    if (
      values.some((v) => !Number.isFinite(v) || v < 0) ||
      values.slice(0, 4).some((v) => v <= 0) ||
      !Number.isSafeInteger(Number(c[8]))
    )
      throw new Error("Invalid Binance numeric columns");
    const [open, high, low, close, volume, amount] = values;
    if (
      high! < Math.max(open!, close!) ||
      low! > Math.min(open!, close!) ||
      high! < low!
    )
      throw new Error("Invalid Binance OHLC");
    if (openTime % step !== 0 || closeTime !== openTime + step - 1) {
      // Preserve official bytes; observed non-grid/zero-duration source rows
      // become explicit gaps, never repaired timestamps or synthetic candles.
      quarantined.push({
        line: index + 1,
        openTime,
        reason: "Non-grid opening or nonstandard closing timestamp",
      });
      continue;
    }
    if (closeTime >= now) continue;
    rows.push({
      openTime,
      closeTime,
      columns: c,
      bar: {
        date: cryptoBarDate(
          openTime,
          closeTime,
          interval === "1d" ? "day" : interval === "1m" ? "5m" : interval,
        ),
        open: open!,
        high: high!,
        low: low!,
        close: close!,
        volume: volume!,
        amount: amount!,
      },
    });
  }
  return { rows, quarantined };
}
export function verifyArchiveChecksum(
  bytes: Uint8Array,
  checksum: string,
  filename: string,
) {
  const match = /^([a-fA-F0-9]{64})\s+\*?([^\r\n]+)\s*$/.exec(checksum.trim());
  if (
    !match ||
    match[2] !== filename ||
    sha256(bytes) !== match[1]!.toLowerCase()
  )
    throw new Error("Binance CHECKSUM mismatch");
}
export function checkedArchive(
  bytes: Uint8Array,
  checksum: string,
  filename: string,
  interval: ArchiveInterval,
  now = Date.now(),
) {
  verifyArchiveChecksum(bytes, checksum, filename);
  const expected = filename.replace(/\.zip$/, ".csv");
  const files = unzipSync(bytes, {
    filter: (file) =>
      file.name === expected && file.originalSize <= 128 * 1024 ** 2,
  });
  if (Object.keys(files).length !== 1 || !files[expected])
    throw new Error("Official archive CSV missing or exceeds 128MiB");
  return parseArchiveCsv(strFromU8(files[expected]), interval, now);
}
export function rowIdentity(row: ArchiveRow) {
  return JSON.stringify([
    row.openTime,
    row.closeTime,
    ...row.columns.slice(1, 6).map(Number),
    ...row.columns.slice(7).map(Number),
  ]);
}
