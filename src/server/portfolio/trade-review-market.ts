import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Stats } from "node:fs";
import type { Snapshot } from "~/lib/domain";
import { classifyCode } from "~/lib/research/evidence/delivery-import";
import { tradeReviewDayVwap } from "~/lib/portfolio/trade-review-vwap";
import { isMarketIndex } from "~/lib/market/market-indices";
import { parseBars, readSnapshot } from "../data-sources/tdx/tdx";

export type PriceScaleEvidence = {
  divisor: number;
  priceUnit: string;
  checkedBars: number;
  maxDeviation: number | null;
  /** Typical-bar deviation; this is what decides `trusted`. */
  medianDeviation: number | null;
  worstSample: { date: string; close: number; average: number } | null;
  trusted: boolean;
  reason: string | null;
};
export type TradeReviewSnapshot = Snapshot & {
  priceScale?: PriceScaleEvidence;
};

function validatePrices(
  snapshot: Snapshot,
  divisor: number,
  priceUnit: string,
): TradeReviewSnapshot {
  let maxDeviation = 0;
  let checkedBars = 0;
  let worstSample: PriceScaleEvidence["worstSample"] = null;
  const deviations: number[] = [];
  // Check every nonzero-volume record, so a historical scale change cannot hide
  // behind a few recent samples. Zero volume provides no independent evidence.
  for (const bar of snapshot.bars) {
    if (bar.volume <= 0) continue;
    checkedBars++;
    const average = tradeReviewDayVwap(bar).value ?? 0;
    const deviation =
      average > 0
        ? Math.max(bar.close / average, average / bar.close)
        : Infinity;
    deviations.push(deviation);
    if (deviation > maxDeviation) {
      maxDeviation = deviation;
      worstSample = { date: bar.date, close: bar.close, average };
    }
  }
  // The divisor is a file-wide property, so the typical bar decides whether it
  // is right. Judging by the single worst bar lets one bad historical record
  // (ex-rights day, a zeroed turnover field) discard an entire security — that
  // discarded 29 securities including ordinary stocks. The worst deviation is
  // still reported so a genuine mid-file scale change stays visible.
  const sorted = deviations
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const median = sorted.length
    ? sorted[Math.floor(sorted.length / 2)]!
    : Infinity;
  const trusted = checkedBars > 0 && median <= 5;
  return {
    ...snapshot,
    priceScale: {
      divisor,
      priceUnit,
      checkedBars,
      maxDeviation:
        Number.isFinite(maxDeviation) && checkedBars > 0 ? maxDeviation : null,
      medianDeviation:
        Number.isFinite(median) && checkedBars > 0 ? median : null,
      worstSample,
      trusted,
      reason: trusted
        ? null
        : "价格口径不可信：无有效均价依据，或多数 bar 的收盘价与成交额÷成交量偏离超过 5 倍",
    },
  };
}

const signature = (s: Stats) =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.birthtimeMs}`;

/** Account review only: keep the screening reader's stock/index gate intact. */
export async function readTradeReviewSnapshot(
  root: string,
  symbol: string,
  period: "day" = "day",
): Promise<TradeReviewSnapshot> {
  // Legacy imports may lack a market for newer fund/bond prefixes.
  if (!/^(?:(?:sh|sz|bj))?\d{6}$/.test(symbol)) throw new Error("证券代码非法");
  const classification = classifyCode(symbol);
  if (/^\d{6}$/.test(symbol) && classification.market)
    symbol = `${classification.market}${symbol}`;
  if (classification.instrument === "reverseRepo")
    throw new Error("逆回购排除市值：报价为年化利率，资金占用已体现在现金流中");
  // Index points are not tradable prices; turnover/volume cannot validate them.
  if (isMarketIndex(symbol)) return readSnapshot(root, symbol, period);
  if (
    classification.instrument !== "fund" &&
    classification.instrument !== "convertible"
  )
    return validatePrices(
      await readSnapshot(root, symbol, period),
      100,
      "元/股",
    );
  if (!symbol.startsWith(classification.market!))
    throw new Error("证券市场与品种不一致");
  const priceUnit =
    classification.instrument === "fund"
      ? "元/份"
      : classification.market === "sh"
        ? "元/手（10张）"
        : "元/张";
  const file = join(
    resolve(root),
    "vipdoc",
    symbol.slice(0, 2),
    "lday",
    `${symbol}.day`,
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
        signature(before) === signature(after) &&
        signature(after) === signature(current);
    } finally {
      await handle.close();
    }
    if (!stable) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    const bars = parseBars(buffer, "day").map((bar) => ({
      ...bar,
      open: bar.open / 10,
      high: bar.high / 10,
      low: bar.low / 10,
      close: bar.close / 10,
    }));
    if (!bars.length) throw new Error("行情文件为空");
    const hash = createHash("sha256").update(buffer).digest("hex");
    return validatePrices(
      {
        id: `trade-review-${symbol}-${hash.slice(0, 16)}`,
        symbol,
        period: "day",
        source: "tdx-local",
        dataRoot: resolve(root),
        adjustment: "none",
        createdAt: Date.now(),
        bars,
        hash,
      },
      1000,
      priceUnit,
    );
  }
  throw new Error("通达信正在更新文件，请稍后重试");
}
