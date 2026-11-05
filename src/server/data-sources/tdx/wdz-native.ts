import koffi from "koffi";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { fiveMinuteVolumePolicy } from "./five-minute-volume";

let native:
  | {
      xor: ReturnType<ReturnType<typeof koffi.load>["func"]>;
      csv: ReturnType<ReturnType<typeof koffi.load>["func"]>;
      lc5: ReturnType<ReturnType<typeof koffi.load>["func"]>;
    }
  | undefined;
function library() {
  if (!native) {
    const dll = koffi.load(resolve("runtime/tdx-import/wdz-decode.dll"));
    native = {
      xor: dll.func("void wdz_xor(void *, uint32, const void *)"),
      csv: dll.func(
        "int wdz_csv(const void *, uint32, void *, uint32, void *)",
      ),
      lc5: dll.func(
        "int wdz_lc5(const void *, uint32, void *, uint32, void *, int, int, void *, void *, void *, void *)",
      ),
    };
  }
  return native;
}

export function decodeWdzLc5Bars(payload: Buffer, symbol: string) {
  if (payload.length > 8 * 1024 * 1024) throw new Error("WDZ 品种数据过大");
  const data = Buffer.allocUnsafe(payload.length * 4 + 64);
  const overflow = Buffer.alloc(data.length / 8);
  const count = Buffer.alloc(8),
    skipped = Buffer.alloc(overflow.length),
    reference = new Date().getFullYear();
  const legacyVolumes = Buffer.alloc(overflow.length);
  const sourceAmounts = Buffer.alloc(overflow.length);
  const size = library().lc5(
    payload,
    payload.length,
    data,
    data.length,
    count,
    fiveMinuteVolumePolicy(symbol),
    reference,
    overflow,
    skipped,
    legacyVolumes,
    sourceAmounts,
  ) as number;
  if (size < 0)
    throw new Error(
      `WDZ LC5 行情编码非法 (${size})${size === -7 ? "：源数据同一时间内容冲突" : ""}`,
    );
  const bars = count.readUInt32LE(),
    overflowTimes: string[] = [],
    skippedTimes: string[] = [];
  for (let i = 0; i < count.readUInt32LE(4); i++)
    skippedTimes.push(
      new Date(skipped.readUInt32LE(i * 4) * 1000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19),
    );
  for (let i = 0; i < bars; i++) {
    const stamp = overflow.readUInt32LE(i * 4);
    if (stamp)
      overflowTimes.push(
        new Date(stamp * 1000).toISOString().replace("T", " ").slice(0, 19),
      );
  }
  function time(offset: number) {
    const packed = data.readUInt16LE(offset),
      minutes = data.readUInt16LE(offset + 2);
    let year = 2004 + (packed >> 11);
    while (year > reference + 1) year -= 32;
    return new Date(
      Date.UTC(
        year,
        Math.floor((packed & 2047) / 100) - 1,
        (packed & 2047) % 100,
        Math.floor(minutes / 60),
        minutes % 60,
      ),
    )
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
  }
  return {
    data: data.subarray(0, size),
    legacyVolumes: legacyVolumes.subarray(0, bars * 4),
    sourceAmounts: sourceAmounts.subarray(0, bars * 4),
    bars,
    first: size ? time(0) : "",
    last: size ? time(size - 32) : "",
    overflowTimes,
    skippedTimes,
  };
}

/** The legacy CSV exporter rounds Singles to seven significant decimal digits. */
export function decodeWdzBars(payload: Buffer) {
  if (payload.length > 8 * 1024 * 1024) throw new Error("WDZ 品种数据过大");
  const out = Buffer.allocUnsafe(payload.length * 32 + 300);
  const count = Buffer.alloc(4);
  const size = library().csv(
    payload,
    payload.length,
    out,
    out.length,
    count,
  ) as number;
  if (size < 0) throw new Error(`WDZ 行情编码非法 (${size})`);
  return { csv: out.subarray(0, size), bars: count.readUInt32LE() };
}

export function decodeWdzBlock(block: Buffer) {
  if (block.length < 8) throw new Error("WDZ 数据块截断");
  const n = block.readUInt32LE(),
    size = block.readUInt32LE(4);
  if (n < 4 || block.length !== n + 4 || !size || size > 64 * 1024 * 1024)
    throw new Error("WDZ 数据块长度非法");
  const seed = Buffer.alloc(18);
  seed.write("WSTOCK", 0, "ascii");
  seed.writeUInt32LE(n, 6);
  seed.writeUInt32LE(size, 10);
  seed.write(".net", 14, "ascii");
  const hashes = [createHash("md5").update(seed).digest("hex").toUpperCase()];
  for (const offset of [6, 8, 10]) {
    seed[offset] = 88;
    hashes.push(createHash("md5").update(seed).digest("hex").toUpperCase());
  }
  const compressed = Buffer.from(block.subarray(8));
  library().xor(
    compressed,
    compressed.length,
    Buffer.from(hashes.join(""), "ascii"),
  );
  // Node supports info:true; @types/node 22 still declares only the Buffer result.
  const raw = inflateSync(compressed, {
    maxOutputLength: size,
    info: true,
  }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (
    raw.buffer.length !== size ||
    raw.engine.bytesWritten !== compressed.length
  )
    throw new Error("WDZ 解压长度不符");
  return raw.buffer;
}

function symbolAt(raw: Buffer, offset: number) {
  const bytes = raw.subarray(offset, offset + 12);
  // Older files leave nonzero bytes after the NUL terminator; they are padding.
  const nul = bytes.indexOf(0),
    zero = nul < 0 ? 12 : nul;
  if (bytes.length !== 12 || zero < 3) throw new Error("WDZ 证券代码非法");
  const symbol = bytes.subarray(0, zero).toString("ascii");
  if (!/^(SH|SZ)[A-Z0-9]{1,10}$/.test(symbol))
    throw new Error(`WDZ 交易所或代码不支持: ${symbol}`);
  return symbol;
}

/** Stream one decompressed block at a time; never opens a TDX directory or database. */
async function* readWdzRecords(source: string) {
  const file = await open(source, "r");
  try {
    const { size } = await file.stat();
    if (size < 16 || size > 0xffffffff) throw new Error("WDZ 文件长度非法");
    async function read(position: number, length: number) {
      if (position < 0 || position + length > size)
        throw new Error("WDZ 文件截断");
      const buf = Buffer.allocUnsafe(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await file.read(
          buf,
          done,
          length - done,
          position + done,
        );
        if (!bytesRead) throw new Error("WDZ 文件截断");
        done += bytesRead;
      }
      return buf;
    }
    async function block(position: number, limit: number) {
      if (position + 8 > limit) throw new Error("WDZ 数据块边界非法");
      const header = await read(position, 8),
        n = header.readUInt32LE();
      if (n < 4 || n > 64 * 1024 * 1024 || position + n + 4 > limit)
        throw new Error("WDZ 数据块边界非法");
      const raw = decodeWdzBlock(
        Buffer.concat([header, await read(position + 8, n - 4)]),
      );
      return { raw, next: position + n + 4 };
    }
    const indexOffset = (await read(size - 4, 4)).readUInt32LE();
    if (indexOffset < 8 || indexOffset >= size - 4)
      throw new Error("WDZ 索引位置非法");
    const indexBlock = await block(indexOffset, size - 4);
    if (indexBlock.next !== size - 4 || indexBlock.raw.length % 32)
      throw new Error("WDZ 索引长度非法");
    const entries = new Map<string, string>();
    for (let p = 0; p < indexBlock.raw.length; p += 32) {
      const symbol = symbolAt(indexBlock.raw, p);
      const offset = indexBlock.raw.readUInt32LE(p + 12) - 1,
        blockOffset = indexBlock.raw.readUInt32LE(p + 16),
        key = `${blockOffset}:${offset}`;
      if (entries.has(key)) throw new Error(`WDZ 重复索引位置 ${key}`);
      entries.set(key, symbol);
    }
    const metadata = await block(0, indexOffset);
    if (
      metadata.raw.length !== 68 ||
      metadata.raw.readInt32LE() !== -1315 ||
      metadata.raw.readUInt32LE(4) !== 0x105 ||
      metadata.raw.readUInt32LE(20) !== 100 ||
      metadata.raw.readUInt32LE(24) !== 1000 ||
      metadata.raw.readUInt32LE(28) !== 10000
    )
      throw new Error("不支持的 WDZ 格式或价格倍率");
    let position = metadata.next;
    while (position < indexOffset) {
      const current = await block(position, indexOffset);
      for (let p = 0; p < current.raw.length;) {
        if (p + 32 > current.raw.length) throw new Error("WDZ 品种头截断");
        const symbol = symbolAt(current.raw, p),
          key = `${position}:${p}`;
        if (entries.get(key) !== symbol)
          throw new Error(`WDZ 索引不符 ${symbol}`);
        entries.delete(key);
        const length = current.raw.readUInt32LE(p + 28);
        if (length > current.raw.length - p - 32)
          throw new Error(`WDZ 品种截断 ${symbol}`);
        yield {
          symbol,
          payload: current.raw.subarray(p + 32, p + 32 + length),
        };
        p += 32 + length;
      }
      position = current.next;
    }
    if (entries.size) throw new Error("WDZ 索引有缺失品种");
  } finally {
    await file.close();
  }
}

export async function* readWdzFiveMinute(source: string) {
  for await (const { symbol, payload } of readWdzRecords(source))
    yield { symbol, ...decodeWdzBars(payload) };
}

export async function* readWdzLc5(
  source: string,
  onIssue?: (issue: {
    symbol: string;
    skipped?: string;
    error?: string;
    records?: number;
    times?: string[];
  }) => Promise<void>,
  includeSymbol?: (symbol: string) => boolean,
) {
  for await (const { symbol, payload } of readWdzRecords(source)) {
    if (includeSymbol && !includeSymbol(symbol)) continue;
    if (!/^(SH|SZ)\d{6}$/.test(symbol)) {
      if (!onIssue) throw new Error(`非通达信六位沪深代码: ${symbol}`);
      await onIssue({
        symbol,
        skipped: "非通达信六位沪深代码，不推测历史代码映射",
      });
      continue;
    }
    let item;
    try {
      item = decodeWdzLc5Bars(payload, symbol);
    } catch (error) {
      if (!onIssue) throw error;
      await onIssue({
        symbol,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (item.skippedTimes.length) {
      if (!onIssue) throw new Error(`WDZ 含无效源行情记录 ${symbol}`);
      await onIssue({
        symbol,
        skipped:
          "源行情无效（全零价格、非法 OHLC 或非五分钟时间），不补造价格或时间",
        records: item.skippedTimes.length,
        times: item.skippedTimes,
      });
    }
    if (item.bars) yield { symbol, ...item };
  }
}
