import { financialDate } from "trading-strategy-core/financial";
import { readSnapshot, resolveTdxRoot } from "tstdx/local";
import { readLocalFinancialSeries } from "../data-sources/tdx/local-financial-files";

/**
 * 通达信本地全市场 ETF 日度净申赎。
 *
 * 只读取 `vipdoc/cw/gpsh999999.dat` 的 SC38 日度记录：第一列是 ETF 规模
 * （亿元），第二列才是 ETF 净申赎（亿元），本模块只取第二列，绝不把规模
 * 当金额。只采用不晚于当前北京时间日期的最多 60 个记录日；源文件自己的
 * 记录日就是数据时点，不借用今日指数报价日期，也不假设实时。同日重复记录
 * 不挑选其中一条，该日金额按缺失处理并显式报告；真实 0 与负数仍是有效值。
 * 只有最近 60 个记录日都存在且全部有效时才给出区间合计，否则只报有效日数，
 * 不补零、不插值、不硬凑。
 *
 * 上证指数作为独立次轴：用 tstdx/local 的公开 `readSnapshot` 直接读本地
 * `sh000001.day`，不写宿主 BarStore、不读宿主 SQLite；只映射与申赎记录日
 * 精确相同的收盘价，不跨日填补、不回退网络。指数读取失败只降级为“无指数”，
 * 申赎数据照常返回。
 */
export const ETF_NET_SUBSCRIPTIONS_VERSION = "etf-net-subscriptions-1";
export const ETF_NET_SUBSCRIPTIONS_SYMBOL = "sh999999";
export const ETF_NET_SUBSCRIPTIONS_MAX_DAYS = 60;
export const ETF_NET_INDEX_SYMBOL = "sh000001";
export const ETF_NET_INDEX_NAME = "上证指数";
const ETF_NET_GROUP = 38;
const SOURCE_SCOPE =
  "vipdoc/cw/gpsh999999.dat · SC38 第二列 ETF净申赎（亿元）；第一列规模（亿元）不混用";

export type EtfNetSubscriptionPoint = {
  date: string;
  /** SC38 第二列，单位亿元；同日重复或不可用值为 null，与真实 0 区分。 */
  net: number | null;
  /** 上证指数精确同日收盘（点）；无同日本地日线时为 null。 */
  index: number | null;
};

export type EtfNetSubscriptionSummary = {
  /** 仅最近 60 个记录日齐全且全部有效时的区间合计（亿元）；否则 null。 */
  total: number | null;
  /** 窗口内有效金额的记录日数。 */
  valid: number;
  complete: boolean;
};

export type EtfNetIndexStatus = {
  symbol: typeof ETF_NET_INDEX_SYMBOL;
  name: typeof ETF_NET_INDEX_NAME;
  state: "ok" | "unavailable";
  /** 与申赎窗口精确同日的指数点数条数。 */
  matched: number;
  /** 本地指数日线整体最新日期，不受申赎窗口截断。 */
  sourceLast: string | null;
  /** 指数不可用原因；正常时为 null。 */
  warning: string | null;
};

export type EtfNetSubscriptions = {
  version: string;
  /** source-unconfigured：未配置本地目录；no-history：文件或截止日前的记录不可用。 */
  state: "ok" | "source-unconfigured" | "no-history";
  source: "通达信本地";
  scope: string;
  filename: string;
  /** 当前北京时间日期，作为采用记录的上限。 */
  requestedDate: string;
  /** 截止日及之前最新的一条记录日。 */
  latest: string | null;
  /** SC38 源整体覆盖范围，不受截止日截断。 */
  sourceFirst: string | null;
  sourceLast: string | null;
  /** 实际展示的起止日期与记录日数（最多 60）。 */
  window: { start: string; end: string; count: number } | null;
  points: EtfNetSubscriptionPoint[];
  duplicates: { date: string; count: number }[];
  summary: EtfNetSubscriptionSummary;
  index: EtfNetIndexStatus;
  warning: string | null;
  loadedAt: number | null;
  generatedAt: number;
};

function base(requestedDate: string): Omit<EtfNetSubscriptions, "state"> {
  return {
    version: ETF_NET_SUBSCRIPTIONS_VERSION,
    source: "通达信本地",
    scope: SOURCE_SCOPE,
    filename: `gp${ETF_NET_SUBSCRIPTIONS_SYMBOL}.dat`,
    requestedDate,
    latest: null,
    sourceFirst: null,
    sourceLast: null,
    window: null,
    points: [],
    duplicates: [],
    summary: { total: null, valid: 0, complete: false },
    index: {
      symbol: ETF_NET_INDEX_SYMBOL,
      name: ETF_NET_INDEX_NAME,
      state: "unavailable",
      matched: 0,
      sourceLast: null,
      warning: null,
    },
    warning: null,
    loadedAt: null,
    generatedAt: Date.now(),
  };
}

function missingFile(error: unknown) {
  if ((error as { code?: string } | null)?.code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|no such file|文件不存在/i.test(message);
}

/** 与既有财务读取一致：按北京时间取自然日，不依赖进程本地时区。 */
function beijingToday(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

/** 指数只做减法退让：任何读取失败都不影响已完成解析的申赎序列。 */
async function readIndex(root: string): Promise<{
  status: EtfNetIndexStatus;
  closes: Map<string, number>;
}> {
  try {
    const snapshot = await readSnapshot(root, ETF_NET_INDEX_SYMBOL, "day");
    return {
      status: {
        symbol: ETF_NET_INDEX_SYMBOL,
        name: ETF_NET_INDEX_NAME,
        state: "ok",
        matched: 0,
        sourceLast: snapshot.bars.at(-1)?.date ?? null,
        warning: null,
      },
      closes: new Map(snapshot.bars.map((bar) => [bar.date, bar.close])),
    };
  } catch {
    return {
      status: {
        symbol: ETF_NET_INDEX_SYMBOL,
        name: ETF_NET_INDEX_NAME,
        state: "unavailable",
        matched: 0,
        sourceLast: null,
        warning: "本地上证指数日线不可用，仅显示净申赎",
      },
      closes: new Map(),
    };
  }
}

export async function etfNetSubscriptions(
  root: string,
  asOf: string = beijingToday(),
): Promise<EtfNetSubscriptions> {
  if (!root.trim())
    return {
      ...base(asOf),
      state: "source-unconfigured",
      warning: "通达信本地目录尚未配置",
    };
  try {
    resolveTdxRoot(root);
  } catch (error) {
    if ((error as { code?: string }).code === "TDX_ROOT_REQUIRED")
      return {
        ...base(asOf),
        state: "source-unconfigured",
        warning: "通达信本地目录尚未配置",
      };
    throw error;
  }

  let source: Awaited<ReturnType<typeof readLocalFinancialSeries>>;
  try {
    source = await readLocalFinancialSeries(root, ETF_NET_SUBSCRIPTIONS_SYMBOL);
  } catch (error) {
    if (missingFile(error))
      return {
        ...base(asOf),
        state: "no-history",
        warning: `未找到 gp${ETF_NET_SUBSCRIPTIONS_SYMBOL}.dat 或所在目录`,
      };
    throw error;
  }

  // 同一记录日可能出现多条同组记录；全部保留以便判定歧义，不先挑一条。
  const byDate = new Map<string, number[]>();
  let sourceFirst: string | null = null;
  let sourceLast: string | null = null;
  for (const record of source.records) {
    if (record.group !== ETF_NET_GROUP) continue;
    const date = record.date === null ? null : financialDate(record.date);
    if (!date) continue;
    if (!sourceFirst || date < sourceFirst) sourceFirst = date;
    if (!sourceLast || date > sourceLast) sourceLast = date;
    const values = byDate.get(date);
    if (values) values.push(record.values[1]);
    else byDate.set(date, [record.values[1]]);
  }

  const dates = [...byDate.keys()].filter((date) => date <= asOf).sort();
  if (!dates.length)
    return {
      ...base(asOf),
      state: "no-history",
      sourceFirst,
      sourceLast,
      warning:
        sourceFirst && sourceLast
          ? `本地 SC38 覆盖 ${sourceFirst} ~ ${sourceLast}，所选截止日及之前没有记录`
          : "本地源没有 SC38 的有效日期记录",
    };

  const windowDates = dates.slice(-ETF_NET_SUBSCRIPTIONS_MAX_DAYS);
  const duplicates: EtfNetSubscriptions["duplicates"] = [];
  const points: EtfNetSubscriptionPoint[] = windowDates.map((date) => {
    const values = byDate.get(date)!;
    if (values.length > 1) {
      duplicates.push({ date, count: values.length });
      return { date, net: null, index: null };
    }
    const value = values[0]!;
    return {
      date,
      net: Number.isFinite(value) ? value : null,
      index: null,
    };
  });

  const { status: index, closes } = await readIndex(root);
  // 只按精确同日键取值；缺失日期留空，不向前/向后借用相邻收盘。
  for (const point of points) point.index = closes.get(point.date) ?? null;
  index.matched = points.filter((point) => point.index !== null).length;

  const valid = points.filter((point) => point.net !== null).length;
  const complete =
    windowDates.length === ETF_NET_SUBSCRIPTIONS_MAX_DAYS &&
    valid === ETF_NET_SUBSCRIPTIONS_MAX_DAYS;
  const total = complete
    ? points.reduce((sum, point) => sum + (point.net ?? 0), 0)
    : null;

  return {
    ...base(asOf),
    state: "ok",
    latest: windowDates.at(-1)!,
    sourceFirst,
    sourceLast,
    window: {
      start: windowDates[0]!,
      end: windowDates.at(-1)!,
      count: windowDates.length,
    },
    points,
    duplicates,
    summary: { total, valid, complete },
    index,
    warning: source.classificationWarning,
    loadedAt: source.loadedAt,
  };
}
