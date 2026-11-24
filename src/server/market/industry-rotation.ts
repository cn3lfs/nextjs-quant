import { rankRps, type RpsValue } from "quant-rps";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseBars, readTdxLocalBlocks, resolveTdxRoot } from "tstdx/local";
import { completedBarFilter } from "~/lib/completed-bars";
import { CORE_30_V1_PRESET } from "../research/diagnose/universe-presets";
import {
  isWeekday,
  readIndicatorSource,
  shiftDate,
  withMarketReadContext,
  type MarketIndicatorQuery,
  type MarketReadContext,
} from "./market-temperature-inputs";

// The preset already freezes one identity per TDX research L1 industry.
// Its sample stocks are not used as proxies for industry index prices.
const industries = Object.values(CORE_30_V1_PRESET.metadata).map(
  ({ industry, industryCode }) => ({
    name: industry,
    code: industryCode,
    symbol: "sh" + industryCode,
  }),
);
const benchmark = "sh000300";
const periods = [5, 20, 60, 120] as const;
const policy = {
  version: "industry-rotation-2",
  benchmark,
  periods,
  center: 100,
  weekly:
    "以市场交易日并集确定已结束 ISO 周的最后一个交易日。行业与沪深300均须有该日有效收盘。若尚无周五开闭市或后续交易日依据，最新一周留空。",
  ratio: "RS=100×行业周收盘/沪深300周收盘；X=100×RS/SMA4(RS)。",
  momentum:
    "Y=100×X/SMA3(X)，均线含当周，缺周重新预热。保留最近8个已结束的日历周。",
  quadrants:
    "X≥100、Y≥100 领先；X≥100、Y<100 转弱；X<100、Y<100 落后；X<100、Y≥100 改善。",
  rps: "通达信30个一级研究行业，以同一观测交易日 t 与 t−N 的有效原始指数收盘计算收益；有效行业截面并列取平均名次，RPS=100×(1−名次/N有效)。",
  leaders:
    "当前本地通达信一级行业成员，按冻结面板全体有效A股20交易日因果复权收益截面RPS，列前5。当前名单只用于观察当日的下钻，不回填历史成分。",
} as const;

export type RrgQuadrant = "leading" | "weakening" | "lagging" | "improving";
export const rrgQuadrant = (x: number, y: number): RrgQuadrant =>
  x >= 100
    ? y >= 100
      ? "leading"
      : "weakening"
    : y >= 100
      ? "improving"
      : "lagging";

type CloseSeries = ReadonlyMap<string, number>;
export type RotationInput = {
  through: string;
  sessions: readonly string[];
  closedDays?: readonly string[];
  closes: ReadonlyMap<string, CloseSeries>;
};
export type IndustryLeader = RpsValue & { symbol: string };
function validClose(series: CloseSeries | undefined, date: string) {
  const close = series?.get(date);
  return close !== undefined && close > 0 && Number.isFinite(close)
    ? close
    : null;
}
function normalized(series: (number | null)[], i: number, length: number) {
  const window = series.slice(Math.max(0, i + 1 - length), i + 1);
  if (window.length !== length || !window.every((n): n is number => n !== null))
    return null;
  return (
    (100 * window[length - 1]!) / (window.reduce((a, b) => a + b, 0) / length)
  );
}
export function calculateIndustryRotation({
  through,
  sessions,
  closedDays = [],
  closes,
}: RotationInput) {
  const base = closes.get(benchmark);
  // The benchmark can cover gaps in the market panel calendar. Industry
  // observations never determine which session ends the week.
  const marketDays = new Set([...sessions, ...(base?.keys() ?? [])]);
  const dates = [...marketDays]
    .filter((d) => d <= through && isWeekday(d))
    .sort();
  const open = new Set(dates),
    closed = new Set(closedDays);
  const rpsDate = dates.at(-1) ?? null;
  const rps = periods.map((h) => {
    const first = dates.at(-h - 1);
    const returns = industries.flatMap(({ symbol }) => {
      const prices = closes.get(symbol);
      const a = first && validClose(prices, first),
        b = rpsDate && validClose(prices, rpsDate);
      return a && b ? [{ symbol, return: b / a - 1 }] : [];
    });
    return rankRps(returns);
  });
  const weekday = new Date(through).getUTCDay();
  const friday = shiftDate(through, -((weekday + 2) % 7));
  const weeks: {
    start: string;
    end: string;
    closeDate: string | null;
  }[] = [];
  // 8 displayed weeks + 3 prior observations for SMA4 + 2 for SMA3.
  for (let ago = 12; ago >= 0; ago--) {
    const end = shiftDate(friday, -7 * ago),
      start = shiftDate(end, -4);
    if (!dates[0] || end < dates[0]) continue;
    const weekdays = Array.from({ length: 5 }, (_, i) => shiftDate(start, i));
    const days = weekdays.filter((d) => open.has(d));
    const complete =
      (open.has(end) ||
        closed.has(end) ||
        (rpsDate !== null && rpsDate > end)) &&
      !days.some((d) => closed.has(d));
    weeks.push({
      start,
      end,
      closeDate: complete ? (days.at(-1) ?? null) : null,
    });
  }
  const rows = industries.map((industry) => {
    const series = closes.get(industry.symbol);
    const rs = weeks.map(({ closeDate }) => {
      if (!closeDate) return null;
      const market = validClose(base, closeDate);
      const industry = validClose(series, closeDate);
      return market !== null && industry !== null
        ? (100 * industry) / market
        : null;
    });
    const ratios = rs.map((_, i) => normalized(rs, i, 4));
    const trail = weeks
      .map((w, i) => {
        const x = ratios[i]!,
          y = normalized(ratios, i, 3);
        return {
          weekStart: w.start,
          weekEnd: w.end,
          closeDate: rs[i] === null ? null : w.closeDate,
          relativeClose: rs[i]!,
          x,
          y,
          quadrant: x === null || y === null ? null : rrgQuadrant(x, y),
        };
      })
      .slice(-8);
    const value = (i: number) => rps[i]!.get(industry.symbol) ?? null;
    return {
      ...industry,
      trail,
      latest: trail.at(-1) ?? null,
      rps: { 5: value(0), 20: value(1), 60: value(2), 120: value(3) },
    };
  });
  return {
    weeks: weeks
      .slice(-8)
      .map(({ start, end, closeDate }) => ({ start, end, closeDate })),
    rpsDate,
    rpsPopulation: {
      5: rps[0]!.size,
      20: rps[1]!.size,
      60: rps[2]!.size,
      120: rps[3]!.size,
    },
    rows,
  };
}

async function readLeaders(ctx: MarketReadContext, dates: string[]) {
  const leaders = new Map<string, IndustryLeader[]>();
  let membershipHash: string | null = null;
  let membershipObservedDate: string | null = null;
  const panel = ctx.panel,
    end = dates.at(-1),
    start = dates.at(-21);
  if (
    !panel ||
    !start ||
    !end ||
    !panel.manifest.dates.includes(start) ||
    !panel.manifest.dates.includes(end)
  ) {
    return { leaders, membershipHash, membershipObservedDate };
  }
  const today = new Date(ctx.now + 8 * 3600000).toISOString().slice(0, 10);
  if (ctx.asOf !== today)
    return { leaders, membershipHash, membershipObservedDate };
  const source = await readTdxLocalBlocks(ctx.root);
  membershipHash = source.hash;
  membershipObservedDate = new Date(source.observedAt + 8 * 3600000)
    .toISOString()
    .slice(0, 10);
  if (membershipObservedDate > ctx.asOf)
    return { leaders, membershipHash, membershipObservedDate };
  const a = panel.crossSection(start),
    b = panel.crossSection(end);
  const ranked = rankRps(
    panel.manifest.symbols.flatMap((s, i) => {
      const first = a.closeAtoms[i]! * a.adjFactor[i]!,
        last = b.closeAtoms[i]! * b.adjFactor[i]!;
      return s.kind === "stock" &&
        a.valid[i] &&
        b.valid[i] &&
        first > 0 &&
        last > 0
        ? [{ symbol: s.symbol, return: last / first - 1 }]
        : [];
    }),
  );
  for (const block of source.blocks) {
    if (!block.code || block.category !== "industry" || block.level !== 1)
      continue;
    const candidates = block.members.flatMap((symbol) => {
      const result = ranked.get(symbol);
      return result ? [{ symbol, ...result }] : [];
    });
    leaders.set(
      block.code,
      candidates
        .sort((a, b) => a.rank - b.rank || a.symbol.localeCompare(b.symbol))
        .slice(0, 5),
    );
  }
  return { leaders, membershipHash, membershipObservedDate };
}

export async function industryRotationRrg(query: MarketIndicatorQuery = {}) {
  return withMarketReadContext(query, async (ctx) => {
    const complete = completedBarFilter("day", ctx.now);
    const through = complete(ctx.asOf) ? ctx.asOf : shiftDate(ctx.asOf, -1);
    const symbols = [benchmark, ...industries.map((i) => i.symbol)];
    const closes = new Map<string, CloseSeries>();
    const hashes: Record<string, string> = {};
    const sessions = new Set(ctx.dates.filter((d) => d <= through));
    const results = await Promise.allSettled(
      symbols.map(async (symbol) => {
        const body = await readIndicatorSource(
          join(
            resolveTdxRoot(ctx.root),
            "vipdoc",
            "sh",
            "lday",
            symbol + ".day",
          ),
        );
        if (!body.length || body.length % 32 !== 0)
          throw new Error("日线文件不完整");
        return {
          bars: parseBars(body, "day"),
          hash: createHash("sha256").update(body).digest("hex"),
        };
      }),
    );
    for (const [i, result] of results.entries()) {
      const symbol = symbols[i]!;
      if (result.status === "rejected") {
        ctx.warnings.push(symbol + " 日线不可用：" + String(result.reason));
        continue;
      }
      hashes[symbol] = result.value.hash;
      const series = new Map<string, number>();
      for (const bar of result.value.bars) {
        if (bar.date > through || !isWeekday(bar.date)) continue;
        if (symbol === benchmark) sessions.add(bar.date);
        if (bar.volume > 0) series.set(bar.date, bar.close);
      }
      closes.set(symbol, series);
    }
    const dates = [...sessions].sort();
    const result = calculateIndustryRotation({
      through,
      sessions: dates,
      closes,
    });
    const membership = await readLeaders(ctx, dates).catch((error: unknown) => {
      ctx.warnings.push("行业成分不可用：" + String(error));
      return {
        leaders: new Map<string, IndustryLeader[]>(),
        membershipHash: null,
        membershipObservedDate: null,
      };
    });
    return {
      asOf: ctx.asOf,
      through,
      policy,
      ...result,
      rows: result.rows.map((row) => ({
        ...row,
        leaders: membership.leaders.get(row.code) ?? null,
      })),
      provenance: {
        root: ctx.root,
        calendar: ctx.calendarSource + " 补充沪深300已观测交易日。",
        priceSources: hashes,
        taxonomy: "core-30-v1 / TDX研究一级行业代码",
        membershipHash: membership.membershipHash,
        membershipObservedDate: membership.membershipObservedDate,
        snapshotId: ctx.panel?.snapshotId ?? null,
        warnings: ctx.warnings,
      },
    };
  });
}
export type IndustryRotationResult = Awaited<
  ReturnType<typeof industryRotationRrg>
>;
