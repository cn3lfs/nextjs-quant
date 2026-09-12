import { readdir, stat, readFile, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Bar, Coverage, Period, Security, Snapshot } from "~/lib/domain";
import { symbolSchema } from "~/lib/domain";
import { historicalDateSchema } from "~/lib/historical-screen";
import type { Stats } from "node:fs";
import { exchangeNames } from "./exchange-security-names";
import { commonIndexName, isMarketIndex } from "~/lib/market-indices";
import { encodeTail, decodeTail } from "./tail-cache-codec";
const tailCache = new Map<
  string,
  { signature: string; loadedAt: number; payload: Buffer; bars: number }
>();
let cachedBars = 0,
  cachedBytes = 0,
  tailHits = 0,
  tailLoads = 0;
const tailSignature = (s: Stats) =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.birthtimeMs}`;
export const tailCacheStats = () => ({
  entries: tailCache.size,
  bars: cachedBars,
  bytes: cachedBytes,
  hits: tailHits,
  loads: tailLoads,
});
function forgetTail(key: string) {
  const old = tailCache.get(key);
  if (old) {
    cachedBars -= old.bars;
    cachedBytes -= old.payload.byteLength;
  }
  tailCache.delete(key);
}
const nameCache = new Map<
  string,
  { updated: number; signature: string; names: Map<string, string> }
>();
export function parseNames(buffer: Buffer, market: string) {
  const names = new Map<string, string>();
  if ((buffer.length - 50) % 360 !== 0) return names;
  const decoder = new TextDecoder("gb18030");
  for (let offset = 50; offset + 360 <= buffer.length; offset += 360) {
    const code = buffer.subarray(offset, offset + 6).toString("ascii");
    if (!/^\d{6}$/.test(code)) continue;
    const name = decoder
      .decode(buffer.subarray(offset + 31, offset + 63))
      .split("\0")[0]!
      .trim();
    if (name) names.set(market + code, name);
  }
  return names;
}
export async function securityNames(
  root: string,
  market: string,
  refresh = false,
) {
  const key = join(
      root,
      "T0002",
      "hq_cache",
      `${market === "bj" ? "bjs" : market + "s"}.tnf`,
    ),
    cached = nameCache.get(key);
  if (!refresh && cached && Date.now() - cached.updated < 60000)
    return cached.names;
  try {
    const before = await stat(key);
    if (
      cached &&
      Date.now() - cached.updated < 60000 &&
      cached.signature === tailSignature(before)
    )
      return cached.names;
    const bytes = await readFile(key),
      after = await stat(key);
    if (tailSignature(before) !== tailSignature(after))
      throw new Error("证券名称文件正在更新");
    const names = parseNames(bytes, market);
    nameCache.set(key, {
      updated: Date.now(),
      signature: tailSignature(after),
      names,
    });
    return names;
  } catch {
    nameCache.delete(key);
    return new Map<string, string>();
  }
}
export function isAStock(symbol: string) {
  return /^(sh(60|68)\d{4}|sz(00|30)\d{4}|bj(43|83|87|88|92)\d{4})$/.test(
    symbol,
  );
}
export function parseBars(
  buffer: Buffer,
  period: Period,
  referenceYear = new Date().getFullYear(),
): Bar[] {
  if (buffer.length % 32 !== 0)
    throw new Error("行情文件不完整：记录长度不是 32 字节的整数倍");
  const bars: Bar[] = [];
  // The 5-bit year field wraps every 32 years. Unwrap backwards from the newest
  // record so pre-2004 history (e.g. 2001 encoded as 2033) remains chronological.
  const years = new Map<number, number>();
  let nextYear = referenceYear + 1;
  if (period === "5m")
    for (let i = buffer.length - 32; i >= 0; i -= 32) {
      let year = (buffer.readUInt16LE(i) >> 11) + 2004;
      while (year > nextYear) year -= 32;
      years.set(i, year);
      nextYear = year;
    }
  for (let i = 0; i < buffer.length; i += 32) {
    let date: string, prices: number[];
    if (period === "day") {
      const n = buffer.readUInt32LE(i),
        year = Math.floor(n / 10000),
        month = Math.floor(n / 100) % 100,
        day = n % 100;
      date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      prices = [4, 8, 12, 16].map(
        (offset) => buffer.readUInt32LE(i + offset) / 100,
      );
    } else {
      const packed = buffer.readUInt16LE(i),
        year = years.get(i)!,
        md = packed & 2047,
        month = Math.floor(md / 100),
        day = md % 100,
        minutes = buffer.readUInt16LE(i + 2);
      if (minutes >= 1440) throw new Error("分钟线时间非法");
      date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00+08:00`;
      prices = [4, 8, 12, 16].map((offset) => buffer.readFloatLE(i + offset));
    }
    const [open, high, low, close] = prices as [number, number, number, number],
      volume = buffer.readUInt32LE(i + 24),
      amount = buffer.readFloatLE(i + 20),
      day = date.slice(0, 10),
      validDate = new Date(day);
    if (
      !Number.isFinite(+validDate) ||
      validDate.toISOString().slice(0, 10) !== day ||
      day < "1990-01-01" ||
      !prices.every((v) => Number.isFinite(v) && v > 0) ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      low > Math.min(open, close) ||
      high < Math.max(open, close) ||
      high < low
    )
      throw new Error(`行情记录非法：${date}`);
    if (bars.length && date <= bars.at(-1)!.date)
      throw new Error("行情时间重复或倒序");
    bars.push({ date, open, high, low, close, volume, amount });
  }
  return bars;
}
export async function scan(root: string): Promise<Coverage> {
  const counts: Record<string, number> = {},
    securities: Security[] = [];
  for (const market of ["sh", "sz", "bj"])
    for (const period of ["day", "5m"] as const) {
      const dir = join(
        resolve(root),
        "vipdoc",
        market,
        period === "day" ? "lday" : "fzline",
      );
      let files: string[];
      try {
        files = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          counts[`${market}/${period}`] = 0;
          continue;
        }
        throw error;
      }
      counts[`${market}/${period}`] = 0;
      const names = await securityNames(root, market);
      for (const file of files) {
        if (!file.toLowerCase().endsWith(period === "day" ? ".day" : ".lc5"))
          continue;
        counts[`${market}/${period}`]!++;
        const symbol = file.split(".")[0]!.toLowerCase();
        if (!isAStock(symbol)) continue;
        const info = await stat(join(dir, file));
        securities.push({
          symbol,
          name: names.get(symbol) ?? exchangeNames.get(symbol)?.name ?? symbol,
          market,
          bytes: info.size,
          modified: info.mtimeMs,
          period,
        });
      }
    }
  if (!securities.length)
    throw new Error("目录中没有可读取的 A 股行情，请检查通达信路径及盘后下载");
  return { root, counts, securities, scannedAt: Date.now() };
}
export async function readSnapshot(
  root: string,
  symbol: string,
  period: Period,
): Promise<Snapshot> {
  symbolSchema.parse(symbol);
  if (!isAStock(symbol) && !isMarketIndex(symbol))
    throw new Error("仅支持A股与沪深指数行情");
  const file = join(
    resolve(root),
    "vipdoc",
    symbol.slice(0, 2),
    period === "day" ? "lday" : "fzline",
    `${symbol}.${period === "day" ? "day" : "lc5"}`,
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    const handle = await open(file, "r");
    let buffer: Buffer;
    let stable: boolean;
    try {
      const before = await handle.stat();
      buffer = await handle.readFile();
      const after = await handle.stat();
      const current = await stat(file);
      stable =
        buffer.length === before.size &&
        tailSignature(before) === tailSignature(after) &&
        tailSignature(after) === tailSignature(current);
    } finally {
      await handle.close();
    }
    // A downloader may replace a file while preserving its size and mtime.
    // Check the opened file identity and the current path before publication.
    if (!stable) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    const bars = parseBars(buffer, period),
      hash = createHash("sha256").update(buffer).digest("hex");
    if (!bars.length) throw new Error("行情文件为空");
    return {
      id: `snapshot-${symbol}-${period}-${hash.slice(0, 16)}`,
      symbol,
      name:
        (await securityNames(root, symbol.slice(0, 2))).get(symbol) ??
        exchangeNames.get(symbol)?.name ??
        commonIndexName(symbol),
      period,
      source: "tdx-local",
      dataRoot: resolve(root),
      adjustment: "none",
      createdAt: Date.now(),
      bars,
      hash,
    };
  }
  throw new Error("通达信正在更新文件，请稍后重试");
}

// Screening needs a bounded suffix, not a full-history parse. The window hash
// includes its semantics so it cannot collide with a full backtest snapshot.
export async function readTailSnapshot(
  root: string,
  symbol: string,
  period: Period,
  count: number,
): Promise<Snapshot> {
  symbolSchema.parse(symbol);
  if (!isAStock(symbol)) throw new Error("仅支持 A 股");
  if (!Number.isInteger(count) || count < 2 || count > 10000)
    throw new Error("行情窗口长度非法");
  const file = join(
    resolve(root),
    "vipdoc",
    symbol.slice(0, 2),
    period === "day" ? "lday" : "fzline",
    `${symbol}.${period === "day" ? "day" : "lc5"}`,
  );
  const cacheKey = `${file}:${period}:none:tail-v1:${count}:${new Date().getFullYear()}`;
  const cached = tailCache.get(cacheKey);
  if (cached) {
    let current: Stats;
    try {
      current = await stat(file);
    } catch (error) {
      forgetTail(cacheKey);
      throw error;
    }
    if (
      Date.now() - cached.loadedAt < 30000 &&
      tailSignature(current) === cached.signature
    ) {
      tailHits++;
      tailCache.delete(cacheKey);
      tailCache.set(cacheKey, cached);
      const result = decodeTail(cached.payload);
      result.name =
        (await securityNames(root, symbol.slice(0, 2))).get(symbol) ??
        exchangeNames.get(symbol)?.name;
      return result;
    }
    forgetTail(cacheKey);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const handle = await open(file, "r");
    try {
      const before = await handle.stat();
      if (!before.size || before.size % 32)
        throw new Error("行情文件为空或记录不完整");
      const size = Math.min(before.size, count * 32),
        buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          size - offset,
          before.size - size + offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat(),
        current = await stat(file);
      if (
        offset !== size ||
        tailSignature(before) !== tailSignature(after) ||
        tailSignature(current) !== tailSignature(after)
      )
        continue;
      const bars = parseBars(buffer, period),
        hash = createHash("sha256")
          .update(`tail-v1:${symbol}:${period}:none:${count}:`)
          .update(buffer)
          .digest("hex");
      const snapshot: Snapshot = {
        id: `snapshot-tail-${symbol}-${period}-${hash.slice(0, 16)}`,
        symbol,
        name:
          (await securityNames(root, symbol.slice(0, 2))).get(symbol) ??
          exchangeNames.get(symbol)?.name,
        period,
        source: "tdx-local",
        dataRoot: resolve(root),
        adjustment: "none",
        createdAt: Date.now(),
        bars,
        hash,
      };
      tailLoads++;
      forgetTail(cacheKey);
      const payload = encodeTail(snapshot);
      tailCache.set(cacheKey, {
        signature: tailSignature(current),
        loadedAt: Date.now(),
        payload,
        bars: bars.length,
      });
      cachedBars += bars.length;
      cachedBytes += payload.byteLength;
      while (
        cachedBars > 1000000 ||
        cachedBytes > 128 * 1024 * 1024 ||
        tailCache.size > 20000
      )
        forgetTail(tailCache.keys().next().value!);
      return snapshot;
    } finally {
      await handle.close();
    }
  }
  throw new Error("通达信正在更新文件，请稍后重试");
}

/** Historical reads deliberately use the validated full series before slicing. */
export async function readHistoricalSnapshot(
  root: string,
  symbol: string,
  period: Period,
  count: number,
  asOf: string,
): Promise<Snapshot> {
  historicalDateSchema.parse(asOf);
  if (!Number.isInteger(count) || count < 2 || count > 10000)
    throw new Error("历史窗口长度非法");
  const source = await readSnapshot(root, symbol, period);
  const bars = source.bars
    .filter((bar) => bar.date.slice(0, 10) <= asOf)
    .slice(-count);
  const hash = createHash("sha256")
    .update(`historical-v1:${symbol}:${period}:${asOf}:${count}:`)
    .update(JSON.stringify(bars))
    .digest("hex");
  return {
    ...source,
    id: `snapshot-historical-${symbol}-${period}-${hash.slice(0, 16)}`,
    hash,
    bars,
    historicalAsOf: asOf,
  };
}
