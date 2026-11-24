import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as yieldToReaders } from "node:timers/promises";
import {
  chunkBytes,
  chunkSize,
  columns,
  daySchema,
  fields,
  fileHeader,
  hasBit,
  hash,
  headerBytes,
  idSchema,
  manifestSchema,
  readAt,
  type MarketPanelManifest,
  type PanelChunk,
  type PanelEvent,
} from "./format";
import { rejectLink } from "./paths";

function freezeTree<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    for (const child of Object.values(o)) freezeTree(child);
    Object.freeze(o);
  }
  return o;
}
function requireIndex(map: ReadonlyMap<string, number>, key: string) {
  const i = map.get(key);
  if (i === undefined) throw new Error("快照没有该日期或证券 " + key);
  return i;
}
type Values = Int32Array | Uint16Array | Float32Array | Float64Array;
function allocateSlice(c: PanelChunk, n: number) {
  const values = Object.fromEntries(
    fields.map((k) => [
      k,
      new (c[k].constructor as new (n: number) => Values)(n),
    ]),
  ) as Omit<PanelChunk, "validBitmap">;
  return { ...values, valid: new Uint8Array(n) };
}
export type MarketPanelSlice = ReturnType<typeof allocateSlice>;
function copySlice(
  c: PanelChunk,
  at: number,
  n: number,
  stride: number,
  out: MarketPanelSlice,
  offset: number,
) {
  for (const k of fields) {
    if (stride === 1) out[k].set(c[k].subarray(at, at + n), offset);
    else
      for (let i = 0; i < n; i++) out[k][offset + i] = c[k][at + i * stride]!;
  }
  for (let i = 0; i < n; i++)
    out.valid[offset + i] = Number(hasBit(c.validBitmap, at + i * stride));
}
export class MarketPanelHandle {
  readonly manifest: MarketPanelManifest;
  readonly #dates: Map<string, number>;
  readonly #symbols: Map<string, number>;
  readonly #panel: number;
  readonly #events: number;
  #closed = false;
  #chunk?: { index: number; tiles: PanelChunk[] };
  #factor?: { key: string; result: Float32Array };
  constructor(directory: string, snapshotId: string) {
    idSchema.parse(snapshotId);
    rejectLink(directory);
    for (const f of ["manifest.json", "panel.bin", "events.jsonl"])
      rejectLink(join(directory, f));
    const { snapshotId: stored, ...payload } = JSON.parse(
      readFileSync(join(directory, "manifest.json"), "utf8"),
    );
    if (stored !== snapshotId || hash(JSON.stringify(payload)) !== snapshotId)
      throw new Error("面板 manifest 校验失败");
    this.manifest = freezeTree({
      ...manifestSchema.parse(payload),
      snapshotId,
    });
    const { dates, symbols, chunks } = this.manifest;
    this.#dates = new Map(dates.map((d, i) => [d, i]));
    this.#symbols = new Map(symbols.map((s, i) => [s.symbol, i]));
    if (
      dates.some((d, i) => i > 0 && d <= dates[i - 1]!) ||
      symbols.some((s, i) => i > 0 && s.symbol <= symbols[i - 1]!.symbol) ||
      chunks.length !== Math.ceil(dates.length / chunkSize) ||
      this.manifest.tileHashes.length !== chunks.length ||
      this.manifest.tileHashes.some(
        (h) => h.length !== Math.ceil(symbols.length / this.manifest.tileWidth),
      )
    )
      throw new Error("面板索引非法");
    let offset = 0;
    for (const s of symbols) {
      if (
        s.eventOffset !== offset ||
        !this.#dates.has(s.firstDate) ||
        !this.#dates.has(s.lastDate) ||
        s.firstDate > s.lastDate
      )
        throw new Error("面板证券索引非法");
      offset += s.eventBytes;
    }
    this.#panel = openSync(join(directory, "panel.bin"), "r");
    try {
      if (
        fstatSync(this.#panel).size !==
          headerBytes + chunks.length * chunkBytes(symbols.length) ||
        !readAt(this.#panel, headerBytes, 0).equals(
          fileHeader(dates.length, symbols.length, this.manifest.tileWidth),
        )
      )
        throw new Error("面板数据头或长度非法");
      this.#events = openSync(join(directory, "events.jsonl"), "r");
      if (fstatSync(this.#events).size !== offset) {
        closeSync(this.#events);
        throw new Error("面板事件长度非法");
      }
    } catch (e) {
      closeSync(this.#panel);
      throw e;
    }
  }
  get snapshotId() {
    return this.manifest.snapshotId;
  }
  private assertOpen() {
    if (this.#closed) throw new Error("面板句柄已关闭");
  }
  private chunk(i: number) {
    this.assertOpen();
    if (this.#chunk?.index === i) return this.#chunk.tiles;
    const n = this.manifest.symbols.length,
      size = chunkBytes(n);
    const body = readAt(this.#panel, size, headerBytes + size * i);
    if (hash(body) !== this.manifest.chunks[i])
      throw new Error("面板行情块校验失败");
    const tiles: PanelChunk[] = [];
    for (let s = 0; s < n; s += this.manifest.tileWidth) {
      const w = Math.min(this.manifest.tileWidth, n - s);
      tiles.push(columns(body.subarray(chunkBytes(s), chunkBytes(s + w)), w));
    }
    this.#chunk = { index: i, tiles };
    return tiles;
  }
  private symbolTile(i: number, tile: number) {
    this.assertOpen();
    if (this.#chunk?.index === i) return this.#chunk.tiles[tile]!;
    const start = tile * this.manifest.tileWidth;
    const width = Math.min(this.manifest.tileWidth, this.#symbols.size - start);
    const b = readAt(
      this.#panel,
      chunkBytes(width),
      headerBytes + i * chunkBytes(this.#symbols.size) + chunkBytes(start),
    );
    if (hash(b) !== this.manifest.tileHashes[i]![tile])
      throw new Error("面板证券分片校验失败");
    return columns(b, width);
  }
  crossSection(date: string): MarketPanelSlice {
    const d = requireIndex(this.#dates, date),
      width = this.manifest.symbols.length;
    const tiles = this.chunk(d >>> 5);
    const row = allocateSlice(tiles[0]!, width);
    for (const [index, tile] of tiles.entries()) {
      const n = tile.volume.length / chunkSize;
      copySlice(tile, (d % 32) * n, n, 1, row, index * this.manifest.tileWidth);
    }
    return row;
  }
  *sliceDates(from: string, to: string) {
    const [start, end] = this.bounds(from, to);
    for (let d = start; d <= end; d++) {
      const date = this.manifest.dates[d]!;
      yield { date, ...this.crossSection(date) };
    }
  }
  private bounds(from: string, to: string) {
    const a = requireIndex(this.#dates, from),
      b = requireIndex(this.#dates, to);
    if (a > b) throw new Error("面板日期区间倒序");
    return [a, b] as const;
  }
  sliceSymbol(
    symbol: string,
    from = this.manifest.dates[0]!,
    to = this.manifest.dates.at(-1)!,
  ) {
    const [start, end] = this.bounds(from, to);
    const s = requireIndex(this.#symbols, symbol);
    const tile = Math.floor(s / this.manifest.tileWidth);
    const local = s % this.manifest.tileWidth;
    const count = end - start + 1;
    const first = this.symbolTile(start >>> 5, tile);
    const values = allocateSlice(first, count);
    const width = first.volume.length / chunkSize;
    for (let d = start; d <= end;) {
      const n = Math.min(end - d + 1, 32 - (d % 32));
      const c = d === start ? first : this.symbolTile(d >>> 5, tile);
      copySlice(c, (d % 32) * width + local, n, width, values, d - start);
      d += n;
    }
    return {
      ...values,
      dates: this.manifest.dates.slice(start, end + 1),
    };
  }
  events(symbol: string, asOf = this.manifest.dates.at(-1)!): PanelEvent[] {
    this.assertOpen();
    daySchema.parse(asOf);
    const s = this.manifest.symbols[requireIndex(this.#symbols, symbol)]!;
    const b = readAt(this.#events, s.eventBytes, s.eventOffset);
    if (hash(b) !== s.eventHash) throw new Error("面板事件校验失败");
    return (JSON.parse(b.toString("utf8")) as PanelEvent[]).filter(
      (e) => e.availableFrom <= asOf,
    );
  }
  /** Row-major [date][symbol]. Include the factor version/parameters in key.
   * One cached matrix per open handle; callers can mutate their own copy. */
  factor(
    key: string,
    compute: (date: string, row: MarketPanelSlice) => Float32Array,
  ) {
    this.assertOpen();
    if (!key.trim()) throw new Error("因子缓存标识为空");
    if (this.#factor?.key === key) return this.#factor.result.slice();
    const { dates, symbols } = this.manifest;
    const result = new Float32Array(dates.length * symbols.length);
    for (const [d, date] of dates.entries()) {
      const row = this.crossSection(date);
      const valid = row.valid.slice();
      const values = compute(date, row);
      if (!(values instanceof Float32Array) || values.length !== symbols.length)
        throw new Error("因子截面宽度错误");
      // Take validity from the immutable source rather than callback-owned data.
      for (let i = 0; i < symbols.length; i++)
        result[d * symbols.length + i] =
          valid[i] && Number.isFinite(values[i]) ? values[i]! : NaN;
    }
    this.#factor = { key, result };
    return result.slice();
  }
  /** Verify all payloads at publication or for an explicit offline audit. */
  async verify() {
    this.#chunk = undefined;
    for (let i = 0; i < this.manifest.chunks.length; i++) {
      await yieldToReaders();
      this.chunk(i);
    }
    for (const [i, s] of this.manifest.symbols.entries()) {
      if (i % 64 === 0) await yieldToReaders();
      this.events(s.symbol);
    }
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#chunk = undefined;
    this.#factor = undefined;
    try {
      closeSync(this.#panel);
    } finally {
      closeSync(this.#events);
    }
  }
  [Symbol.dispose]() {
    this.close();
  }
}
