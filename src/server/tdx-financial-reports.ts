import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseFinancialReport } from "tstdx";

/**
 * 通达信 7709 的财务快照不带报告期：实测 `updatedDate` 是快照更新日
 * （20260815 / 20260828 / 20260829 / 20260914 等均非季末），据此年化没有依据。
 * 本地专业财务包 `vipdoc/cw/gpcw<YYYYMMDD>.dat` 的包头写明报告期，因此用三个
 * 已与财务包逐字段交叉核对过的金额把快照定位到具体某一期。
 *
 * 字段下标由 2026-09-15 对 sh600519 / sz000002 / sz300750 / sz000001 的比对确定：
 * 协议值换算成元后与下列下标的财务包数值吻合到 float32 精度。
 * 源目录只读，不下载、不写入、不修改。
 */
const fieldIndex = { totalAssets: 39, mainRevenue: 73, netProfit: 95 } as const;
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

type ReportDigest = {
  reportDate: number;
  sourceSha256: string;
  /** 证券代码 → 用于定位报告期的三个金额，整包记录解析后即丢弃。 */
  values: Map<string, readonly [number, number, number]>;
};

/**
 * 按文件路径缓存压缩后的摘要。键含 mtime 与大小，包更新即失效；
 * 条目数受 `searchPeriods` 限制，不会无限增长；进程退出即释放，无需清理动作。
 */
const digests = new Map<string, { key: string; digest: ReportDigest }>();

export const financialReportDirectory = (root: string) =>
  resolve(root, "vipdoc", "cw");

async function loadDigest(path: string): Promise<ReportDigest> {
  const info = await stat(path);
  const key = `${info.mtimeMs}:${info.size}`;
  const cached = digests.get(path);
  if (cached?.key === key) return cached.digest;
  const report = parseFinancialReport(await readFile(path));
  const values = new Map<string, readonly [number, number, number]>();
  for (const record of report.records)
    values.set(record.code, [
      record.values[fieldIndex.totalAssets] ?? Number.NaN,
      record.values[fieldIndex.mainRevenue] ?? Number.NaN,
      record.values[fieldIndex.netProfit] ?? Number.NaN,
    ]);
  const digest: ReportDigest = {
    reportDate: report.reportDate,
    sourceSha256: report.sourceSha256,
    values,
  };
  digests.set(path, { key, digest });
  return digest;
}

const same = (quoted: number, reported: number) =>
  Number.isFinite(quoted) &&
  Number.isFinite(reported) &&
  (quoted === reported ||
    (reported !== 0 && Math.abs(quoted / reported - 1) <= matchTolerance));

const formatDate = (value: number) =>
  `${String(value).slice(0, 4)}-${String(value).slice(4, 6)}-${String(value).slice(6, 8)}`;

/** 列出最近的财务包，按报告期从新到旧；目录不可读时返回空列表。 */
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
  const code = symbol.slice(2);
  let reports: { name: string; path: string }[];
  try {
    reports = await recentReports(root);
  } catch (error) {
    return {
      period: null,
      reason: `读取本地财务包目录失败：${error instanceof Error ? error.message : String(error)}`,
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
      skipped.push(
        `${report.name}（${error instanceof Error ? error.message : String(error)}）`,
      );
      continue;
    }
    searched.push(formatDate(digest.reportDate));
    const values = digest.values.get(code);
    if (!values) continue;
    if (
      same(finance.totalAssets, values[0]) &&
      same(finance.mainRevenue, values[1]) &&
      same(finance.netProfit, values[2])
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
