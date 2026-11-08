import { readTdxBlockDefinitionNames } from "tstdx/local";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseFinancialSeries } from "tstdx";
import {
  financialDate,
  financialAvailableFrom,
  financialMappingVersion,
  projectFinancialFields,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
import { readTdxLocalBlocks } from "tstdx/local";
import { securityNames, isAStock } from "tstdx/local";
import {
  fullLocalCalendarReference,
  type CalendarReference,
} from "../../market/data-health";

import {
  financialDirectory,
  financialPackage,
  packageRecord,
  readStableFinancialFile,
  listFinancialReports,
} from "tstdx/local";
export {
  financialDirectory,
  financialPackage,
  packageRecord,
  readStableFinancialFile,
  listFinancialReports,
} from "tstdx/local";
type Context = {
  blockCodes: Set<string>;
  financialSymbols: Set<string>;
  classifiedSymbols: Set<string>;
  namedFunds: Set<string>;
  warning: string | null;
};
const contexts = new Map<string, { at: number; value: Context }>();
export async function financialContext(root: string): Promise<Context> {
  const cached = contexts.get(root);
  if (cached && Date.now() - cached.at < 30000) return cached.value;
  const value: Context = {
    blockCodes: new Set(),
    financialSymbols: new Set(),
    classifiedSymbols: new Set(),
    namedFunds: new Set(),
    warning: null,
  };
  for (const market of ["sh", "sz", "bj"])
    for (const [symbol, name] of await securityNames(root, market)) {
      if (/ETF|基金|LOF|REIT/i.test(name)) value.namedFunds.add(symbol);
      if (/^sh88\d{4}$/.test(symbol)) value.blockCodes.add(symbol);
    }
  try {
    const source = await readTdxLocalBlocks(root);
    for (const block of source.blocks) {
      if (block.code) value.blockCodes.add(`sh${block.code}`);
      if (block.category === "industry")
        for (const member of block.members) {
          value.classifiedSymbols.add(member);
          if (/银行|保险|证券|多元金融/.test(block.name))
            value.financialSymbols.add(member);
        }
    }
    // Include region/style definitions for file classification, without changing RPS eligibility.
    for (const code of (await readTdxBlockDefinitionNames(root)).keys())
      value.blockCodes.add(`sh${code}`);
  } catch (error) {
    value.warning = `行业/板块主档不可用：${error instanceof Error ? error.message : String(error)}`;
  }
  contexts.set(root, { at: Date.now(), value });
  if (contexts.size > 4) contexts.delete(contexts.keys().next().value!);
  return value;
}
export function financialFileKind(
  symbol: string,
  context: Context,
): "GP" | "BK" | "SC" | "unknown" {
  if (symbol === "sh999999") return "SC";
  if (context.blockCodes.has(symbol)) return "BK";
  if (context.namedFunds.has(symbol)) return "GP";
  if (
    /^(sh(?:60|68|50|51|52|56|58)\d{4}|sz(?:00|30|15|16)\d{4}|bj\d{6})$/.test(
      symbol,
    )
  )
    return "GP";
  return "unknown";
}
type HistoryOptions = {
  limit?: number;
  reportDate?: string;
  asOf?: string;
  strict?: boolean;
  signal?: AbortSignal;
  calendar?: CalendarReference;
};
async function financialCalendar(root: string): Promise<CalendarReference> {
  try {
    return await fullLocalCalendarReference(root, []);
  } catch (error) {
    return {
      days: [],
      hash: null,
      source: error instanceof Error ? error.message : String(error),
    };
  }
}
const signature = (info: import("node:fs").BigIntStats) =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.birthtimeNs}`;
type HistoryResult = Awaited<ReturnType<typeof readFinancialHistoryUncached>>;
const historyCache = new Map<
  string,
  { signature: string; value: HistoryResult; bytes: number }
>();
async function reportDirectorySignature(root: string) {
  const names = await listFinancialReports(root);
  return (
    await Promise.all(
      names.map(
        async (name) =>
          `${name}:${signature(await stat(resolve(financialDirectory(root), name), { bigint: true }))}`,
      ),
    )
  ).join("|");
}
export async function readLocalFinancialHistory(
  root: string,
  symbol: string,
  options: HistoryOptions = {},
) {
  options = {
    ...options,
    asOf:
      options.asOf ??
      new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
  };
  options.signal?.throwIfAborted();
  if (options.strict && !options.calendar)
    options.calendar = await financialCalendar(root);
  const context = await financialContext(root);
  const key = JSON.stringify([
    resolve(root),
    symbol,
    options.limit ?? 12,
    options.reportDate,
    options.asOf,
    options.strict ?? false,
    options.calendar?.hash,
    context.classifiedSymbols.has(symbol)
      ? context.financialSymbols.has(symbol)
      : null,
    context.warning,
  ]);
  const before = await reportDirectorySignature(root),
    hit = historyCache.get(key);
  if (hit?.signature === before) {
    historyCache.delete(key);
    historyCache.set(key, hit);
    return structuredClone(hit.value);
  }
  const value = await readFinancialHistoryUncached(root, symbol, options);
  if (before !== (await reportDirectorySignature(root)))
    throw new Error("读取期间财务目录更新，请重试");
  const bytes = value.reports.reduce(
    (sum, report) => sum + report.fields.length * 280 + 1024,
    0,
  );
  historyCache.delete(key);
  let total = [...historyCache.values()].reduce(
    (sum, item) => sum + item.bytes,
    0,
  );
  for (const [old, item] of historyCache) {
    if (total + bytes <= 32 * 1024 * 1024 && historyCache.size < 8) break;
    historyCache.delete(old);
    total -= item.bytes;
  }
  if (bytes <= 32 * 1024 * 1024)
    historyCache.set(key, { signature: before, value, bytes });
  return structuredClone(value);
}
async function readFinancialHistoryUncached(
  root: string,
  symbol: string,
  options: HistoryOptions = {},
) {
  if (!/^(sh|sz|bj)\d{6}$/.test(symbol)) throw new Error("财务证券代码非法");
  // DAT indexes carry only six digits: SH000001 must never read SZ000001's bank report.
  if (!isAStock(symbol))
    return {
      symbol,
      reports: [] as FinancialReportSnapshot[],
      issues: [] as { filename: string; reason: string }[],
      financialCompany: null,
      version: financialMappingVersion,
      warning:
        "该标的不是A股公司，请查看对应股票/板块/市场序列；不按六位代码借用其他市场公司的财报",
    };
  const context = await financialContext(root);
  const financialCompany = context.classifiedSymbols.has(symbol)
    ? context.financialSymbols.has(symbol)
    : null;
  const reports: FinancialReportSnapshot[] = [],
    issues: { filename: string; reason: string }[] = [];
  if (options.strict && !options.calendar?.days.length)
    issues.push({
      filename: "sh000001.day",
      reason:
        "严格财务时点缺少可验证的本地交易日期，相关报告不取得历史使用资格",
    });
  const limit = options.limit ?? 12;
  const names = await listFinancialReports(root);
  for (const name of names) {
    options.signal?.throwIfAborted();
    const period = financialDate(Number(name.slice(4, 12)));
    if (
      !period ||
      (options.reportDate && period > options.reportDate) ||
      (options.asOf && period > options.asOf)
    )
      continue;
    try {
      const file = await financialPackage(root, name);
      if (file.index.status === "placeholder") {
        issues.push({ filename: name, reason: "未下载或未来报告期空占位包" });
        continue;
      }
      const row = packageRecord(file, symbol.slice(2));
      if (!row) continue;
      const announcementDate = financialDate(
        row.values[313] ?? 0,
        Number(period.slice(0, 4)),
      );
      const availableFrom = options.strict
        ? financialAvailableFrom(announcementDate, options.calendar?.days ?? [])
        : undefined;
      if (announcementDate && options.asOf && announcementDate > options.asOf)
        continue;
      if (
        options.strict &&
        (!announcementDate ||
          announcementDate <= period ||
          !availableFrom ||
          availableFrom > options.asOf! ||
          !options.asOf ||
          announcementDate >= options.asOf)
      )
        continue;
      const warnings: string[] = [];
      if (!announcementDate || announcementDate <= period)
        warnings.push("财报公告日期缺失或可疑，禁止严格历史时点使用");
      if (context.warning) warnings.push(context.warning);
      const [assets, liabilities, equity] = [
        row.values[39],
        row.values[62],
        row.values[71],
      ];
      if (
        assets !== undefined &&
        liabilities !== undefined &&
        equity !== undefined &&
        Math.abs(assets - liabilities - equity) >
          Math.max(1, Math.abs(assets), Math.abs(liabilities + equity)) * 1e-5
      )
        warnings.push(
          "源报表总资产与总负债+总权益存在差异；保留原值，未自动修正",
        );
      reports.push({
        symbol,
        financialCompany,
        reportDate: period,
        announcementDate,
        ...(options.strict
          ? {
              availableFrom,
              calendar: {
                hash: options.calendar?.hash ?? null,
                source: options.calendar?.source ?? "交易日历缺失",
              },
            }
          : {}),
        sourceFilename: name,
        sourceSha256: file.index.sourceSha256,
        contentSha256: file.index.contentSha256,
        recordOffset: row.offset,
        mappingVersion: financialMappingVersion,
        fields: projectFinancialFields(
          row.values,
          financialCompany,
          undefined,
          +period.slice(0, 4),
        ),
        warnings,
      });
      if (reports.length >= limit) break;
    } catch (error) {
      issues.push({
        filename: name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    // Yield between files, including cache hits, so cancellation is observable.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return {
    symbol,
    reports,
    issues,
    financialCompany,
    version: financialMappingVersion,
    warning:
      "当前下载版本可能含后续修订；未认证首次披露版本。预告快报有独立目标期与公开时间。",
  };
}
export async function readLocalFinancialSeries(root: string, symbol: string) {
  if (!/^(sh|sz|bj)\d{6}$/.test(symbol))
    throw new Error("财务序列证券代码非法");
  const context = await financialContext(root),
    namespace = financialFileKind(symbol, context);
  const filename = `gp${symbol}.dat`;
  const source = await readStableFinancialFile(
    resolve(financialDirectory(root), filename),
  );
  return {
    filename,
    namespace,
    loadedAt: source.loadedAt,
    ...parseFinancialSeries(source.body),
    classificationWarning:
      namespace === "unknown"
        ? "无法按本地主档确认文件类别，保留原组号和值但不作业务解释"
        : context.warning,
  };
}

/** Scan each period once for the whole pool, retaining only explicitly needed cells. */
export async function readFinancialPoolHistory(
  root: string,
  symbols: readonly string[],
  options: {
    asOf: string;
    strict: boolean;
    limit: number;
    fieldIds: number[];
    signal?: AbortSignal;
    progress?: (done: number, total: number) => void;
  },
) {
  const context = await financialContext(root),
    names = await listFinancialReports(root);
  const calendar = options.strict ? await financialCalendar(root) : null;
  const reports = new Map<string, FinancialReportSnapshot[]>(
    symbols.map((symbol) => [symbol, []]),
  );
  const issues: { filename: string; reason: string }[] = [];
  if (options.strict && !calendar?.days.length)
    issues.push({
      filename: "sh000001.day",
      reason:
        "严格财务时点缺少可验证的本地交易日期，相关报告不取得历史使用资格",
    });
  const slots = [...new Set(options.fieldIds)].map((id) => id - 1);
  for (let i = 0; i < names.length; i++) {
    options.signal?.throwIfAborted();
    const name = names[i]!,
      period = financialDate(Number(name.slice(4, 12)));
    if (!period || period > options.asOf) continue;
    try {
      const file = await financialPackage(root, name);
      if (file.index.status === "placeholder") continue;
      for (let j = 0; j < symbols.length; j++) {
        const symbol = symbols[j]!,
          history = reports.get(symbol)!;
        if (!isAStock(symbol)) continue;
        if (history.length >= options.limit) continue;
        let row: ReturnType<typeof packageRecord>;
        try {
          row = packageRecord(file, symbol.slice(2));
        } catch (error) {
          issues.push({
            filename: name,
            reason: `${symbol}: ${error instanceof Error ? error.message : String(error)}`,
          });
          continue;
        }
        if (!row) continue;
        const announcementDate = financialDate(
          row.values[313] ?? 0,
          +period.slice(0, 4),
        );
        const availableFrom = options.strict
          ? financialAvailableFrom(announcementDate, calendar?.days ?? [])
          : undefined;
        if (
          options.strict &&
          (!announcementDate ||
            announcementDate <= period ||
            !availableFrom ||
            availableFrom > options.asOf ||
            announcementDate >= options.asOf)
        )
          continue;
        if (announcementDate && announcementDate > options.asOf) continue;
        const financialCompany = context.classifiedSymbols.has(symbol)
          ? context.financialSymbols.has(symbol)
          : null;
        history.push({
          symbol,
          financialCompany,
          reportDate: period,
          announcementDate,
          ...(options.strict
            ? {
                availableFrom,
                calendar: {
                  hash: calendar?.hash ?? null,
                  source: calendar?.source ?? "交易日历缺失",
                },
              }
            : {}),
          sourceFilename: name,
          sourceSha256: file.index.sourceSha256,
          contentSha256: file.index.contentSha256,
          recordOffset: row.offset,
          mappingVersion: financialMappingVersion,
          fields: projectFinancialFields(
            row.values,
            financialCompany,
            slots,
            +period.slice(0, 4),
          ),
          warnings: [],
        });
        if (j % 200 === 0)
          await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      issues.push({
        filename: name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    options.progress?.(i + 1, names.length);
    if (
      [...reports.values()].every((history) => history.length >= options.limit)
    )
      break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { reports, issues };
}
