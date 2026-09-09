import type { Snapshot, Evidence, Bar } from "~/lib/domain";
import { parseBars } from "./tdx";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { evidenceEnvelope } from "./evidence";

export function relativePerformance(
  stock: Bar[],
  index: Bar[],
  cutoff: string,
) {
  const window = index.filter((b) => b.date <= cutoff).slice(-61);
  const start = window[0]?.date ?? null;
  const aligned =
    window.length === 61 &&
    window.at(-1)?.date === cutoff &&
    window.every((bar, i) => i === 0 || bar.date > window[i - 1]!.date);
  const stockWindow = start
    ? stock.filter((b) => b.date >= start && b.date <= cutoff)
    : [];
  const comparable =
    aligned &&
    stockWindow.length === window.length &&
    stockWindow.every((b, i) => b.date === window[i]!.date);
  const stockReturn = comparable
    ? (stockWindow.at(-1)!.close / stockWindow[0]!.close - 1) * 100
    : null;
  const indexReturn = comparable
    ? (window.at(-1)!.close / window[0]!.close - 1) * 100
    : null;
  return {
    version: "relative-performance-1",
    start,
    end: cutoff,
    intervals: 60,
    comparable,
    stockReturn,
    indexReturn,
    excessPercentagePoints:
      stockReturn !== null && indexReturn !== null
        ? stockReturn - indexReturn
        : null,
    marketPercentile: null,
    warnings: [
      "按沪深300的61个同日期观测计算60区间收益；缺日或日期不一致时不作比较。",
      "超额收益单位为百分点，不等于全市场RS百分位；不复权个股收益可能受除权影响。",
    ],
  };
}

export function indexFacts(bars: Bar[], cutoff: string) {
  const available = bars.filter((b) => b.date <= cutoff);
  const last = available.at(-1);
  const mean = (n: number) =>
    available.length < n
      ? null
      : available.slice(-n).reduce((sum, b) => sum + b.close, 0) / n;
  const ma20 = mean(20),
    ma60 = mean(60),
    ma120 = mean(120),
    ma250 = mean(250);
  const aligned = last?.date === cutoff;
  return {
    version: "index-context-1",
    symbol: "sh000300",
    cutoff,
    asOf: last?.date ?? null,
    aligned,
    close: last?.close ?? null,
    ma20,
    ma60,
    ma120,
    ma250,
    change60:
      available.length >= 61
        ? (last!.close / available.at(-61)!.close - 1) * 100
        : null,
    aboveMa120: aligned && ma120 !== null ? last!.close > ma120 : null,
    belowMa250: aligned && ma250 !== null ? last!.close < ma250 : null,
    warnings: [
      "沪深300日线背景，非行业背景或全市场相对强度排名。",
      "指数仅截到个股已完成日线时点；缺失对齐时不判市场通过，资料缺口及历史修订尚未核验。",
    ],
  };
}
export async function localIndexEvidence(
  source: Snapshot,
  root: string,
): Promise<Evidence | null> {
  if (source.period !== "day" || !source.bars?.length) return null;
  const cutoff = source.bars.at(-1)!.date;
  try {
    const bytes = await readFile(
      join(root, "vipdoc", "sh", "lday", "sh000300.day"),
    );
    const bars = parseBars(bytes, "day")
      .filter((b) => b.date <= cutoff)
      .slice(-300);
    const index = {
      bars,
      createdAt: Date.now(),
      hash: createHash("sha256").update(JSON.stringify(bars)).digest("hex"),
    };
    const payload = {
      ...indexFacts(index.bars, cutoff),
      snapshotHash: index.hash,
      relativePerformance: {
        symbol: source.symbol,
        stockSnapshotHash: source.hash,
        ...relativePerformance(source.bars, index.bars, cutoff),
      },
    };
    const envelope = evidenceEnvelope(payload, {
      source: "tdx-local/sh000300",
      symbol: "sh000300",
      type: "bars",
      asOf: payload.asOf,
      publishedAt: null,
      fetchedAt: index.createdAt,
      currency: null,
      unit: { price: "点", change60: "%" },
      adjustment: "not-applicable",
      reportPeriod: null,
      quality: "partial",
      warnings: payload.warnings,
    });
    return {
      id: `index-${envelope.payloadHash.slice(0, 16)}`,
      source: "本地通达信 / 沪深300日线背景",
      asOf: payload.asOf ?? "未知",
      text: JSON.stringify(payload),
      envelope,
    };
  } catch {
    return {
      id: `missing-index-${cutoff}`,
      source: "本地指数可用性检查",
      asOf: cutoff,
      text: "沪深300本地日线不可用；不得推断大盘趋势或相对强度。",
    };
  }
}
