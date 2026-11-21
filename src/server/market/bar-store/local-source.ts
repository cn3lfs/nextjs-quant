import { statSync, readFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import {
  readSnapshot,
  readWindowSnapshot,
  resolveTdxRoot,
  isAStock,
  isLocalFund,
  isLocalMarketIndex,
} from "tstdx/local";
import type { Snapshot } from "~/lib/domain";
import { commonIndexName } from "~/lib/market/market-indices";
import { exchangeNames } from "../exchange-security-names";
import {
  CacheBusyError,
  readColumnCache,
  writeColumnCache,
  columnCacheDirectory,
} from "./column-cache";
import { readFullDaySnapshot, fullDayRepairsSameDate } from "./package-import";
import { contentDigest } from "./content-digest";

export async function sourceFingerprint(path: string, content = false) {
  const s = statSync(path, { bigint: true });
  const identity = `${path}:${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.birthtimeNs}`;
  if (!content) return identity;
  if (!s.isFile() || s.size > 64n * 1024n * 1024n)
    throw new Error("本地行情源不是常规文件或容量超限");
  // Windows can retain identical file timestamps across successive writes.
  // Content identity is necessary for local histories, including warm reads.
  const body = readFileSync(path);
  const after = statSync(path, { bigint: true });
  if (
    s.size !== BigInt(body.length) ||
    s.ino !== after.ino ||
    s.mtimeNs !== after.mtimeNs ||
    s.ctimeNs !== after.ctimeNs
  )
    throw new Error("读取期间行情源文件变化");
  return `${identity}:${contentDigest(identity, body)}`;
}
async function fullLocalBars(
  directory: string,
  symbol: string,
  period: "day" | "5m",
  chartFunds: boolean,
): Promise<Snapshot> {
  const path = join(
    directory,
    "vipdoc",
    symbol.slice(0, 2),
    period === "day" ? "lday" : "fzline",
    `${symbol}.${period === "day" ? "day" : "lc5"}`,
  );
  const fingerprint = `tdx-parser-1:${await sourceFingerprint(path, true)}`;
  const key = `tdx:${directory}:${symbol}:${period}`;
  let cached;
  try {
    cached = readColumnCache(key);
  } catch {
    /* Recreate a corrupt derived cache, never alter the source. */
  }
  // The full fingerprint above identifies the committed source generation.
  if (cached?.bars.length && cached.metadata.fingerprint === fingerprint)
    return { ...cached.metadata.source, bars: cached.bars } as Snapshot;

  const snapshot = await readSnapshot(directory, symbol, period, {
    chartFunds,
  });
  if (`tdx-parser-1:${await sourceFingerprint(path, true)}` !== fingerprint)
    throw new Error("读取期间行情源文件变化");
  const { bars, ...metadata } = snapshot;
  try {
    writeColumnCache(key, bars, fingerprint, metadata);
  } catch (error) {
    if (!(error instanceof CacheBusyError)) throw error;
  }
  if (`tdx-parser-1:${await sourceFingerprint(path, true)}` !== fingerprint)
    throw new Error("读取期间行情源文件变化");
  return snapshot;
}

/** Choose between the local source generation and any imported daily package. */
export async function localBars(
  root: string,
  symbol: string,
  period: "day" | "5m",
  chartFunds = false,
  window?: { from: string; to?: string },
): Promise<Snapshot> {
  if (
    !isAStock(symbol) &&
    !isLocalMarketIndex(symbol) &&
    !(chartFunds && isLocalFund(symbol))
  )
    throw new Error("仅支持A股与沪深指数行情；场内基金须使用图表读取入口");
  if (root.trim()) {
    const cacheRelative = relative(
      resolveTdxRoot(root),
      columnCacheDirectory(),
    );
    if (
      !cacheRelative ||
      (!cacheRelative.startsWith("..") && !isAbsolute(cacheRelative))
    )
      throw new Error("BarStore 缓存目录不能位于通达信只读目录内");
  }
  let local: { snapshot: Snapshot; lastDate: string } | undefined;
  let failure: unknown;
  try {
    const directory = resolveTdxRoot(root);
    if (window) {
      const {
        sourceLastDate: lastDate,
        regularMinuteSession,
        ...snapshot
      } = await readWindowSnapshot(directory, symbol, period, {
        ...window,
        chartFunds,
      });
      if (regularMinuteSession) local = { snapshot, lastDate };
    }
    if (!local) {
      const snapshot = await fullLocalBars(
        directory,
        symbol,
        period,
        chartFunds,
      );
      local = { snapshot, lastDate: snapshot.bars.at(-1)!.date };
    }
    local.snapshot.name ??=
      exchangeNames.get(symbol)?.name ?? commonIndexName(symbol);
  } catch (error) {
    local = undefined;
    failure = error;
  }
  if (period === "day") {
    const imported = readFullDaySnapshot(symbol);
    const repair =
      imported &&
      local &&
      imported.bars.at(-1)!.date === local.lastDate &&
      fullDayRepairsSameDate(symbol);
    if (
      imported &&
      (!local || imported.bars.at(-1)!.date > local.lastDate || repair)
    )
      return {
        ...imported,
        dataRoot: root.trim() ? resolveTdxRoot(root) : "",
        name: local?.snapshot.name ?? imported.name,
        sourceNote: repair
          ? "已明确选择完整包修复同日期日线"
          : local
            ? "完整包缓存日期晚于本地日线"
            : "本地日线不可用，使用已导入完整包缓存",
      };
  }
  if (local) return local.snapshot;
  throw failure ?? new Error("本地行情不可用");
}
