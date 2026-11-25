import { realpathSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { setImmediate as yieldToReaders } from "node:timers/promises";
import { z } from "zod";
import { financialDate } from "tstdx/financial-model";
import {
  financialDirectory,
  parseFinancialSeries,
  readLocalTradingDates,
} from "tstdx/local";
import { completedBarFilter } from "~/lib/completed-bars";
import { readEtfSubscriptionHistory } from "./etf-net-subscriptions";
import { openMarketPanel, type MarketPanelHandle } from "./market-panel";
import { daySchema, idSchema } from "./market-panel/format";

export const marketIndicatorInput = z
  .object({ asOf: daySchema.optional(), snapshotId: idSchema.optional() })
  .optional();
export type MarketIndicatorQuery = NonNullable<
  z.infer<typeof marketIndicatorInput>
> & { tdxRoot?: string };
export type TemperatureSession = {
  date: string;
  complete: boolean;
  breadth: number | null;
  trend: number | null;
  limitUp: number | null;
  highestStreak: number | null;
  turnoverCny: number | null;
  etfNet5Yi: number | null;
  advancing: number;
  breadthSample: number;
  aboveTrend: number;
  trendSample: number;
  turnoverSample: number;
};

export type MarketReadContext = {
  root: string;
  asOf: string;
  now: number;
  dates: string[];
  panel: MarketPanelHandle | null;
  calendarSource: string;
  warnings: string[];
};

export function effectiveMarketPanelRoot(configuredRoot?: string): string {
  return (
    configuredRoot?.trim() || process.env.TDX_ROOT?.trim() || "E:/new_tdx64"
  );
}

function fileErrorCode(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error)
    return error.code;
  const message = error instanceof Error ? error.message : error;
  return typeof message === "string"
    ? /^(ENOENT|EACCES|EPERM|EISDIR)\b/.exec(message)?.[1]
    : undefined;
}

export function sanitizeMarketWarning(prefix: string, error: unknown): string {
  switch (fileErrorCode(error)) {
    case "ENOENT":
      return prefix + "：缺少本地数据文件。";
    case "EACCES":
    case "EPERM":
      return prefix + "：没有读取本地数据的权限。";
    case "EISDIR":
      return prefix + "：所选数据文件实际为目录。";
    default:
      return prefix + "：本地数据读取失败。";
  }
}

// Each request owns and closes one immutable handle. The pointer is read once;
// an absent panel never triggers discovery, construction or BarStore.
export async function withMarketReadContext<T>(
  query: MarketIndicatorQuery,
  read: (ctx: MarketReadContext) => Promise<T>,
) {
  const now = Date.now();
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const asOf = query.asOf && query.asOf < today ? query.asOf : today;
  let root = effectiveMarketPanelRoot(query.tdxRoot);
  const warnings: string[] = [];
  let handle: MarketPanelHandle | undefined;
  let panel: MarketPanelHandle | null = null;
  try {
    try {
      handle = openMarketPanel(query.snapshotId, root);
      if (relative(realpathSync.native(root), handle.manifest.root) === "") {
        root = handle.manifest.root;
        panel = handle;
      } else {
        warnings.push("冻结面板不可用：面板来源与所选通达信目录不一致。");
      }
    } catch (error) {
      if (fileErrorCode(error) === "ENOENT") {
        if (handle) warnings.push("冻结面板来源的通达信目录不存在。");
        else if (query.snapshotId !== undefined)
          warnings.push("指定的冻结行情面板不存在或已被清理。");
        else
          warnings.push(
            "本地冻结行情面板尚未生成，市场宽度/趋势/成交额与行业成员下钻暂缺；点击「生成冻结面板」从本地通达信日线构建。",
          );
      } else {
        warnings.push(sanitizeMarketWarning("冻结面板不可用", error));
      }
    }
    let reference: string[] = [];
    try {
      reference = (await readLocalTradingDates(root)).days;
    } catch (error) {
      warnings.push(sanitizeMarketWarning("上证指数交易日参考不可用", error));
    }
    const dates = [...new Set([...reference, ...(panel?.manifest.dates ?? [])])]
      .filter((d) => d <= asOf && isWeekday(d))
      .sort();
    const calendarSource =
      "本地 sh000001 已有日线与冻结面板交易日并集；无开闭市证据的工作日未知。收盘采用北京时间 15:05。";
    return await read({
      root,
      panel,
      now,
      asOf,
      dates,
      calendarSource,
      warnings,
    });
  } finally {
    handle?.close();
  }
}

export const shiftDate = (date: string, offset: number) =>
  new Date(Date.parse(date) + offset * 86400000).toISOString().slice(0, 10);
export const isWeekday = (date: string) => {
  const day = new Date(date).getUTCDay();
  return day > 0 && day < 6;
};

// No absence of a quotation is proof of an exchange holiday.
export function adjacentSessions(previous: string, date: string) {
  let next = shiftDate(previous, 1);
  while (!isWeekday(next)) next = shiftDate(next, 1);
  return next === date;
}

/** Read a stable local generation without populating shared TDX caches. */
export async function readIndicatorSource(path: string) {
  let handle;
  try {
    handle = await open(path, "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 64n * 1024n * 1024n)
      throw new Error("本地指标文件类型或大小非法");
    const body = await handle.readFile();
    const after = await stat(path, { bigint: true });
    if (
      BigInt(body.length) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("读取期间本地指标文件已更新");
    return body;
  } finally {
    await handle?.close();
  }
}

async function limitHistory(root: string, asOf: string) {
  const counts = new Map<string, number | null>();
  const heights = new Map<string, number | null>();
  const file = await readIndicatorSource(
    join(financialDirectory(root), "gpsh999999.dat"),
  );
  const parsed = parseFinancialSeries(file);
  for (const row of parsed.records) {
    if (row.group !== 24 && row.group !== 30) continue;
    const date = financialDate(row.date ?? 0);
    if (!date || date > asOf) continue;
    const series = row.group === 24 ? counts : heights;
    const value = row.values[0];
    series.set(
      date,
      !series.has(date) && Number.isSafeInteger(value) && value >= 0
        ? value
        : null,
    );
  }
  return { counts, heights, sha256: parsed.sourceSha256 };
}

/** Sliding sum of the last 20/60 consecutive valid adjusted closes, by stock. */
function stockInputs(panel: MarketPanelHandle | null) {
  const symbols = panel?.manifest.symbols ?? [];
  const stocks = symbols.flatMap((s, i) => (s.kind === "stock" ? [i] : []));
  const panelDates = new Set(panel?.manifest.dates);
  const width = symbols.length;
  const ring = new Float64Array(width * 60);
  const runs = new Uint8Array(width),
    sum20 = new Float64Array(width),
    sum60 = new Float64Array(width);
  let cursor = 0;
  return (date: string) => {
    const row = panelDates.has(date) ? panel!.crossSection(date) : null;
    let advancing = 0,
      breadthSample = 0,
      aboveTrend = 0,
      trendSample = 0,
      turnoverSample = 0,
      amount = 0;
    let missingAmount = false;
    for (const i of stocks) {
      const traded = row !== null && row.volume[i]! > 0;
      const close = traded ? row.closeAtoms[i]! : NaN;
      if (traded) {
        const previous = row.prevCloseAtoms[i]!;
        if (row.valid[i] && previous > 0 && close > 0) {
          breadthSample++;
          if (close > previous) advancing++;
        }
        if (Number.isFinite(row.amount[i]) && row.amount[i]! > 0) {
          amount += row.amount[i]!;
          turnoverSample++;
        } else missingAmount = true;
      }
      const adjusted = traded && row.valid[i] ? close * row.adjFactor[i]! : NaN;
      if (!(adjusted > 0 && Number.isFinite(adjusted))) {
        runs[i] = 0;
        sum20[i] = sum60[i] = 0;
        continue;
      }
      const run = runs[i]!;
      const slot = cursor * width + i;
      sum20[i] =
        sum20[i]! +
        adjusted -
        (run >= 20 ? ring[((cursor + 40) % 60) * width + i]! : 0);
      sum60[i] = sum60[i]! + adjusted - (run >= 60 ? ring[slot]! : 0);
      ring[slot] = adjusted;
      runs[i] = Math.min(60, run + 1);
      if (runs[i] === 60) {
        trendSample++;
        if (adjusted > sum20[i]! / 20 && sum20[i]! / 20 > sum60[i]! / 60)
          aboveTrend++;
      }
    }
    cursor = (cursor + 1) % 60;
    return {
      advancing,
      breadthSample,
      aboveTrend,
      trendSample,
      turnoverSample,
      breadth: breadthSample ? advancing / breadthSample : null,
      trend: trendSample ? aboveTrend / trendSample : null,
      turnoverCny: turnoverSample && !missingAmount ? amount : null,
    };
  };
}

export async function readTemperatureSessions(ctx: MarketReadContext) {
  const [limit, etf] = await Promise.allSettled([
    limitHistory(ctx.root, ctx.asOf),
    readEtfSubscriptionHistory(ctx.asOf),
  ]);
  if (limit.status === "rejected")
    ctx.warnings.push(sanitizeMarketWarning("SC24/SC30 不可用", limit.reason));
  if (etf.status === "rejected")
    ctx.warnings.push(
      sanitizeMarketWarning("本地 ETF 净申赎序列不可用", etf.reason),
    );
  else if (!etf.value.daily.size)
    ctx.warnings.push("本地 ETF 净申赎序列不可用");
  const computeStocks = stockInputs(ctx.panel);
  const complete = completedBarFilter("day", ctx.now);
  const sessions: TemperatureSession[] = [];
  const flows: (number | null)[] = [];
  for (const [i, date] of ctx.dates.entries()) {
    if (i % 32 === 0) await yieldToReaders();
    flows.push(
      etf.status === "fulfilled" ? (etf.value.daily.get(date) ?? null) : null,
    );
    if (flows.length > 5) flows.shift();
    sessions.push({
      date,
      complete: complete(date),
      ...computeStocks(date),
      limitUp:
        limit.status === "fulfilled"
          ? (limit.value.counts.get(date) ?? null)
          : null,
      highestStreak:
        limit.status === "fulfilled"
          ? (limit.value.heights.get(date) ?? null)
          : null,
      etfNet5Yi:
        flows.length === 5 && flows.every((v): v is number => v !== null)
          ? flows.reduce((sum, v) => sum + v, 0)
          : null,
    });
  }
  return {
    sessions,
    sentimentSha256: limit.status === "fulfilled" ? limit.value.sha256 : null,
    etfSha256: etf.status === "fulfilled" ? etf.value.sha256 : null,
  };
}
