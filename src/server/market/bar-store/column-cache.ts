import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  openSync,
  fstatSync,
  closeSync,
  readSync,
  writeSync,
  fsyncSync,
  statSync,
  truncateSync,
  rmdirSync,
} from "node:fs";
import { join, dirname, isAbsolute, resolve, relative, sep } from "node:path";
import { z } from "zod";
import { crc32 } from "node:zlib";
import { dataDirectory } from "../../db";
import type { Bar } from "~/lib/domain";
import { contentDigest } from "./content-digest";

const headerSize = 16384;
const magic = "QBARCOL1";
const maximumFileBytes = 128 * 1024 * 1024;
const columnBytesPerBar = 60;
const maximumFileBars = Math.floor(
  (maximumFileBytes - headerSize - 4) / columnBytesPerBar,
);
export class CacheBusyError extends Error {}
const fields = ["open", "high", "low", "close", "volume", "amount"] as const;
const metadataSchema = z.object({
  fingerprint: z.string(),
  count: z.number().int().min(0).max(maximumFileBars),
  bytes: z.number().int().min(headerSize).max(maximumFileBytes),
  digest: z.string(),
  checksum: z.number().int().min(0).max(0xffffffff).optional(),
  source: z.record(z.unknown()),
});
export type CacheMetadata = z.infer<typeof metadataSchema>;
export type CachedBars = { bars: Bar[]; metadata: CacheMetadata };
let researchDirectory:
  { value: string; cwd: string; directory: string } | undefined;
export function columnCacheDirectory() {
  const shared = process.env.QUANT_RESEARCH_BAR_STORE_DIR;
  if (!shared) return join(dataDirectory(), "bar-store");
  const cwd = process.cwd();
  if (researchDirectory?.value === shared && researchDirectory.cwd === cwd)
    return researchDirectory.directory;
  const directory = resolve(shared);
  const [owner, child] = relative(cwd, directory).split(sep);
  if (!isAbsolute(shared) || owner !== ".test-data" || !child)
    throw new Error(
      "Research BarStore cache must be absolute and inside .test-data",
    );
  researchDirectory = { value: shared, cwd, directory };
  return directory;
}
export function cachePath(key: string) {
  return join(
    columnCacheDirectory(),
    createHash("sha256").update(key).digest("hex") + ".bars",
  );
}
function encodeBlock(bars: readonly Bar[]) {
  const n = bars.length,
    body = Buffer.alloc(4 + n * columnBytesPerBar);
  body.writeUInt32LE(n);
  for (let i = 0; i < n; i++) {
    const bar = bars[i]!,
      time = Date.parse(bar.date);
    if (
      !Number.isFinite(time) ||
      (i > 0 && bar.date <= bars[i - 1]!.date) ||
      !fields.every((f) => Number.isFinite(bar[f]))
    )
      throw new Error("BarStore 缓存输入非法");
    const offset =
      bar.date.length === 10
        ? -2147483648
        : bar.date.endsWith("Z")
          ? bar.date.includes(".")
            ? 1500
            : 1501
          : (() => {
              const m = /([+-])(\d{2}):(\d{2})$/.exec(bar.date);
              if (!m) throw new Error("BarStore 时间格式非法");
              return (
                (m[1] === "+" ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3]))
              );
            })();
    body.writeDoubleLE(time, 4 + i * 8);
    body.writeInt32LE(offset, 4 + n * 8 + i * 4);
    for (const [column, field] of fields.entries())
      body.writeDoubleLE(bar[field], 4 + n * 12 + column * n * 8 + i * 8);
  }
  return body;
}
// Labels are shared across thousands of daily histories, but Bar objects never
// are. Bound this dictionary so minute/crypto histories cannot grow it forever.
const dateLabels = new Map<string, string>();
const dailyLabels = new Map<number, string>();
function dateLabel(time: number, offset: number) {
  if (offset === -2147483648) {
    const dayNumber = time / 86400000;
    let day = dailyLabels.get(dayNumber);
    if (day !== undefined) return day;
    day = new Date(time).toISOString().slice(0, 10);
    if (dailyLabels.size >= 65536) dailyLabels.clear();
    dailyLabels.set(dayNumber, day);
    return day;
  }
  const key = `${time}:${offset}`;
  const known = dateLabels.get(key);
  if (known !== undefined) return known;
  const wall = new Date(
    time +
      (offset === -2147483648 || offset === 1500 || offset === 1501
        ? 0
        : offset * 60000),
  ).toISOString();
  let date: string;
  if (offset === -2147483648) date = wall.slice(0, 10);
  else if (offset === 1500) date = wall;
  else if (offset === 1501) date = wall.replace(".000Z", "Z");
  else {
    const zone = `${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
    date = wall.replace(".000Z", zone);
  }
  if (dateLabels.size >= 65536) dateLabels.clear();
  dateLabels.set(key, date);
  return date;
}
function decodeBlocks(body: Buffer): Bar[] {
  const bars: Bar[] = [];
  let previousTime = -Infinity;
  for (let cursor = 0; cursor < body.length;) {
    if (cursor + 4 > body.length) throw new Error("BarStore 缓存块截断");
    const n = body.readUInt32LE(cursor),
      length = 4 + n * columnBytesPerBar;
    if (!n || cursor + length > body.length)
      throw new Error("BarStore 缓存列截断");
    const block = body.subarray(cursor, cursor + length);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let i = 0; i < n; i++) {
      const time = view.getFloat64(4 + i * 8, true),
        offset = view.getInt32(4 + n * 8 + i * 4, true);
      const at = 4 + n * 12 + i * 8;
      const open = view.getFloat64(at, true),
        high = view.getFloat64(at + n * 8, true),
        low = view.getFloat64(at + n * 16, true),
        close = view.getFloat64(at + n * 24, true),
        volume = view.getFloat64(at + n * 32, true),
        amount = view.getFloat64(at + n * 40, true);
      if (
        !Number.isFinite(open) ||
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        !Number.isFinite(close) ||
        !Number.isFinite(volume) ||
        !Number.isFinite(amount) ||
        !Number.isFinite(time) ||
        time <= previousTime ||
        low <= 0 ||
        high < open ||
        high < close ||
        low > open ||
        low > close ||
        volume < 0 ||
        amount < 0
      )
        throw new Error("BarStore 缓存数值或顺序损坏");
      previousTime = time;
      bars.push({
        date: dateLabel(time, offset),
        open,
        high,
        low,
        close,
        volume,
        amount,
      });
    }
    cursor += length;
  }
  return bars;
}
function header(metadata: CacheMetadata) {
  const json = Buffer.from(JSON.stringify(metadata)),
    body = Buffer.alloc(headerSize);
  if (json.length > headerSize - 20) throw new Error("BarStore 缓存元数据超限");
  body.write(magic);
  body.writeUInt32LE(2, 8);
  body.writeUInt32LE(json.length, 12);
  json.copy(body, 16);
  body.writeUInt32LE(crc32(json), headerSize - 4);
  return body;
}
function signature(path: string) {
  const s = statSync(path, { bigint: true });
  if (s.size > BigInt(maximumFileBytes))
    throw new Error("BarStore 单文件容量超限");
  return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}
export function readColumnCache(key: string): CachedBars | null {
  const path = cachePath(key);
  let body: Buffer;
  let current: string;
  try {
    // Bind identity, size bound and bytes to one open generation. Avoid the
    // duplicate path stat plus readFileSync's own open/fstat on every hit.
    const handle = openSync(path, "r");
    try {
      const s = fstatSync(handle, { bigint: true });
      if (s.size > BigInt(maximumFileBytes))
        throw new Error("BarStore 单文件容量超限");
      current = `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
      body = Buffer.allocUnsafe(Number(s.size));
      let read = 0;
      while (read < body.length) {
        const n = readSync(handle, body, read, body.length - read, read);
        if (!n) {
          body = body.subarray(0, read);
          break;
        }
        read += n;
      }
    } finally {
      closeSync(handle);
    }
    // A complete checksummed header/payload is a committed generation, even
    // if an appender commits a newer header after this read. Torn reads fail
    // the header/body checks below; trailing uncommitted bytes stay ignored.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    body.length < headerSize ||
    body.toString("ascii", 0, 8) !== magic ||
    ![1, 2].includes(body.readUInt32LE(8)) ||
    body.readUInt32LE(12) > headerSize - 16
  )
    throw new Error("BarStore 缓存版本或头部非法");
  if (
    body.readUInt32LE(8) === 2 &&
    crc32(body.subarray(16, 16 + body.readUInt32LE(12))) !==
      body.readUInt32LE(headerSize - 4)
  )
    throw new Error("BarStore 缓存头部校验失败");
  const metadata = metadataSchema.parse(
    JSON.parse(body.toString("utf8", 16, 16 + body.readUInt32LE(12))),
  );
  const content = body.subarray(headerSize, metadata.bytes);
  if (
    body.length < metadata.bytes ||
    (metadata.checksum !== undefined
      ? crc32(content) !== metadata.checksum
      : contentDigest(
          `${path}:${metadata.digest}:${metadata.bytes}`,
          content,
        ) !== metadata.digest)
  )
    throw new Error("BarStore 缓存校验失败");
  const bars = decodeBlocks(content);
  if (bars.length !== metadata.count)
    throw new Error("BarStore 缓存记录数不符");
  if (metadata.checksum === undefined)
    upgradeChecksum(path, current, metadata, content);
  return { bars, metadata };
}

/** Add checksums to a verified v1 generation without rewriting its columns.
 * A busy writer owns the file; skip the optional upgrade and retry next read. */
function upgradeChecksum(
  path: string,
  expected: string,
  metadata: CacheMetadata,
  content: Buffer,
) {
  const lock = `${path}.lock`;
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try {
    writeFileSync(join(lock, "owner"), String(process.pid));
    if (signature(path) !== expected) return;
    metadata.checksum = crc32(content);
    const handle = openSync(path, "r+");
    try {
      writeSync(handle, header(metadata), 0, headerSize, 0);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } finally {
    rmSync(join(lock, "owner"), { force: true });
    rmdirSync(lock);
  }
}
/** Per-key inter-process writer exclusion. Readers see either committed header;
 * interrupted append tails are ignored and truncated on the next write.
 * A dead owner's lock is reclaimed; a live owner is never stolen. */
export function writeColumnCache(
  key: string,
  bars: Bar[],
  fingerprint: string,
  source: Record<string, unknown>,
) {
  if (bars.length > maximumFileBars) throw new Error("BarStore 单文件容量超限");
  const path = cachePath(key),
    lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let pid: number;
    try {
      pid = Number(readFileSync(join(lock, "owner"), "utf8"));
    } catch {
      throw new CacheBusyError("BarStore 缓存写锁尚未就绪，请重试");
    }
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive) throw new CacheBusyError("BarStore 缓存正在写入，请重试");
    rmSync(join(lock, "owner"));
    rmdirSync(lock);
    mkdirSync(lock);
  }
  writeFileSync(join(lock, "owner"), String(process.pid));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    let old: CachedBars | null = null;
    try {
      old = readColumnCache(key);
    } catch {
      /* Rebuild derived cache from the verified source. */
    }
    const samePrefix =
      old &&
      old.bars.length <= bars.length &&
      old.bars.every(
        (b, i) =>
          b.date === bars[i]!.date && fields.every((f) => b[f] === bars[i]![f]),
      );
    const previous = samePrefix
      ? readFileSync(path).subarray(headerSize, old!.metadata.bytes)
      : Buffer.alloc(0);
    const tail = bars.slice(samePrefix ? old!.bars.length : 0);
    const added = tail.length ? encodeBlock(tail) : Buffer.alloc(0);
    const metadata: CacheMetadata = {
      fingerprint,
      count: bars.length,
      bytes: headerSize + previous.length + added.length,
      digest: createHash("sha256").update(previous).update(added).digest("hex"),
      checksum: crc32(added, crc32(previous)),
      source,
    };
    if (metadata.bytes > maximumFileBytes)
      throw new Error("BarStore 单文件容量超限");
    if (samePrefix) {
      truncateSync(path, old!.metadata.bytes);
      const handle = openSync(path, "r+");
      try {
        writeSync(handle, added, 0, added.length, old!.metadata.bytes);
        fsyncSync(handle);
        writeSync(handle, header(metadata), 0, headerSize, 0);
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
    } else {
      writeFileSync(temporary, Buffer.concat([header(metadata), added]));
      renameSync(temporary, path);
    }
    return metadata;
  } finally {
    rmSync(temporary, { force: true });
    rmSync(join(lock, "owner"));
    rmdirSync(lock);
  }
}
