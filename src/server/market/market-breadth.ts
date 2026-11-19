import { financialDate } from "trading-strategy-core/financial";
import { resolveTdxRoot } from "tstdx/local";
import { readLocalFinancialSeries } from "../data-sources/tdx/local-financial-files";

/**
 * 通达信本地市场涨跌家数。
 *
 * 只读取 `vipdoc/cw/gpsh999999.dat` 的 SC31 日度记录：第一列上涨家数，
 * 第二列下跌家数，两数来自同一条原始记录。字典没有给出 SC31 的交易所精确
 * 范围，因此结果不标注具体市场。只采用不晚于当前北京时间日期的最新记录；
 * 源文件自己的记录日就是数据时点，不借用今日指数报价日期，也不假设实时。
 * 所选日同日重复时不挑选其中一条，两列都保留为未知并显式报告重复；单列
 * 负数或非整数按未知处理，真实 0 家仍然有效。源没有平盘字段，不派生平盘、
 * 涨跌比或资金数据。
 */
export const MARKET_BREADTH_VERSION = "market-breadth-1";
export const MARKET_BREADTH_SYMBOL = "sh999999";
const BREADTH_GROUP = 31;
const SOURCE_SCOPE =
  "vipdoc/cw/gpsh999999.dat · SC31 第一列上涨家数 / 第二列下跌家数；源口径剔除停牌，源无平盘字段";

export type MarketBreadthUnknown = "duplicate" | "invalid";

export type MarketBreadth = {
  version: string;
  /** source-unconfigured：未配置本地目录；no-record：所选截止日前没有 SC31 记录。 */
  state: "ok" | "source-unconfigured" | "no-record";
  source: "通达信本地";
  scope: string;
  filename: string;
  /** 当前北京时间日期，作为采用记录的上限。 */
  requestedDate: string;
  /** 实际采用的 SC31 记录日；所选截止日或之前为空时为 null。 */
  date: string | null;
  /** SC31 源整体覆盖范围，不受截止日截断。 */
  sourceFirst: string | null;
  sourceLast: string | null;
  up: number | null;
  down: number | null;
  /** 未知原因；有数值时为 null，与真实 0 家显式区分。 */
  upUnknown: MarketBreadthUnknown | null;
  downUnknown: MarketBreadthUnknown | null;
  /** 所选日同组重复记录，不挑选其中一条。 */
  duplicates: { date: string; count: number }[];
  warning: string | null;
  loadedAt: number | null;
  generatedAt: number;
};

function base(requestedDate: string): Omit<MarketBreadth, "state"> {
  return {
    version: MARKET_BREADTH_VERSION,
    source: "通达信本地",
    scope: SOURCE_SCOPE,
    filename: `gp${MARKET_BREADTH_SYMBOL}.dat`,
    requestedDate,
    date: null,
    sourceFirst: null,
    sourceLast: null,
    up: null,
    down: null,
    upUnknown: null,
    downUnknown: null,
    duplicates: [],
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

function count(value: number): number | null {
  const number = value === 0 ? 0 : value;
  return Number.isInteger(number) && number >= 0 ? number : null;
}

/** 与既有财务读取一致：按北京时间取自然日，不依赖进程本地时区。 */
function beijingToday(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

export async function marketBreadth(
  root: string,
  asOf: string = beijingToday(),
): Promise<MarketBreadth> {
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
    source = await readLocalFinancialSeries(root, MARKET_BREADTH_SYMBOL);
  } catch (error) {
    if (missingFile(error))
      return {
        ...base(asOf),
        state: "no-record",
        warning: `未找到 ${`gp${MARKET_BREADTH_SYMBOL}.dat`} 或所在目录`,
      };
    throw error;
  }

  const byDate = new Map<string, [number, number][]>();
  let sourceFirst: string | null = null;
  let sourceLast: string | null = null;
  for (const record of source.records) {
    if (record.group !== BREADTH_GROUP) continue;
    const date = record.date === null ? null : financialDate(record.date);
    if (!date) continue;
    if (!sourceFirst || date < sourceFirst) sourceFirst = date;
    if (!sourceLast || date > sourceLast) sourceLast = date;
    const values = byDate.get(date);
    if (values) values.push(record.values);
    else byDate.set(date, [record.values]);
  }

  const dates = [...byDate.keys()].filter((date) => date <= asOf).sort();
  const date = dates.at(-1) ?? null;
  if (!date)
    return {
      ...base(asOf),
      state: "no-record",
      sourceFirst,
      sourceLast,
      warning:
        sourceFirst && sourceLast
          ? `本地 SC31 覆盖 ${sourceFirst} ~ ${sourceLast}，所选截止日及之前没有记录`
          : "本地源没有 SC31 的有效日期记录",
    };

  const records = byDate.get(date)!;
  const duplicates =
    records.length > 1 ? [{ date, count: records.length }] : [];
  if (records.length !== 1)
    return {
      ...base(asOf),
      state: "ok",
      date,
      sourceFirst,
      sourceLast,
      upUnknown: "duplicate",
      downUnknown: "duplicate",
      duplicates,
      warning: source.classificationWarning,
      loadedAt: source.loadedAt,
    };

  const [rawUp, rawDown] = records[0]!;
  const up = count(rawUp);
  const down = count(rawDown);
  return {
    ...base(asOf),
    state: "ok",
    date,
    sourceFirst,
    sourceLast,
    up,
    down,
    upUnknown: up === null ? "invalid" : null,
    downUnknown: down === null ? "invalid" : null,
    duplicates,
    warning: source.classificationWarning,
    loadedAt: source.loadedAt,
  };
}
