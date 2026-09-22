import { createHash } from "node:crypto";
import type { Snapshot } from "~/lib/domain";
const validDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) &&
  new Date(date).toISOString().slice(0, 10) === date;

/** Comparative normalized price ratio, not RSI or a cross-sectional rank. */
export function wyckoffRelativeStrength(
  stock: Snapshot,
  benchmark: Snapshot,
  start: string,
  end: string,
) {
  if (!validDate(start) || !validDate(end) || start >= end)
    throw new Error("RS比较区间无效");
  for (const snapshot of [stock, benchmark]) {
    if (
      snapshot.period !== "day" ||
      snapshot.adjustment !== "none" ||
      !/^(sh|sz|bj)\d{6}$/.test(snapshot.symbol) ||
      (snapshot.historicalAsOf && snapshot.historicalAsOf < end)
    )
      throw new Error("RS需要相同时点口径的境内不复权日线");
    let previous = "";
    for (const bar of snapshot.bars) {
      if (
        !validDate(bar.date) ||
        bar.date <= previous ||
        !Number.isFinite(bar.close) ||
        bar.close <= 0
      )
        throw new Error("RS日期顺序或收盘价无效");
      previous = bar.date;
    }
  }
  if (stock.symbol === benchmark.symbol)
    throw new Error("RS基准不能是标的自身");
  const left = stock.bars.filter((b) => b.date >= start && b.date <= end);
  const right = benchmark.bars.filter((b) => b.date >= start && b.date <= end);
  const stockDates = new Set(left.map((b) => b.date)),
    benchmarkDates = new Set(right.map((b) => b.date));
  const missingStockDates = [...new Set([start, end, ...benchmarkDates])]
    .filter((date) => !stockDates.has(date))
    .sort();
  const missingBenchmarkDates = [...new Set([start, end, ...stockDates])]
    .filter((date) => !benchmarkDates.has(date))
    .sort();
  const aligned =
    left.length >= 2 &&
    !missingStockDates.length &&
    !missingBenchmarkDates.length;
  const rows = aligned
    ? left.map((bar, i) => {
        const rs =
          (bar.close / left[0]!.close / (right[i]!.close / right[0]!.close)) *
          100;
        if (!Number.isFinite(rs) || rs <= 0) throw new Error("RS计算溢出");
        return {
          date: bar.date,
          stockClose: bar.close,
          benchmarkClose: right[i]!.close,
          rs,
        };
      })
    : [];
  const content = {
    version: "wyckoff-rs-ratio-1",
    stock: stock.symbol,
    benchmark: benchmark.symbol,
    sources: [
      { id: stock.id, source: stock.source },
      { id: benchmark.id, source: benchmark.source },
    ],
    start,
    end,
    adjustment: "none",
    status: aligned ? "computed" : "missing",
    missingStockDates,
    missingBenchmarkDates,
    input: {
      stock: left.map((b) => [b.date, b.close]),
      benchmark: right.map((b) => [b.date, b.close]),
    },
    rows,
    changePercent: rows.length
      ? (rows.at(-1)!.rs / rows[0]!.rs - 1) * 100
      : null,
    formula: "(stockClose/stockBase)/(benchmarkClose/benchmarkBase)*100",
    warnings: [
      "采用方法第2节归一化比率公式，不采用末尾示例的涨幅相减",
      "分析起点由调用方明确指定，不代表已核验的TR起点",
      "日期对应不证明共同缺失的交易日完整；基准身份、行业归属、企业行动及流动性仍须核验",
      "不据此生成吸筹/派发置信度、RS背离确认或自动信号",
    ],
  };
  return {
    ...content,
    hash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
}
