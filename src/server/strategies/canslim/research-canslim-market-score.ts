import type { Bar } from "~/lib/domain";
import type { CanslimMarketId } from "~/lib/research-canslim-market-strategies";
import { ma } from "~/lib/indicators";
import { canslimMarket } from "./canslim-market";
import { canslimFollowThrough } from "./canslim-follow-through";

export type CanslimResearchMarket = {
  symbol: string;
  bars: readonly Bar[];
  source: string;
  hash: string;
};
export function researchCanslimMarketScore(
  id: CanslimMarketId,
  bars: readonly Bar[],
  calendar: readonly string[],
  market?: CanslimResearchMarket,
) {
  const input =
    market?.symbol === "sh000300" && market.source && market.hash
      ? market.bars
      : [];
  const indices = new Map<string, number>();
  const ordered: boolean[] = [];
  input.forEach((b, i) => {
    ordered.push(!i || (ordered[i - 1]! && b.date > input[i - 1]!.date));
    if (!indices.has(b.date)) indices.set(b.date, i);
  });
  const dates = new Map(calendar.map((date, i) => [date, i]));
  const tier = id.includes("-tier-");
  const trend = id.endsWith("ma250") || id.endsWith("ma200");
  const period = id.endsWith("ma200") ? 200 : 250;
  const means = ma(input, period),
    means120 = ma(input, 120);
  const size = trend
    ? period + (tier ? 4 : 0)
    : id.endsWith("follow10")
      ? tier
        ? 38
        : 11
      : 21;
  const maximum = trend ? 10 : id.endsWith("follow10") ? 8 : 5;
  const validBar = (b: Bar) =>
    [b.open, b.high, b.low, b.close, b.volume].every(
      (v) => Number.isFinite(v) && v > 0,
    ) &&
    b.high >= Math.max(b.open, b.close, b.low) &&
    b.low <= Math.min(b.open, b.close);
  let previous: number | null = null;
  let previousDate: string | null = null;
  return bars.map((bar) => {
    const j = indices.get(bar.date),
      day = dates.get(bar.date);
    const actualSize =
      tier && id.endsWith("follow10") ? Math.max(size, (day ?? -1) + 1) : size;
    const window =
      j == null ? [] : input.slice(Math.max(0, j - actualSize + 1), j + 1);
    const available =
      j != null &&
      ordered[j] === true &&
      day != null &&
      window.length === actualSize &&
      window.every(
        (b, k) => validBar(b) && b.date === calendar[day - actualSize + 1 + k],
      ) &&
      validBar(bar);
    const count =
      available && !trend
        ? window
            .slice(1)
            .filter((b, k) =>
              id.endsWith("follow10")
                ? b.close >= window[k]!.close * 1.015 &&
                  b.volume > window[k]!.volume * 1.5
                : b.close < window[k]!.close && b.volume > window[k]!.volume,
            ).length
        : null;
    let points = !available
      ? null
      : trend
        ? input[j!]!.close > means[j!]!
          ? 10
          : 0
        : id.endsWith("follow10")
          ? count! > 0
            ? 8
            : 0
          : count! < 5
            ? 5
            : 0;
    let details: unknown = null;
    if (tier && available) {
      const time = Date.parse(`${bar.date}T07:06:00Z`);
      const snapshot = {
        id: "research-market",
        hash: market!.hash,
        symbol: "sh000300",
        source: market!.source,
        period: "day" as const,
        adjustment: "none" as const,
        createdAt: time,
        historicalAsOf: bar.date,
        bars: window,
      };
      if (id.endsWith("follow10")) {
        const follow = canslimFollowThrough(snapshot, time);
        points = follow.status === "computed" ? follow.points : null;
        details = follow;
      } else if (!trend) {
        const distribution = canslimMarket(snapshot, time).checks.find(
          (check) => check.id === "M3",
        )!;
        points =
          distribution.status === "computed" ? distribution.points : null;
        details = distribution;
      } else {
        const average = means[j!]!,
          close = input[j!]!.close;
        const rising = average > means[j! - 1]!;
        const aboveFourDays = [0, 1, 2, 3].every(
          (offset) => input[j! - offset]!.close > means[j! - offset]!,
        );
        const near = close >= average * 0.99 && close <= average * 1.01;
        points = near
          ? 5
          : close > average
            ? rising && aboveFourDays
              ? 10
              : 7
            : close > means120[j!]!
              ? 3
              : 0;
        details = {
          period,
          average,
          ma120: means120[j!],
          rising,
          aboveFourDays,
          near,
        };
      }
    }
    const contiguous = day != null && calendar[day - 1] === previousDate;
    const result = {
      date: bar.date,
      entry:
        contiguous &&
        previous !== null &&
        previous < maximum &&
        points === maximum,
      exit: false,
      reason:
        points === null
          ? "缺少沪深300同源连续有效市场窗口或个股行情"
          : previous === null || !contiguous
            ? "前一研究日评分未知，不确认上穿"
            : null,
      values: { close: Number.isFinite(bar.close) ? bar.close : null },
      diagnostic: {
        version: `${id}-1`,
        status: points === null ? "missing" : "computed",
        points,
        details,
        previousPoints: contiguous ? previous : null,
        count,
        ma250: available && id.endsWith("ma250") ? means[j!]! : null,
        marketSymbol: market?.symbol ?? null,
        source: market?.source ?? null,
        hash: market?.hash ?? null,
      },
    };
    previous = points;
    previousDate = bar.date;
    return result;
  });
}
