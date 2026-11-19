import type { Bar } from "trading-strategy-core/bars";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile, readdir } from "node:fs/promises";
import { resolve, isAbsolute, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { columnCacheDirectory } from "../../market/bar-store/column-cache";

import {
  type LifecycleSignalOrigin,
  type LifecycleSignalBasis,
} from "./source-types";

export const sourceCacheBudget = 512 * 1024 ** 2;
export const processBudget = 4096 * 1024 ** 2;
export class LifecycleSourceBudgetError extends Error {}
export const bytesHash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const canonicalValue = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonicalValue)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonicalValue(item)]),
        )
      : value;
export const lifecycleContentHash = (value: unknown) =>
  bytesHash(JSON.stringify(canonicalValue(value)));
export const contentHash = lifecycleContentHash;
export const barTuples = (bars: readonly Bar[]) =>
  bars.map((b) => [b.date, b.open, b.high, b.low, b.close, b.volume, b.amount]);
export const lifecycleRawPrefixHash = (bars: readonly Bar[]) =>
  contentHash(barTuples(bars));
export async function readLifecycleSourceManifest(
  path: string,
  expectedInputHash?: string,
) {
  const value = JSON.parse(await readFile(path, "utf8")) as {
    version: string;
    inputHash: string;
    configHash: string;
    identities: {
      classic: {
        files: { path: string; hash: string }[];
        signalBasis?: LifecycleSignalBasis;
      };
      [key: string]: unknown;
    };
  };
  if (
    value.version !== "lifecycle-source-1" ||
    contentHash(value.identities) !== value.inputHash ||
    (expectedInputHash && value.inputHash !== expectedInputHash)
  )
    throw new Error("Frozen lifecycle source manifest identity mismatch");
  return value;
}
export async function readLifecycleSignalOriginBars(
  origin: LifecycleSignalOrigin,
): Promise<Bar[]> {
  const bytes = await readFile(origin.rawSource.path);
  if (bytesHash(bytes) !== origin.rawSource.hash)
    throw new Error("Frozen symbol raw-prefix bytes changed");
  const plain = gunzipSync(bytes, { maxOutputLength: 128 * 1024 ** 2 });
  if (bytesHash(plain) !== origin.rawSource.decodedContentHash)
    throw new Error("Frozen symbol raw-prefix content changed");
  const rows = JSON.parse(plain.toString()) as (string | number)[][];
  const bars = rows.map((r) => ({
    date: String(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    amount: Number(r[6]),
  }));
  orderedBars(bars, origin.symbol);
  if (
    bars[0]?.date !== origin.startDate ||
    bars.at(-1)?.date !== origin.through ||
    lifecycleRawPrefixHash(bars) !== origin.rawPrefixHash
  )
    throw new Error("Frozen symbol raw-prefix proof mismatch");
  return bars;
}
export function memoryBoundary(additional = 0) {
  const rss = process.memoryUsage().rss,
    peak = process.resourceUsage().maxRSS * 1024;
  if (rss + additional > processBudget || peak > processBudget)
    throw new LifecycleSourceBudgetError(
      `Lifecycle source exceeds the single-process 4096MiB budget: rss=${rss}, nativePeak=${peak}, projectedAdditional=${additional}`,
    );
}
export async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
/** Keep large encoded inputs outside the lifetime of the shared parsed bundle. */
export async function verifiedSourceJson<T>(
  path: string,
  fileHash: string,
  gzip?: { maxOutputLength: number; contentHash?: string },
): Promise<T> {
  if (!gzip) memoryBoundary((await stat(path)).size * 3);
  const encoded = await readFile(path);
  if (bytesHash(encoded) !== fileHash)
    throw new Error(`Frozen classic source bytes changed during read: ${path}`);
  if (gzip)
    memoryBoundary(
      encoded.readUInt32LE(encoded.length - 4) * 3 + encoded.length,
    );
  const plain = gzip ? gunzipSync(encoded, gzip) : encoded;
  if (gzip?.contentHash && bytesHash(plain) !== gzip.contentHash)
    throw new Error("Frozen classic panel content hash mismatch");
  return JSON.parse(plain.toString()) as T;
}
export async function derivedBytes(directory: string) {
  let bytes = 0;
  try {
    for (const file of await readdir(directory, { withFileTypes: true }))
      if (file.isFile()) bytes += (await stat(join(directory, file.name))).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return bytes;
}
export async function sourceDiskBoundary(
  output: string,
  rankPath: string,
  rankBytes: number,
  additionalDecoded: number,
) {
  let pendingRank = rankBytes;
  try {
    await stat(rankPath);
    pendingRank = 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    (await derivedBytes(output)) +
      (await derivedBytes(columnCacheDirectory())) +
      pendingRank +
      additionalDecoded >
    sourceCacheBudget
  )
    throw new LifecycleSourceBudgetError(
      "Projected lifecycle source cache exceeds512MiB before reader/cache write",
    );
}
export async function normalizedArtifact<T>(
  pointerPath: string,
  expectedHash?: string,
) {
  const pointerBytes = await readFile(pointerPath),
    pointer = JSON.parse(pointerBytes.toString()) as {
      path: string;
      sha256: string;
      bytes?: number;
    };
  if (
    !isAbsolute(pointer.path) ||
    !/^([a-f0-9]{64})$/.test(pointer.sha256) ||
    (expectedHash && pointer.sha256 !== expectedHash)
  )
    throw new Error("Frozen normalized capture pointer identity mismatch");
  const bytes = await readFile(pointer.path);
  if (
    bytesHash(bytes) !== pointer.sha256 ||
    (pointer.bytes !== undefined && pointer.bytes !== bytes.length)
  )
    throw new Error("Frozen normalized capture bytes/hash mismatch");
  memoryBoundary(bytes.readUInt32LE(bytes.length - 4) * 3 + bytes.length);
  const plain = gunzipSync(bytes, { maxOutputLength: 256 * 1024 ** 2 });
  return {
    value: JSON.parse(plain.toString()) as T,
    identity: {
      pointerPath: resolve(pointerPath),
      pointerHash: bytesHash(pointerBytes),
      path: resolve(pointer.path),
      hash: pointer.sha256,
      hashMeaning:
        "hash = dereferenced compressed artifact bytes SHA256; pointerHash = pointer file bytes SHA256",
      decodedContentHash: bytesHash(plain),
      bytes: bytes.length,
      plainBytes: plain.length,
    },
  };
}
export function orderedBars(bars: readonly Bar[], source: string) {
  let previous = "";
  for (const bar of bars) {
    if (
      !Number.isFinite(Date.parse(bar.date)) ||
      bar.date <= previous ||
      ![bar.open, bar.high, bar.low, bar.close].every(
        (v) => Number.isFinite(v) && v > 0,
      ) ||
      bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close) ||
      !Number.isFinite(bar.volume) ||
      bar.volume < 0
    )
      throw new Error(`Invalid/duplicate/out-of-order source bars: ${source}`);
    previous = bar.date;
  }
}
export async function immutableFile(path: string, bytes: Uint8Array | string) {
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await hashFile(path)) !== bytesHash(bytes))
      throw new Error("Frozen source sidecar/cache identity conflict");
  }
}
