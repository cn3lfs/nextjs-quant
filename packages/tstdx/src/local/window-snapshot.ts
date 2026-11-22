import { open, stat, type FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { resolveTdxRoot } from "./root.js";
import {
  inWindow,
  isLocalFund,
  isRegularMinuteBar,
  parseBarPage,
  quoteFile,
  quoteSnapshot,
  readSnapshot,
  repairNote,
  type PageRange,
  type WindowBounds,
} from "./quotes.js";
import {
  validateLocalDate,
  type TdxLocalBar as Bar,
  type TdxLocalPeriod as Period,
  type TdxLocalSnapshot as Snapshot,
} from "./types.js";

const windowPageBytes = 128 * 1024;
const maxWindowSourceBytes = 64n * 1024n * 1024n;
type WindowPage = Pick<PageRange, "previous" | "last" | "first"> & {
  ordered: boolean;
};
type WindowIndex = {
  identity: string;
  hash: string;
  pages: WindowPage[];
  referenceYear: number;
  sourceLastDate: string;
  regularMinuteSession: boolean;
  note: string;
};
const windowIndexes = new Map<string, WindowIndex>();
let indexedPages = 0;

function rememberWindowIndex(file: string, index: WindowIndex) {
  indexedPages -= windowIndexes.get(file)?.pages.length ?? 0;
  windowIndexes.delete(file);
  windowIndexes.set(file, index);
  indexedPages += index.pages.length;
  while (windowIndexes.size > 8192 || indexedPages > 32768) {
    const oldest = windowIndexes.keys().next().value!;
    indexedPages -= windowIndexes.get(oldest)!.pages.length;
    windowIndexes.delete(oldest);
  }
}

const windowIdentity = (info: BigIntStats, year: number) =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.birthtimeNs}:${year}`;

async function readPage(handle: FileHandle, buffer: Buffer, position: number) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (!bytesRead) return false;
    offset += bytesRead;
  }
  return true;
}

function windowPageSlice(
  page: Buffer,
  period: Period,
  referenceYear: number,
  bounds: WindowBounds,
) {
  function search(day: number) {
    let lo = 0;
    let hi = page.length / 32;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const at = mid * 32;
      let date: number;
      if (period === "day") {
        date = page.readUInt32LE(at);
      } else {
        const packed = page.readUInt16LE(at);
        let year = (packed >> 11) + 2004;
        while (year > referenceYear + 1) year -= 32;
        date = year * 10000 + (packed & 2047);
      }
      if (date < day) lo = mid + 1;
      else hi = mid;
    }
    return lo * 32;
  }
  const from = search(Number(bounds.from.replaceAll("-", "")));
  const to = bounds.to
    ? search(Number(bounds.to.replaceAll("-", "")) + 1)
    : page.length;
  return page.subarray(from, to);
}

export type TdxLocalWindowSnapshot = Snapshot & {
  /** Last accepted record in the entire source, even for an empty window. */
  sourceLastDate: string;
  regularMinuteSession: boolean;
};

/** Inclusive exchange dates. The hash identifies the complete source, while
 * the window id also includes its bounds. Out-of-coverage dates return no bars. */
export async function readWindowSnapshot(
  root: string,
  symbol: string,
  period: Period,
  options: WindowBounds & { chartFunds?: boolean },
): Promise<TdxLocalWindowSnapshot> {
  const { from, to } = options;
  validateLocalDate(from);
  if (to !== undefined) validateLocalDate(to);
  if (to && from > to) throw new Error("行情区间非法");
  if (period !== "day" && period !== "5m") throw new Error("行情周期非法");

  const directory = resolveTdxRoot(root);
  const file = quoteFile(directory, symbol, period, options.chartFunds);
  const decimals = isLocalFund(symbol) ? 3 : 2;
  const referenceYear = new Date().getFullYear();
  for (let attempt = 0; attempt < 3; attempt++) {
    const generation = await readWindowGeneration(
      file,
      period,
      options,
      decimals,
      referenceYear,
      attempt === 0,
    );
    if (!generation) continue;
    const { hash, index, bars } = generation;
    let result: TdxLocalWindowSnapshot;
    if (index) {
      if (!index.sourceLastDate) throw new Error("行情文件为空");
      rememberWindowIndex(file, index);
      result = {
        ...(await quoteSnapshot(
          directory,
          symbol,
          period,
          bars,
          hash,
          index.note,
        )),
        sourceLastDate: index.sourceLastDate,
        regularMinuteSession: index.regularMinuteSession,
      };
    } else {
      // A packed-minute year wrap or regression needs the original backwards
      // year decoder over the complete history.
      const full = await readSnapshot(directory, symbol, period, options);
      if (full.hash !== hash) continue;
      result = {
        ...full,
        bars: full.bars.filter((bar) => inWindow(bar.date, options)),
        sourceLastDate: full.bars.at(-1)!.date,
        regularMinuteSession: full.bars.every((bar) =>
          isRegularMinuteBar(bar.date),
        ),
      };
    }
    result.id = `snapshot-window-${symbol}-${period}-${from}-${to ?? "end"}-${hash.slice(0, 16)}`;
    return result;
  }
  throw new Error("通达信正在更新文件，请稍后重试");
}

async function readWindowGeneration(
  file: string,
  period: Period,
  bounds: WindowBounds,
  decimals: number,
  referenceYear: number,
  useIndex: boolean,
) {
  const handle = await open(file, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > maxWindowSourceBytes)
      throw new Error("本地行情源不是常规文件或容量超限");
    if (before.size % 32n !== 0n)
      throw new Error("行情文件不完整：记录长度不是 32 字节的整数倍");
    if (!before.size) throw new Error("行情文件为空");
    const size = Number(before.size);
    const identity = windowIdentity(before, referenceYear);
    const candidate = useIndex ? windowIndexes.get(file) : undefined;
    const cached = candidate?.identity === identity ? candidate : undefined;
    let pageYear = cached?.referenceYear ?? referenceYear;
    let newestPackedYear = -1;
    const buffer = Buffer.allocUnsafe(Math.min(windowPageBytes, size));
    if (!cached && period === "5m") {
      if (!(await readPage(handle, buffer.subarray(0, 2), size - 32)))
        return null;
      newestPackedYear = buffer.readUInt16LE(0) >> 11;
      let newestYear = newestPackedYear + 2004;
      while (newestYear > referenceYear + 1) newestYear -= 32;
      pageYear = newestYear - 1;
    }
    const digest = createHash("sha256");
    const repairs = { fixed: 0, dropped: 0 };
    const pages: WindowPage[] = [];
    const bars: Bar[] = [];
    let lastPackedYear = -1;
    let wrapped = false;
    let sourceLastDate = "";
    let regularMinuteSession = true;
    for (let offset = 0; offset < size; offset += windowPageBytes) {
      const page = buffer.subarray(0, Math.min(windowPageBytes, size - offset));
      if (!(await readPage(handle, page, offset))) return null;
      // Windows can preserve all timestamps on a same-size rewrite. Verify
      // every byte, including the prefix/suffix outside the selected records.
      digest.update(page);
      if (wrapped) continue;
      if (!cached && period === "5m") {
        for (let at = 0; at < page.length; at += 32) {
          const packedYear = page.readUInt16LE(at) >> 11;
          if (packedYear < lastPackedYear) {
            wrapped = true;
            break;
          }
          lastPackedYear = packedYear;
        }
        if (wrapped) continue;
      }
      const indexed = cached?.pages[offset / windowPageBytes];
      if (
        cached &&
        (!indexed?.last ||
          indexed.last < bounds.from ||
          (bounds.to && indexed.first!.slice(0, 10) > bounds.to))
      )
        continue;
      const range: PageRange = {
        ...bounds,
        previous: indexed?.previous ?? sourceLastDate,
        regularMinuteSession,
      };
      const droppedBefore = repairs.dropped;
      const selected = indexed?.ordered
        ? windowPageSlice(page, period, pageYear, bounds)
        : page;
      bars.push(
        ...parseBarPage(selected, period, pageYear, decimals, repairs, range),
      );
      if (!cached) {
        // The preceding accepted date preserves duplicate/out-of-order handling
        // across page boundaries, including pages with zero valid records.
        pages.push({
          previous: range.previous,
          first: range.first,
          last: range.last,
          ordered: repairs.dropped === droppedBefore,
        });
        sourceLastDate = range.last ?? sourceLastDate;
        regularMinuteSession = range.regularMinuteSession;
      }
    }
    const hash = digest.digest("hex");
    if (cached) {
      if (cached.hash !== hash) return null;
    } else if (!wrapped) {
      if (period === "5m" && lastPackedYear !== newestPackedYear) return null;
      // A new index has no earlier committed content hash to compare against.
      // Recheck its full generation before publishing it.
      const verified = createHash("sha256");
      for (let offset = 0; offset < size; offset += windowPageBytes) {
        const page = buffer.subarray(
          0,
          Math.min(windowPageBytes, size - offset),
        );
        if (!(await readPage(handle, page, offset))) return null;
        verified.update(page);
      }
      if (verified.digest("hex") !== hash) return null;
    }
    if (
      windowIdentity(await handle.stat({ bigint: true }), referenceYear) !==
        identity ||
      windowIdentity(await stat(file, { bigint: true }), referenceYear) !==
        identity
    )
      return null;
    const index = wrapped
      ? null
      : (cached ?? {
          identity,
          hash,
          pages,
          referenceYear: pageYear,
          sourceLastDate,
          regularMinuteSession,
          note: repairNote(repairs),
        });
    return { hash, index, bars };
  } finally {
    await handle.close();
  }
}
