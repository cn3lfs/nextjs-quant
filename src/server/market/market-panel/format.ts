import { createHash } from "node:crypto";
import { endianness } from "node:os";
import { readSync } from "node:fs";
import { z } from "zod";
import type { TdxXdxr } from "tstdx/wire";

export const chunkSize = 32;
export const recordBytes = 52;
export const missingAtoms = -2147483648;
export const panelFlags = {
  valid: 1,
  etf: 2,
  zeroVolume: 4,
  gp29: 8,
  resumed: 16,
  st: 32,
  stKnown: 64,
  onePriceLimitUp: 128,
  onePriceLimitDown: 256,
} as const;
export const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export const idSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const daySchema = z
  .string()
  .regex(/^\d{4}-\d\d-\d\d$/)
  .refine((s) => {
    const n = Date.parse(s);
    return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === s;
  });
const metaSchema = z.object({
  symbol: z.string().regex(/^(sh|sz|bj)\d{6}$/),
  kind: z.enum(["stock", "etf", "index"]),
  priceScale: z.union([z.literal(100), z.literal(1000)]),
  industryCode: z.number().int().nonnegative().max(65535),
  firstDate: daySchema,
  lastDate: daySchema,
  eventOffset: z.number().int().nonnegative(),
  eventBytes: z.number().int().positive(),
  eventHash: idSchema,
});
export const manifestSchema = z.object({
  magic: z.literal("MKTPAN01"),
  formatVersion: z.literal(1),
  chunkSize: z.literal(32),
  recordBytes: z.literal(52),
  builtAt: z.string().datetime(),
  root: z.string(),
  sourceFingerprint: idSchema,
  sources: z.record(idSchema),
  dates: z.array(daySchema).min(1),
  symbols: z.array(metaSchema).min(1),
  chunks: z.array(idSchema).min(1),
  tileWidth: z.number().int().min(2).max(64).multipleOf(2),
  tileHashes: z.array(z.array(idSchema).min(1)),
  industries: z.array(
    z.object({
      code: z.number().int().positive(),
      name: z.string(),
      observedFrom: daySchema,
    }),
  ),
  calendar: z.literal("union-of-accepted-local-day-dates"),
  marketCapUnit: z.literal("CNY"),
  industryBasis: z.literal("observed-local-SW-membership"),
  financialVintage: z.literal("current-local-revision"),
  gbbqIssues: z.number().int().nonnegative(),
  duplicateReportGroups: z.number().int().nonnegative(),
});
type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
export type MarketPanelManifest = DeepReadonly<
  z.infer<typeof manifestSchema> & {
    snapshotId: string;
  }
>;
export type MarketPanelSymbol = z.infer<typeof metaSchema>;
export type PanelEvent =
  | { kind: "gbbq"; availableFrom: string; raw: TdxXdxr }
  | {
      kind: "gp29";
      availableFrom: string;
      suspendedSessions: number;
      renameCode: number;
    }
  | {
      kind: "report";
      availableFrom: string;
      reportDate: string;
      announcementDate: string;
      sourceFile: string;
      recordOffset: number;
      raw: {
        assets: number | null;
        revenue: number | null;
        netProfit: number | null;
        equity: number | null;
      };
    };

export const headerBytes = 32;
export function fileHeader(dates: number, symbols: number, tileWidth: number) {
  const b = Buffer.alloc(headerBytes);
  b.write("MKTPAN01");
  [1, chunkSize, recordBytes, dates, symbols, tileWidth].forEach((v, i) =>
    b.writeUInt32LE(v, 8 + 4 * i),
  );
  return b;
}
export const chunkBytes = (width: number) =>
  chunkSize * width * recordBytes + 4 * width;
export function readAt(fd: number, length: number, position: number) {
  const result = Buffer.allocUnsafeSlow(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, result, done, length - done, position + done);
    if (!n) throw new Error("面板文件截断");
    done += n;
  }
  return result;
}
// All columns start on an eight-byte boundary because every chunk has 32 rows,
// including the final padded chunk. The bitmap follows all 52 bytes/cell.
export function columns(body: Buffer, width: number) {
  if (endianness() !== "LE" || body.length !== chunkBytes(width))
    throw new Error("面板字节序或块长度非法");
  const n = width * chunkSize;
  const at = (offset: number) => body.byteOffset + n * offset;
  return {
    openAtoms: new Int32Array(body.buffer, at(0), n),
    highAtoms: new Int32Array(body.buffer, at(4), n),
    lowAtoms: new Int32Array(body.buffer, at(8), n),
    closeAtoms: new Int32Array(body.buffer, at(12), n),
    volume: new Float64Array(body.buffer, at(16), n),
    amount: new Float64Array(body.buffer, at(24), n),
    adjFactor: new Float32Array(body.buffer, at(32), n),
    turnover: new Float32Array(body.buffer, at(36), n),
    marketCap: new Float32Array(body.buffer, at(40), n),
    industryCode: new Uint16Array(body.buffer, at(44), n),
    statusFlags: new Uint16Array(body.buffer, at(46), n),
    prevCloseAtoms: new Int32Array(body.buffer, at(48), n),
    validBitmap: new Uint8Array(body.buffer, at(52), n / 8),
  };
}
export type PanelChunk = ReturnType<typeof columns>;
export const fields = [
  "openAtoms",
  "highAtoms",
  "lowAtoms",
  "closeAtoms",
  "volume",
  "amount",
  "adjFactor",
  "turnover",
  "marketCap",
  "industryCode",
  "statusFlags",
  "prevCloseAtoms",
] as const;
export type PanelField = (typeof fields)[number];
export function emptyChunk(width: number) {
  const body = Buffer.alloc(chunkBytes(width));
  const c = columns(body, width);
  for (const field of fields) {
    if (field.endsWith("Atoms")) c[field].fill(missingAtoms);
    else if (
      c[field] instanceof Float32Array ||
      c[field] instanceof Float64Array
    )
      c[field].fill(NaN);
  }
  return { body, c };
}
export function hasBit(bits: Uint8Array, i: number) {
  return (bits[i >>> 3]! & (1 << (i % 8))) !== 0;
}
export function setBit(bits: Uint8Array, i: number) {
  const b = i >>> 3;
  bits[b] = bits[b]! | (1 << (i % 8));
}
