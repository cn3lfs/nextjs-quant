import { financialDate } from "trading-strategy-core/financial";
import { resolveTdxRoot } from "tstdx/local";
import { readLocalFinancialSeries } from "../data-sources/tdx/local-financial-files";

/**
 * 通达信本地涨跌停按日复盘。
 *
 * 同一次读取 `vipdoc/cw/gpsh999999.dat`，取 SC3 第一列（涨停家数）与 SC4 第一列
 * （跌停家数）。第二列「曾涨停/曾跌停」定义不足，不参与计算，也不冒充炸板。
 * 两序列按日期并集排列，所选日之后的记录一律不出现；同组同日重复记录不挑选
 * 其中一条，而是把该日期该序列视为缺失并显式报告。首列是股票家数：单条负数
 * 或非整数不是有效家数，同样按缺失处理；真实 0 家仍然有效。
 * SC31 同一记录的两列分别为上涨、下跌家数，按自身的记录日生成独立窗口。
 */
export const LIMIT_HISTORY_VERSION = "limit-history-1";
export const LIMIT_HISTORY_SYMBOL = "sh999999";
export const LIMIT_HISTORY_MAX_DAYS = 60;
const LIMIT_UP_GROUP = 3;
const LIMIT_DOWN_GROUP = 4;
const BREADTH_GROUP = 31;

export type LimitBreadthPoint = {
  date: string;
  up: number | null;
  down: number | null;
};

export type LimitBreadthHistory = {
  state: "ok" | "no-history";
  latest: string | null;
  sourceFirst: string | null;
  sourceLast: string | null;
  window: { start: string; end: string; count: number } | null;
  points: LimitBreadthPoint[];
  duplicates: { date: string; count: number }[];
  warning: string | null;
};

export type LimitHistoryPoint = {
  date: string;
  limitUp: number | null;
  limitDown: number | null;
};

export type LimitHistoryDuplicate = {
  group: number;
  field: "limitUp" | "limitDown";
  date: string;
  count: number;
};

export type LimitHistory = {
  version: string;
  /** source-unconfigured：未配置本地目录；no-history：文件或所选日前的记录不可用。 */
  state: "ok" | "source-unconfigured" | "no-history";
  source: "通达信本地";
  scope: string;
  filename: string;
  requestedDate: string;
  /** 所选日及之前最新的一条记录日；所选日晚于源最新日时等于源最新日。 */
  latest: string | null;
  /** 源文件整体覆盖范围，不受所选日截断。 */
  sourceFirst: string | null;
  sourceLast: string | null;
  /** 实际绘制的起止日期与记录日数（最多 60）。 */
  window: { start: string; end: string; count: number } | null;
  points: LimitHistoryPoint[];
  breadth: LimitBreadthHistory;
  duplicates: LimitHistoryDuplicate[];
  warning: string | null;
  loadedAt: number | null;
  generatedAt: number;
};

const SOURCE_SCOPE =
  "vipdoc/cw/gpsh999999.dat · SC3 第一列涨停家数 / SC4 第一列跌停家数；第二列「曾涨停/曾跌停」不用于炸板";

function emptyBreadth(warning: string): LimitBreadthHistory {
  return {
    state: "no-history",
    latest: null,
    sourceFirst: null,
    sourceLast: null,
    window: null,
    points: [],
    duplicates: [],
    warning,
  };
}

function base(
  requestedDate: string,
  breadth = emptyBreadth("本地 SC31 数据源不可用"),
): Omit<LimitHistory, "state"> {
  return {
    version: LIMIT_HISTORY_VERSION,
    source: "通达信本地",
    scope: SOURCE_SCOPE,
    filename: `gp${LIMIT_HISTORY_SYMBOL}.dat`,
    requestedDate,
    breadth,
    latest: null,
    sourceFirst: null,
    sourceLast: null,
    window: null,
    points: [],
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

function validCount(value: number): number | null {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function pick(
  values: number[] | undefined,
  date: string,
  field: LimitHistoryDuplicate["field"],
  group: number,
  duplicates: LimitHistoryDuplicate[],
) {
  if (!values) return null;
  if (values.length > 1) {
    duplicates.push({ group, field, date, count: values.length });
    return null;
  }
  return validCount(values[0]!);
}

function breadthHistory(
  byDate: Map<string, [number, number][]>,
  requestedDate: string,
  warning: string | null,
): LimitBreadthHistory {
  const dates = [...byDate.keys()].sort();
  const sourceFirst = dates[0] ?? null;
  const sourceLast = dates.at(-1) ?? null;
  const windowDates = dates
    .filter((date) => date <= requestedDate)
    .slice(-LIMIT_HISTORY_MAX_DAYS);
  const latest = windowDates.at(-1);
  if (!latest)
    return {
      ...emptyBreadth(
        sourceFirst
          ? `本地 SC31 覆盖 ${sourceFirst} ~ ${sourceLast}，所选日期及之前没有记录`
          : "本地源没有 SC31 的有效日期记录",
      ),
      sourceFirst,
      sourceLast,
    };

  const duplicates: LimitBreadthHistory["duplicates"] = [];
  const points = windowDates.map((date) => {
    const records = byDate.get(date)!;
    if (records.length > 1) {
      duplicates.push({ date, count: records.length });
      return { date, up: null, down: null };
    }
    const [up, down] = records[0]!;
    return { date, up: validCount(up), down: validCount(down) };
  });
  return {
    state: "ok",
    latest,
    sourceFirst,
    sourceLast,
    window: { start: windowDates[0]!, end: latest, count: points.length },
    points,
    duplicates,
    warning,
  };
}

export async function limitHistory(
  root: string,
  requestedDate: string,
): Promise<LimitHistory> {
  if (!root.trim())
    return {
      ...base(requestedDate),
      state: "source-unconfigured",
      warning: "通达信本地目录尚未配置",
    };
  try {
    resolveTdxRoot(root);
  } catch (error) {
    if ((error as { code?: string }).code === "TDX_ROOT_REQUIRED")
      return {
        ...base(requestedDate),
        state: "source-unconfigured",
        warning: "通达信本地目录尚未配置",
      };
    throw error;
  }

  let source: Awaited<ReturnType<typeof readLocalFinancialSeries>>;
  try {
    source = await readLocalFinancialSeries(root, LIMIT_HISTORY_SYMBOL);
  } catch (error) {
    if (missingFile(error))
      return {
        ...base(requestedDate),
        state: "no-history",
        warning: `未找到 ${`gp${LIMIT_HISTORY_SYMBOL}.dat`} 或所在目录`,
      };
    throw error;
  }

  const series = new Map<number, Map<string, number[]>>([
    [LIMIT_UP_GROUP, new Map()],
    [LIMIT_DOWN_GROUP, new Map()],
  ]);
  let sourceFirst: string | null = null;
  let sourceLast: string | null = null;
  const breadthByDate = new Map<string, [number, number][]>();
  for (const record of source.records) {
    const byDate = series.get(record.group);
    if (!byDate && record.group !== BREADTH_GROUP) continue;
    const date = record.date === null ? null : financialDate(record.date);
    if (!date) continue;
    if (!byDate) {
      const rows = breadthByDate.get(date);
      if (rows) rows.push(record.values);
      else breadthByDate.set(date, [record.values]);
      continue;
    }
    if (!sourceFirst || date < sourceFirst) sourceFirst = date;
    if (!sourceLast || date > sourceLast) sourceLast = date;
    const values = byDate.get(date);
    if (values) values.push(record.values[0]);
    else byDate.set(date, [record.values[0]]);
  }

  const breadth = breadthHistory(
    breadthByDate,
    requestedDate,
    source.classificationWarning,
  );
  const dates = new Set<string>();
  for (const byDate of series.values())
    for (const date of byDate.keys())
      if (date <= requestedDate) dates.add(date);
  const ordered = [...dates].sort();
  if (!ordered.length)
    return {
      ...base(requestedDate, breadth),
      state: "no-history",
      sourceFirst,
      sourceLast,
      warning:
        sourceFirst && sourceLast
          ? `本地源覆盖 ${sourceFirst} ~ ${sourceLast}，所选日期及之前没有记录`
          : "本地源没有 SC3/SC4 的有效日期记录",
    };

  const windowDates = ordered.slice(-LIMIT_HISTORY_MAX_DAYS);
  const duplicates: LimitHistoryDuplicate[] = [];
  const points = windowDates.map((date) => ({
    date,
    limitUp: pick(
      series.get(LIMIT_UP_GROUP)!.get(date),
      date,
      "limitUp",
      LIMIT_UP_GROUP,
      duplicates,
    ),
    limitDown: pick(
      series.get(LIMIT_DOWN_GROUP)!.get(date),
      date,
      "limitDown",
      LIMIT_DOWN_GROUP,
      duplicates,
    ),
  }));
  const latest = windowDates.at(-1)!;
  return {
    ...base(requestedDate, breadth),
    state: "ok",
    latest,
    sourceFirst,
    sourceLast,
    window: {
      start: windowDates[0]!,
      end: latest,
      count: windowDates.length,
    },
    points,
    duplicates,
    warning: source.classificationWarning,
    loadedAt: source.loadedAt,
  };
}
