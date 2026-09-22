import { z } from "zod";
import { createHash } from "node:crypto";
import { completedBar } from "~/lib/completed-bars";

const rowSchema = z
  .object({
    symbol: z.string(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((date) => {
        const time = Date.parse(date);
        return (
          Number.isFinite(time) &&
          new Date(time).toISOString().slice(0, 10) === date
        );
      }),
    last: z.number().finite().positive(),
    volume: z.number().finite().nonnegative(),
  })
  .passthrough();
export function sectorPriceMetrics(
  raw: unknown,
  symbols: string[],
  cutoff: number,
) {
  if (!Number.isFinite(cutoff)) throw new Error("价格核验截止时间非法");
  if (
    !symbols.length ||
    symbols.length > 7 ||
    new Set(symbols).size !== symbols.length ||
    symbols.some((s) => !/^pt01\d{6}$/.test(s))
  )
    throw new Error("行业指数代码列表非法");
  const rows = z.array(rowSchema).max(16000).parse(raw);
  const allowed = new Set([...symbols, "sh000001"]);
  const seen = new Set<string>();
  for (const row of rows) {
    if (!allowed.has(row.symbol)) throw new Error("返回了未请求的指数代码");
    const key = `${row.symbol}:${row.date}`;
    if (seen.has(key)) throw new Error("指数日线日期重复");
    seen.add(key);
  }
  const series = (symbol: string) =>
    rows
      .filter((r) => r.symbol === symbol && completedBar(r.date, "day", cutoff))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-31);
  const benchmark = series("sh000001");
  const change = (bars: ReturnType<typeof series>, periods: number) =>
    bars.length > periods
      ? (bars.at(-1)!.last / bars.at(-periods - 1)!.last - 1) * 100
      : null;
  const results = symbols.map((symbol) => {
    const bars = series(symbol);
    const warnings: string[] = [];
    const sameDates =
      bars.length >= 6 &&
      bars
        .slice(-6)
        .every((bar, i) => bar.date === benchmark.slice(-6)[i]?.date);
    if (bars.length < 31)
      warnings.push("不足31根完整日线，不能计算30个区间收益");
    if (!sameDates)
      warnings.push("行业与上证指数近6根日期不一致，不计算5区间相对涨幅");
    const return5 = change(bars, 5),
      return30 = change(bars, 30);
    const previousVolumes = bars.slice(-25, -5),
      recentVolumes = bars.slice(-5);
    const previousMean =
      previousVolumes.reduce((sum, bar) => sum + bar.volume, 0) / 20;
    const volumeRatio =
      bars.length >= 25 && previousMean > 0
        ? recentVolumes.reduce((sum, bar) => sum + bar.volume, 0) /
          5 /
          previousMean
        : null;
    if (volumeRatio === null)
      warnings.push("量能窗口不足或前20根平均成交量为0");
    return {
      symbol,
      start: bars[0]?.date ?? null,
      asOf: bars.at(-1)?.date ?? null,
      bars: bars.length,
      return5,
      return30,
      excess5:
        sameDates && return5 !== null ? return5 - change(benchmark, 5)! : null,
      closeDrawdown: bars.length
        ? (bars.at(-1)!.last / Math.max(...bars.map((b) => b.last)) - 1) * 100
        : null,
      volumeRatio,
      warnings,
    };
  });
  return {
    version: "sector-price-1" as const,
    cutoff,
    sourceHash: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
    benchmark: "sh000001",
    results,
    assumptions: [
      "收益按可用完整日线的收盘点位计算，5/30表示相邻日线区间数；未独立核验交易日历完整性。",
      "相对涨幅仅在行业与基准末6根日期一致时计算，均为未扣费指数表现。",
      "量比为末5根平均成交量除以前20根平均成交量；绝对成交量单位未在此模块核验。",
      "回撤为相对本窗口最高收盘点位的距离，不是路径最大回撤或实盘收益。",
    ],
  };
}
