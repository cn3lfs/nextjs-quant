import { projectFinancialSummary } from "tstdx/financial-model";
import { readStableLocalFile, isAStock } from "tstdx/local";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseFinancialReport } from "tstdx";
import type { ReportFields } from "~/lib/market/tdx-fundamentals";

/**
 * 基本面的主数据源是本地专业财务包 `vipdoc/cw/gpcw<YYYYMMDD>.dat`：包头写明报告期，
 * 读盘即得，不依赖公共服务器。协议 7709 的 `finance` 快照只作叠加——它不带报告期
 * （实测 `updatedDate` 是快照更新日，20260815 / 20260828 / 20260914 等均非季末），
 * 字段也只有 30 个。
 *
 * 字段含义以官方专业财务定义为准。协议数值相等不证明协议旧字段名正确。
 */
export type LocalFinanceField = keyof ReturnType<
  typeof projectFinancialSummary
>;
/**
 * 财务包里没有对应值的协议字段，本地不提供：
 * `totalCashFlow` 在 584 个槽位里找不到等值项；
 */
export const localUnavailableFields = ["totalCashFlow"] as const;

/** float32 只有约 7 位有效数字，逐位相等不可能；这是同一数值的判定阈值。 */
const matchTolerance = 2e-6;
/** 只回溯最近这么多期：报告期一定在最近几期内，全量解析既慢又没有额外证据。 */
const searchPeriods = 8;

export type FinanceReportPeriod = {
  /** 报告期 YYYY-MM-DD，来自财务包包头，不是快照更新日。 */
  reportDate: string;
  sourceFilename: string;
  sourceSha256: string;
};
export type FinanceReportPeriodResult = {
  period: FinanceReportPeriod | null;
  reason: string | null;
  /** 实际参与比对的报告期，用于说明判定范围。 */
  searched: string[];
};
export type FinanceMatchInput = {
  totalAssets: number;
  mainRevenue: number;
  netProfit: number;
};
export type LocalFinancials = {
  reportDate: string;
  sourceFilename: string;
  sourceSha256: string;
  fields: ReportFields;
};
export type LocalFinancialsResult = {
  financials: LocalFinancials | null;
  reason: string | null;
};

type ReportDigest = {
  reportDate: number;
  sourceSha256: string;
  /** 证券代码 → 本模块用到的字段，整包记录解析后即丢弃。 */
  values: Map<string, ReportFields>;
};

/**
 * 按文件路径缓存压缩后的摘要。键含 mtime 与大小，包更新即失效；
 * 条目数受 `searchPeriods` 限制，不会无限增长；进程退出即释放，无需清理动作。
 */
const digests = new Map<string, { key: string; digest: ReportDigest }>();

export const financialReportDirectory = (root: string) =>
  resolve(root, "vipdoc", "cw");

async function loadDigest(path: string): Promise<ReportDigest> {
  const source = await readStableLocalFile(path);
  const key = source.key;
  const cached = digests.get(path);
  if (cached?.key === key) return cached.digest;
  const report = parseFinancialReport(source.body);
  if (report.status === "placeholder")
    throw new Error("未下载或未来期空占位财务包");
  const values = new Map<string, ReportFields>();
  for (const record of report.records) {
    const row = projectFinancialSummary(record.values);
    values.set(record.code, row);
  }
  const digest: ReportDigest = {
    reportDate: report.reportDate,
    sourceSha256: report.sourceSha256,
    values,
  };
  digests.set(path, { key, digest });
  while (digests.size > searchPeriods)
    digests.delete(digests.keys().next().value!);
  return digest;
}

const same = (quoted: number, reported: number) =>
  Number.isFinite(quoted) &&
  Number.isFinite(reported) &&
  (quoted === reported ||
    (reported !== 0 && Math.abs(quoted / reported - 1) <= matchTolerance));

const formatDate = (value: number) =>
  `${String(value).slice(0, 4)}-${String(value).slice(4, 6)}-${String(value).slice(6, 8)}`;

/** 列出最近的财务包，按报告期从新到旧。 */
async function recentReports(root: string) {
  const directory = financialReportDirectory(root);
  const entries = await readdir(directory);
  return entries
    .filter((name) => /^gpcw\d{8}\.dat$/i.test(name))
    .sort()
    .reverse()
    .slice(0, searchPeriods)
    .map((name) => ({ name, path: resolve(directory, name) }));
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * 读取该证券最近一期可用的本地财务数据。这是基本面的主源：不发网络请求，
 * 报告期来自包头。未来期占位包解析失败时继续回退到更早的一期。
 */
export async function readLocalFinancials(
  root: string,
  symbol: string,
): Promise<LocalFinancialsResult> {
  if (!isAStock(symbol))
    return {
      financials: null,
      reason: "该标的不是A股公司，不能按六位代码借用其他市场财报",
    };
  const code = symbol.slice(2);
  let reports: { name: string; path: string }[];
  try {
    reports = await recentReports(root);
  } catch (error) {
    return {
      financials: null,
      reason: `读取本地财务包目录失败：${describe(error)}`,
    };
  }
  const skipped: string[] = [];
  for (const report of reports) {
    let digest: ReportDigest;
    try {
      digest = await loadDigest(report.path);
    } catch (error) {
      skipped.push(`${report.name}（${describe(error)}）`);
      continue;
    }
    const fields = digest.values.get(code);
    if (!fields) continue;
    return {
      financials: {
        reportDate: formatDate(digest.reportDate),
        sourceFilename: report.name,
        sourceSha256: digest.sourceSha256,
        fields,
      },
      reason: null,
    };
  }
  const note = skipped.length ? `；已跳过 ${skipped.join("、")}` : "";
  return {
    financials: null,
    reason: reports.length
      ? `最近 ${reports.length} 期本地财务包都没有该证券的记录${note}`
      : `本地通达信目录没有 gpcw 财务包${note}`,
  };
}

/**
 * 把一份协议财务快照定位到本地财务包的某个报告期。
 *
 * 命中必须唯一：命中零个说明本地没有对应期，命中多个说明这三个金额无法区分
 * （例如全为 0 的空记录）。两种情况都返回 null 和原因，不挑一个最近的充数。
 */
export async function resolveFinanceReportPeriod(
  root: string,
  symbol: string,
  finance: FinanceMatchInput,
): Promise<FinanceReportPeriodResult> {
  if (!isAStock(symbol))
    return {
      period: null,
      searched: [],
      reason: "该标的不是A股公司，不能按六位代码借用其他市场财报",
    };
  const code = symbol.slice(2);
  let reports: { name: string; path: string }[];
  try {
    reports = await recentReports(root);
  } catch (error) {
    return {
      period: null,
      reason: `读取本地财务包目录失败：${describe(error)}`,
      searched: [],
    };
  }
  if (!reports.length)
    return {
      period: null,
      reason: "本地通达信目录没有 gpcw 财务包，无法确定报告期",
      searched: [],
    };
  const searched: string[] = [];
  const hits: FinanceReportPeriod[] = [];
  const skipped: string[] = [];
  for (const report of reports) {
    let digest: ReportDigest;
    try {
      digest = await loadDigest(report.path);
    } catch (error) {
      // 未来期占位包字段数异常是常见情况，跳过并如实报告，不让整次判定失败。
      skipped.push(`${report.name}（${describe(error)}）`);
      continue;
    }
    searched.push(formatDate(digest.reportDate));
    const fields = digest.values.get(code);
    if (!fields) continue;
    if (
      same(finance.totalAssets, fields.totalAssets) &&
      same(finance.mainRevenue, fields.mainRevenue) &&
      same(finance.netProfit, fields.netProfit)
    )
      hits.push({
        reportDate: formatDate(digest.reportDate),
        sourceFilename: report.name,
        sourceSha256: digest.sourceSha256,
      });
  }
  const skipNote = skipped.length ? `；已跳过 ${skipped.join("、")}` : "";
  if (hits.length === 1) return { period: hits[0]!, reason: null, searched };
  return {
    period: null,
    reason:
      hits.length === 0
        ? `最近 ${searched.length} 期本地财务包都没有与该快照一致的记录${skipNote}`
        : `快照同时匹配 ${hits.map((hit) => hit.reportDate).join("、")}，无法唯一确定报告期${skipNote}`,
    searched,
  };
}

/**
 * 本地财务包与实时快照是否同期。
 *
 * 方向要靠反查结果判断，不能直接比日期：本地若落后，快照那一期根本不在本地，
 * `resolveFinanceReportPeriod` 会定位失败而不是给出一个更大的日期。所以
 * 「定位不到」才是本地需要更新的信号，「定位到更早一期」则是快照侧还没换期。
 */
export function localReportLag(
  local: LocalFinancials | null,
  snapshot: FinanceReportPeriodResult | null,
): string | null {
  if (!local || !snapshot) return null;
  if (!snapshot.period)
    return `本地财务包最新一期是 ${local.reportDate}，实时快照无法定位到本地任何一期（${snapshot.reason ?? "原因未知"}）。若已发布新报告期，请在通达信盘后下载「专业财务数据」更新本地包。`;
  return snapshot.period.reportDate < local.reportDate
    ? `实时快照仍停留在 ${snapshot.period.reportDate}，本地财务包已到 ${local.reportDate}；页面按本地这一期展示。`
    : null;
}
