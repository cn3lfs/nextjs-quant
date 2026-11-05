import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  mergeFiveMinuteBars,
  parseFiveMinuteCsv,
  type ImportVolumeUnit,
} from "./five-minute-csv";

export type FiveMinutePreviewItem = {
  symbol: string;
  source: string;
  target: string;
  sourceHash?: string;
  targetHash?: string;
  targetMissing?: boolean;
  indexVolumeOverflow?: boolean;
  overflowTimes?: string[];
  mergedHash?: string;
  added?: number;
  identical?: number;
  conflicts?: number;
  error?: string;
};

const hash = (buffer: Buffer) =>
  createHash("sha256").update(buffer).digest("hex");

/** One directory at a time; never opens a target for writing. */
export async function previewFiveMinuteDirectory(
  sourceDirectory: string,
  tdxRoot: string,
  unit: ImportVolumeUnit,
  onItem?: (
    item: FiveMinutePreviewItem,
    processed: number,
    total: number,
  ) => void,
  signal?: AbortSignal,
): Promise<FiveMinutePreviewItem[]> {
  const sourceRoot = resolve(sourceDirectory);
  const entries = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && /^(sh|sz)\d{6}\.csv$/i.test(entry.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!entries.length)
    throw new Error("目录中没有 SH 或 SZ 开头的六位代码 CSV 文件");
  const items: FiveMinutePreviewItem[] = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    const symbol = entry.name.slice(0, 8).toLowerCase();
    const source = join(sourceRoot, entry.name);
    const target = join(
      resolve(tdxRoot),
      "vipdoc",
      symbol.slice(0, 2),
      "fzline",
      `${symbol}.lc5`,
    );
    const item: FiveMinutePreviewItem = { symbol, source, target };
    try {
      const csv = await readFile(source);
      const bars = parseFiveMinuteCsv(csv.toString("utf8"), unit);
      // Missing targets are reported, not silently created: file naming and
      // securities are validated against the existing installation.
      const existing = await readFile(target);
      const merged = mergeFiveMinuteBars(existing, bars);
      Object.assign(item, {
        sourceHash: hash(csv),
        targetHash: hash(existing),
        mergedHash: hash(merged.data),
        added: merged.added,
        identical: merged.identical,
        conflicts: merged.conflicts,
      });
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error);
    }
    items.push(item);
    onItem?.(item, items.length, entries.length);
  }
  return items;
}
