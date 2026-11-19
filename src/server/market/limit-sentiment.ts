import { get, put } from "../db";
import {
  fetchLimitPool,
  type LimitPoolKind,
  type LimitPoolRow,
} from "../data-sources/eastmoney/em-limit-pool";
import {
  samplingPoint,
  type LimitObservation,
} from "./limit-sentiment-observations";
import {
  insertLimitObservation,
  readLimitObservations,
} from "../db/limit-sentiment-observations";

/**
 * 打板情绪：涨停 / 炸板 / 跌停 / 昨涨停四池 + 派生指标。
 * 算法参考 simonlin1212/a-stock-data §8.3；晋级率改用「昨涨停今日仍在涨停池」，
 * 不按固定涨幅阈值，避免把 20%/30% 涨跌幅板块算错。
 */
export const LIMIT_SENTIMENT_VERSION = "limit-sentiment-1";

/** 四池与派生统计；历史定稿缓存只保存这一部分，不混入盘中观测。 */
export type LimitSentimentCore = {
  version: string;
  date: string;
  /** false：非交易日或当日还没有数据。 */
  available: boolean;
  /** 历史日期取自本地定稿缓存；当日为盘中数据，最多 60 秒旧。 */
  final: boolean;
  /** 本机四池请求完成时刻，epoch 毫秒；不是交易所同秒快照。 */
  fetchedAt: number;
  pools: Record<LimitPoolKind, LimitPoolRow[]>;
  stats: {
    limitUp: number;
    broken: number;
    limitDown: number;
    /** 炸板 /（涨停 + 炸板），%。 */
    breakRate: number | null;
    maxHeight: number;
    /** 昨涨停今日再涨停 / 昨涨停，%。 */
    promotionRate: number | null;
    /** 昨涨停股今日平均涨跌幅，%。 */
    yesterdayAvgChange: number | null;
  };
  ladder: { height: number; count: number; names: string[] }[];
  industries: { name: string; count: number }[];
};

/** 本机盘中观测；只有页面实际成功刷新才积累，不从事后日度数字补采。 */
export type LimitSentimentIntraday = {
  date: string;
  points: LimitObservation[];
  /** 本机观测读取或保存错误；不影响上方四池数据。 */
  error: string | null;
};

export type LimitSentiment = LimitSentimentCore & {
  intraday: LimitSentimentIntraday;
};

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

export function summarizeLimitPools(
  date: string,
  pools: Record<LimitPoolKind, LimitPoolRow[]>,
) {
  const { zt, zb, dt, yzt } = pools;
  const byHeight = new Map<number, string[]>();
  for (const row of zt) {
    const h = row.streak ?? 1;
    byHeight.set(h, [...(byHeight.get(h) ?? []), row.name]);
  }
  const industries = new Map<string, number>();
  for (const row of zt)
    if (row.industry)
      industries.set(row.industry, (industries.get(row.industry) ?? 0) + 1);
  const today = new Set(zt.map((r) => r.symbol));
  const changes = yzt.flatMap((r) =>
    r.changePct == null ? [] : [r.changePct],
  );
  return {
    stats: {
      limitUp: zt.length,
      broken: zb.length,
      limitDown: dt.length,
      breakRate:
        zt.length + zb.length
          ? round((zb.length / (zt.length + zb.length)) * 100)
          : null,
      maxHeight: Math.max(0, ...zt.map((r) => r.streak ?? 1)),
      promotionRate: yzt.length
        ? round(
            (yzt.filter((r) => today.has(r.symbol)).length / yzt.length) * 100,
          )
        : null,
      yesterdayAvgChange: changes.length
        ? round(changes.reduce((a, b) => a + b, 0) / changes.length, 2)
        : null,
    },
    ladder: [...byHeight]
      .sort((a, b) => b[0] - a[0])
      .map(([height, names]) => ({ height, count: names.length, names })),
    industries: [...industries]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count })),
    date,
  };
}

export const beijingToday = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

const LIVE_TTL_MS = 60000;
const live = new Map<string, LimitSentimentCore>();
const cacheId = (date: string) => `limit-sentiment:${date}`;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** 读本机观测；读取或前一步保存失败时保留明确状态，四池结果照常返回。 */
function readIntraday(
  date: string,
  writeError: string | null = null,
): LimitSentimentIntraday {
  try {
    return { date, points: readLimitObservations(date), error: writeError };
  } catch (error) {
    const readError = errorMessage(error);
    return {
      date,
      points: [],
      error: writeError ? `${writeError}；${readError}` : readError,
    };
  }
}

export async function limitSentiment(
  date: string,
  signal?: AbortSignal,
): Promise<LimitSentiment> {
  const today = beijingToday();
  if (date > today) throw new Error("日期不能晚于今天");
  if (date < today) {
    const stored = get<LimitSentimentCore>(cacheId(date));
    if (stored?.version === LIMIT_SENTIMENT_VERSION)
      return { ...stored, intraday: readIntraday(date) };
  } else {
    const hit = live.get(date);
    if (hit && Date.now() - hit.fetchedAt < LIVE_TTL_MS)
      return { ...hit, intraday: readIntraday(date) };
  }
  const kinds: LimitPoolKind[] = ["zt", "zb", "dt", "yzt"];
  // emFetch serialises these anyway; sequential keeps abort handling simple.
  const raw: Partial<Record<LimitPoolKind, LimitPoolRow[] | null>> = {};
  for (const kind of kinds)
    raw[kind] = await fetchLimitPool(kind, date, signal);
  const available = kinds.every((k) => raw[k] != null);
  const pools = Object.fromEntries(
    kinds.map((k) => [k, raw[k] ?? []]),
  ) as Record<LimitPoolKind, LimitPoolRow[]>;
  const core: LimitSentimentCore = {
    version: LIMIT_SENTIMENT_VERSION,
    available,
    final: date < today,
    fetchedAt: Date.now(),
    pools,
    ...summarizeLimitPools(date, pools),
  };
  // 只有本次真实四池请求完成、且请求日=完成本地日、工作日交易时段才追加；
  // 历史定稿分支即使本地时钟跳回请求日也不写。缓存命中、历史日、午休、
  // 盘后、越日与失败都在此之前返回或不满足条件。
  let writeError: string | null = null;
  if (available && !core.final) {
    const point = samplingPoint(date, core.fetchedAt, core.stats);
    if (point) {
      try {
        insertLimitObservation(point);
      } catch (error) {
        writeError = errorMessage(error);
      }
    }
  }
  if (core.final) {
    if (available) put("limit-sentiment", cacheId(date), core);
  } else live.set(date, core);
  return { ...core, intraday: readIntraday(date, writeError) };
}
