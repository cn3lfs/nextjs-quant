import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readSnapshot, resolveTdxRoot } from "tstdx/local";

/**
 * 宽基 ETF 日度净申赎（读取「国家队指标」本地缓存）。
 *
 * 从 `~/.agent-skills/data/national-team-indicator/state_history.csv` 读取
 * 12 只主流宽基 ETF（沪深300/科创50/创业板/上证50/中证500/1000/A500）
 * 合计净申赎（`合计_f1_yi`，亿元）与核心池（`核心池_f1_yi`，亿元）、
 * 阶段状态（`合计_state`）和力度分（`合计_score`）。
 *
 * 口径保持点位冻结与缺失透明：只采用不晚于当前北京时间日期的最多 60 个记录日；
 * 前导无 ETF 份额时期的空行不计入；有效起点至截止日之间的缺数留空不补零、
 * 不插值；同日重复记录按缺失/歧义处理，不随意挑选其中一条。
 * 只有最近 60 个记录日都存在且全部有效时才给出区间合计，否则只报有效日数。
 *
 * 上证指数优先读取同目录 `kline/sh000001.csv`，不可用时若本地通达信可用则
 * 回退读取 `sh000001.day`；严格按精确同日映射，不跨日填补、不访问网络。
 */
export const ETF_NET_SUBSCRIPTIONS_VERSION = "etf-net-subscriptions-2";
export const ETF_NET_SUBSCRIPTIONS_MAX_DAYS = 60;
export const ETF_NET_INDEX_SYMBOL = "sh000001";
export const ETF_NET_INDEX_NAME = "上证指数";
const SOURCE_NAME = "国家队指标";
const SOURCE_FILENAME = "state_history.csv";
const SOURCE_SCOPE =
  "12只主流宽基 ETF 合计（沪深300/科创50/创业板/上证50/中证500/1000/A500）";

export type EtfNetSubscriptionPoint = {
  date: string;
  /** 12 只宽基 ETF 合计日净申赎（亿元）；同日重复或缺失为 null。 */
  net: number | null;
  /** 7 只汇金核心宽基 ETF 合计日净申赎（亿元）；缺失或重复为 null。 */
  coreNet: number | null;
  /** 国家队指标阶段状态（如 托底期 / 企稳确认 / 反弹期 / 撤退预警 / 观望）。 */
  regime: string | null;
  /** 资金力度分（-100 ~ +100）。 */
  score: number | null;
  /** 上证指数精确同日收盘（点）；同日无数据时为 null。 */
  index: number | null;
};

export type EtfNetSubscriptionSummary = {
  /** 仅最近 60 个记录日齐全且全部有效时的区间合计（亿元）；否则 null。 */
  total: number | null;
  /** 最近 60 个记录日核心池全有效时的区间合计（亿元）；否则 null。 */
  coreTotal: number | null;
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
  /** 指数日线整体最新日期，不受申赎窗口截断。 */
  sourceLast: string | null;
  /** 指数不可用原因；正常时为 null。 */
  warning: string | null;
};

export type EtfNetSubscriptions = {
  version: string;
  /** source-unconfigured：未配置数据目录；no-history：缓存文件或截止日前记录不可用。 */
  state: "ok" | "source-unconfigured" | "no-history";
  source: typeof SOURCE_NAME;
  scope: string;
  filename: string;
  /** 当前北京时间日期，作为采用记录的上限。 */
  requestedDate: string;
  /** 截止日及之前最新的一条记录日。 */
  latest: string | null;
  /** 有效净申赎记录覆盖起点，不受截止日截断。 */
  sourceFirst: string | null;
  /** 有效净申赎记录覆盖终点，不受截止日截断。 */
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

export function resolveNationalTeamDataDir(explicitDir?: string): string {
  if (explicitDir !== undefined) return explicitDir.trim();
  const override = process.env.QUANT_NATIONAL_TEAM_DATA_DIR?.trim();
  if (override) return override;
  const skillsDir = process.env.QUANT_SKILLS_DIR?.trim();
  if (skillsDir)
    return join(dirname(skillsDir), "data", "national-team-indicator");
  return join(homedir(), ".agent-skills", "data", "national-team-indicator");
}

function base(requestedDate: string): Omit<EtfNetSubscriptions, "state"> {
  return {
    version: ETF_NET_SUBSCRIPTIONS_VERSION,
    source: SOURCE_NAME,
    scope: SOURCE_SCOPE,
    filename: SOURCE_FILENAME,
    requestedDate,
    latest: null,
    sourceFirst: null,
    sourceLast: null,
    window: null,
    points: [],
    duplicates: [],
    summary: { total: null, coreTotal: null, valid: 0, complete: false },
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

/** 按北京时间取自然日，不依赖进程本地时区。 */
function beijingToday(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function finiteOrNull(raw: string | undefined): number | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

type ParsedRow = {
  date: string;
  net: number | null;
  coreNet: number | null;
  regime: string | null;
  score: number | null;
};

function parseStateHistoryCsv(text: string): ParsedRow[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (!lines.length) return [];

  const headers = lines[0]!.split(",").map((col) => col.trim());
  const idxDate = headers.indexOf("date");
  const idxNet = headers.indexOf("合计_f1_yi");
  if (idxDate === -1 || idxNet === -1)
    throw new Error(
      `国家队指标 ${SOURCE_FILENAME} 缺少必须列（date / 合计_f1_yi）`,
    );

  const idxState = headers.indexOf("合计_state");
  const idxScore = headers.indexOf("合计_score");
  const idxCoreNet = headers.indexOf("核心池_f1_yi");

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(",");
    const date = cols[idxDate]?.trim() ?? "";
    if (!isIsoDate(date)) continue;
    const stateText = idxState >= 0 ? cols[idxState]?.trim() || null : null;
    rows.push({
      date,
      net: finiteOrNull(cols[idxNet]),
      coreNet: idxCoreNet >= 0 ? finiteOrNull(cols[idxCoreNet]) : null,
      regime: stateText,
      score: idxScore >= 0 ? finiteOrNull(cols[idxScore]) : null,
    });
  }
  return rows;
}

async function readIndexClosesFromCsv(
  dataDir: string,
): Promise<{ closes: Map<string, number>; sourceLast: string | null }> {
  const closes = new Map<string, number>();
  let sourceLast: string | null = null;
  try {
    const text = await readFile(
      join(dataDir, "kline", `${ETF_NET_INDEX_SYMBOL}.csv`),
      "utf8",
    );
    const lines = text
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    if (!lines.length) return { closes, sourceLast };
    const headers = lines[0]!.split(",").map((col) => col.trim());
    const idxDate = headers.indexOf("date");
    const idxClose = headers.indexOf("close");
    if (idxDate === -1 || idxClose === -1) return { closes, sourceLast };
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i]!.split(",");
      const date = cols[idxDate]?.trim() ?? "";
      const close = finiteOrNull(cols[idxClose]);
      if (!isIsoDate(date) || close === null) continue;
      closes.set(date, close);
      if (!sourceLast || date > sourceLast) sourceLast = date;
    }
  } catch {
    return { closes, sourceLast };
  }
  return { closes, sourceLast };
}

/** 指数只做减法退让：先读同目录 kline CSV，缺失日期再补充本地通达信日线；失败不影响净申赎。 */
async function readIndex(
  dataDir: string,
  tdxRoot: string,
): Promise<{
  status: EtfNetIndexStatus;
  closes: Map<string, number>;
}> {
  const fromCsv = await readIndexClosesFromCsv(dataDir);
  const closes = new Map(fromCsv.closes);
  let sourceLast = fromCsv.sourceLast;

  if (tdxRoot.trim()) {
    try {
      resolveTdxRoot(tdxRoot);
      const snapshot = await readSnapshot(tdxRoot, ETF_NET_INDEX_SYMBOL, "day");
      for (const bar of snapshot.bars) {
        if (!closes.has(bar.date) && Number.isFinite(bar.close)) {
          closes.set(bar.date, bar.close);
        }
        if (!sourceLast || bar.date > sourceLast) sourceLast = bar.date;
      }
    } catch {
      // 本地 TDX 不可用时不阻断指数展示（若 CSV 已加载）或优雅降级。
    }
  }

  if (closes.size > 0) {
    return {
      status: {
        symbol: ETF_NET_INDEX_SYMBOL,
        name: ETF_NET_INDEX_NAME,
        state: "ok",
        matched: 0,
        sourceLast,
        warning: null,
      },
      closes,
    };
  }

  return {
    status: {
      symbol: ETF_NET_INDEX_SYMBOL,
      name: ETF_NET_INDEX_NAME,
      state: "unavailable",
      matched: 0,
      sourceLast: null,
      warning: "本地上证指数日线不可用，仅显示净申赎",
    },
    closes,
  };
}

export async function etfNetSubscriptions(
  tdxRoot: string,
  asOf: string = beijingToday(),
  explicitDataDir?: string,
): Promise<EtfNetSubscriptions> {
  const dataDir = resolveNationalTeamDataDir(explicitDataDir);
  if (!dataDir)
    return {
      ...base(asOf),
      state: "source-unconfigured",
      warning: "国家队指标缓存目录未配置",
    };

  let text: string;
  try {
    text = await readFile(join(dataDir, SOURCE_FILENAME), "utf8");
  } catch (error) {
    if (missingFile(error))
      return {
        ...base(asOf),
        state: "no-history",
        warning: `未找到国家队指标缓存文件（${SOURCE_FILENAME}）`,
      };
    throw error;
  }

  const loadedAt = Date.now();
  const parsed = parseStateHistoryCsv(text);

  // 只把有有效净申赎数字的最早/最晚日作为源覆盖起止，跳过 ETF 份额尚不存在的前导空行。
  let sourceFirst: string | null = null;
  let sourceLast: string | null = null;
  for (const row of parsed) {
    if (row.net === null) continue;
    if (!sourceFirst || row.date < sourceFirst) sourceFirst = row.date;
    if (!sourceLast || row.date > sourceLast) sourceLast = row.date;
  }

  if (!sourceFirst || !sourceLast)
    return {
      ...base(asOf),
      state: "no-history",
      loadedAt,
      warning: `本地 ${SOURCE_FILENAME} 尚无有效宽基 ETF 净申赎记录`,
    };

  // 同日可能出现多行（例如手工合并异常）；全部保留以检测歧义，不挑选其中一条。
  const byDate = new Map<string, ParsedRow[]>();
  for (const row of parsed) {
    if (row.date < sourceFirst || row.date > sourceLast) continue;
    const list = byDate.get(row.date);
    if (list) list.push(row);
    else byDate.set(row.date, [row]);
  }

  const dates = [...byDate.keys()].filter((date) => date <= asOf).sort();
  if (!dates.length)
    return {
      ...base(asOf),
      state: "no-history",
      sourceFirst,
      sourceLast,
      loadedAt,
      warning: `国家队指标缓存覆盖 ${sourceFirst} ~ ${sourceLast}，所选截止日及之前没有记录`,
    };

  const windowDates = dates.slice(-ETF_NET_SUBSCRIPTIONS_MAX_DAYS);
  const duplicates: EtfNetSubscriptions["duplicates"] = [];
  const points: EtfNetSubscriptionPoint[] = windowDates.map((date) => {
    const entries = byDate.get(date)!;
    if (entries.length > 1) {
      duplicates.push({ date, count: entries.length });
      return {
        date,
        net: null,
        coreNet: null,
        regime: null,
        score: null,
        index: null,
      };
    }
    const row = entries[0]!;
    return {
      date,
      net: row.net,
      coreNet: row.coreNet,
      regime: row.regime,
      score: row.score,
      index: null,
    };
  });

  const { status: index, closes } = await readIndex(dataDir, tdxRoot);
  // 严格精确同日匹配，不跨日借用相邻收盘价。
  for (const point of points) point.index = closes.get(point.date) ?? null;
  index.matched = points.filter((point) => point.index !== null).length;

  const valid = points.filter((point) => point.net !== null).length;
  const complete =
    windowDates.length === ETF_NET_SUBSCRIPTIONS_MAX_DAYS &&
    valid === ETF_NET_SUBSCRIPTIONS_MAX_DAYS;
  const total = complete
    ? points.reduce((sum, point) => sum + (point.net ?? 0), 0)
    : null;
  const coreComplete =
    complete && points.every((point) => point.coreNet !== null);
  const coreTotal = coreComplete
    ? points.reduce((sum, point) => sum + (point.coreNet ?? 0), 0)
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
    summary: { total, coreTotal, valid, complete },
    index,
    warning: null,
    loadedAt,
  };
}
