import { createHash } from "node:crypto";
import { historicalDateSchema } from "~/lib/screening/historical-screen";
import { symbolSchema, type Bar } from "~/lib/domain";

/** Raw vendor units: index volume must not be relabelled as stock shares. */
export type TdxDailyIncrement = {
  symbol: string;
  bar: Bar;
  volumeUnit: "tdx-raw";
};

/** Read a paired g4day COD/MD1 snapshot. No writes or source-file conversion. */
export function parseTdxDailyIncrement(
  market: "sh" | "sz" | "bj",
  date: string,
  cod: Buffer,
  md1: Buffer,
  symbols: string[],
) {
  historicalDateSchema.parse(date);
  if (!cod.length || cod.length % 150 || cod.length > 150 * 65536)
    throw new Error("日线增量代码表长度非法");
  if (!md1.length || md1.length % 512 || md1.length > 512 * 65536)
    throw new Error("日线增量行情块长度非法");
  const wanted = new Set(symbols.map((symbol) => symbolSchema.parse(symbol)));
  if ([...wanted].some((symbol) => !symbol.startsWith(market)))
    throw new Error("日线增量样本市场不一致");
  const seen = new Set<string>();
  const records: TdxDailyIncrement[] = [];
  const unavailable: { symbol: string; reason: string }[] = [];
  for (let offset = 0; offset < cod.length; offset += 150) {
    const code = cod.subarray(offset, offset + 6).toString("latin1");
    if (!/^\d{6}$/.test(code)) throw new Error("日线增量证券代码非法");
    const symbol = market + code;
    if (seen.has(symbol)) throw new Error("日线增量证券代码重复");
    seen.add(symbol);
    const position = cod.readUInt16LE(offset + 32) * 512;
    if (position + 512 > md1.length) throw new Error("日线增量行情块越界");
    if (!wanted.has(symbol)) continue;
    const volume = md1.readBigUInt64LE(position + 56);
    if (volume > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("日线增量成交量超出安全精度");
    const bar: Bar = {
      date,
      open: md1.readDoubleLE(position + 12),
      high: md1.readDoubleLE(position + 20),
      low: md1.readDoubleLE(position + 28),
      close: md1.readDoubleLE(position + 36),
      volume: Number(volume),
      amount: md1.readDoubleLE(position + 72),
    };
    if (
      Object.values(bar).some(
        (value) => typeof value === "number" && !Number.isFinite(value),
      )
    )
      throw new Error("日线增量包含非有限值");
    if (bar.amount < 0) throw new Error("日线增量成交额非法");
    if (
      bar.open === 0 &&
      bar.high === 0 &&
      bar.low === 0 &&
      bar.close >= 0 &&
      bar.volume === 0 &&
      bar.amount === 0
    ) {
      unavailable.push({
        symbol,
        reason:
          bar.close === 0 ? "empty-vendor-record" : "no-trading-vendor-record",
      });
      continue;
    }
    if (
      bar.low <= 0 ||
      bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close)
    )
      throw new Error(`日线增量价格关系非法：${symbol}`);
    records.push({ symbol, bar, volumeUnit: "tdx-raw" });
  }
  for (const symbol of wanted)
    if (!seen.has(symbol)) unavailable.push({ symbol, reason: "absent-code" });
  return {
    market,
    date,
    records,
    unavailable,
    hash: createHash("sha256")
      .update("tdx-g4day-v1:")
      .update(market)
      .update(date)
      .update(cod)
      .update(md1)
      .digest("hex"),
  };
}
