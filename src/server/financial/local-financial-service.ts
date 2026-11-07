import { createHash } from "node:crypto";
import {
  financialCatalog,
  financialMetrics,
  financialDate,
  financialVersions,
  seriesValueDefinition,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
import {
  localFinancialQuery,
  localSeriesQuery,
} from "~/lib/financial/local-financial";
import {
  readLocalFinancialHistory,
  readLocalFinancialSeries,
} from "../data-sources/tdx/local-financial-files";
function reportMetadata({
  fields: _fields,
  ...metadata
}: FinancialReportSnapshot) {
  return metadata;
}
const sourceManifest = (reports: readonly FinancialReportSnapshot[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        reports.map((report) => ({
          filename: report.sourceFilename,
          sha256: report.sourceSha256,
          offset: report.recordOffset,
          financialCompany: report.financialCompany,
        })),
      ),
    )
    .digest("hex");

export async function localFinancialView(root: string, input: unknown) {
  const query = localFinancialQuery.parse(input);
  const history = await readLocalFinancialHistory(root, query.symbol, {
    ...query,
    reportDate: undefined,
  });
  const selected = query.reportDate
    ? history.reports.find((r) => r.reportDate === query.reportDate)
    : history.reports[0];
  const rows = (selected?.fields ?? []).filter(
    (field) =>
      (!query.section ||
        field.section === query.section ||
        (query.section === "预告快报" &&
          ["forecast", "flash"].includes(field.timing)) ||
        (query.section === "股本机构" &&
          /股本股东|机构持股/.test(field.section))) &&
      (!query.search ||
        `${field.code} ${field.label}`
          .toLowerCase()
          .includes(query.search.toLowerCase())),
  );
  rows.sort((a, b) => {
    const compared =
      query.sort === "value"
        ? a.value === null
          ? 1
          : b.value === null
            ? -1
            : a.value - b.value
        : query.sort === "label"
          ? a.label.localeCompare(b.label, "zh-CN")
          : a.slot - b.slot;
    return (query.descending ? -1 : 1) * compared || a.slot - b.slot;
  });
  const statusCounts: Record<string, number> = {};
  for (const field of selected?.fields ?? [])
    statusCounts[field.status] = (statusCounts[field.status] ?? 0) + 1;
  const timeline = history.reports.map((report) => ({
    reportDate: report.reportDate,
    announcementDate: report.announcementDate,
    metric:
      financialMetrics(history.reports, report.reportDate).find(
        (metric) => metric.id === query.trendMetric,
      ) ?? null,
  }));
  return {
    symbol: query.symbol,
    sourceManifestHash: sourceManifest(history.reports),
    selected: selected ? reportMetadata(selected) : null,
    periods: history.reports.map(({ fields, ...report }) => ({
      ...report,
      fieldCount: fields.length,
    })),
    rows: rows.slice(
      query.pageIndex * query.pageSize,
      (query.pageIndex + 1) * query.pageSize,
    ),
    rowCount: rows.length,
    metrics: financialMetrics(history.reports, selected?.reportDate),
    timeline: timeline.slice(
      query.pageIndex * query.pageSize,
      (query.pageIndex + 1) * query.pageSize,
    ),
    timelineCount: timeline.length,
    statusCounts,
    issues: history.issues,
    financialCompany: history.financialCompany,
    warning: history.warning,
    versions: financialVersions,
    unmapped: financialCatalog.filter(
      (field) => field.mappingStatus !== "mapped",
    ),
    query,
  };
}

export async function localFinancialSeriesView(root: string, input: unknown) {
  const query = localSeriesQuery.parse(input);
  try {
    const source = await readLocalFinancialSeries(root, query.symbol);
    const groups = new Map<
      number,
      {
        id: number;
        label: string;
        records: number;
        first: string | null;
        last: string | null;
        undated: number;
      }
    >();
    const duplicates = new Map<string, number>();
    for (const record of source.records) {
      const key = `${record.group}:${record.rawDate}`;
      duplicates.set(key, (duplicates.get(key) ?? 0) + 1);
      const code = `${source.namespace}${record.group}`,
        date = record.date === null ? null : financialDate(record.date);
      const group = groups.get(record.group) ?? {
        id: record.group,
        label:
          financialCatalog.find((field) => field.code === code)?.label ??
          `未知组号 ${record.group}`,
        records: 0,
        first: null,
        last: null,
        undated: 0,
      };
      group.records++;
      if (!date) group.undated++;
      else {
        if (!group.first || date < group.first) group.first = date;
        if (!group.last || date > group.last) group.last = date;
      }
      groups.set(record.group, group);
    }
    const rows = source.records
      .filter(
        (record) =>
          (query.group === undefined || query.group === record.group) &&
          (!query.start ||
            (record.date !== null &&
              financialDate(record.date)! >= query.start)) &&
          (!query.end ||
            (record.date !== null && financialDate(record.date)! <= query.end)),
      )
      .sort(
        (a, b) =>
          (query.descending ? -1 : 1) * (a.rawDate - b.rawDate) ||
          a.offset - b.offset,
      );
    const page = rows
      .slice(
        query.pageIndex * query.pageSize,
        (query.pageIndex + 1) * query.pageSize,
      )
      .map((record) => ({
        ...record,
        date: record.date === null ? null : financialDate(record.date),
        duplicate:
          (duplicates.get(`${record.group}:${record.rawDate}`) ?? 0) > 1,
        code: `${source.namespace}${record.group}`,
        label: groups.get(record.group)!.label,
        values: record.values.map((raw, side) => {
          const definition =
            source.namespace === "unknown"
              ? null
              : seriesValueDefinition(
                  source.namespace,
                  record.group,
                  side as 0 | 1,
                );
          return {
            raw,
            value: definition ? raw * definition.scale : null,
            label: definition?.label ?? `未定义值${side + 1}`,
            unit: definition?.unit ?? "原单位",
            rawUnit: definition?.rawUnit ?? "未知",
            status: definition ? "mapped" : "unverified",
          };
        }),
      }));
    return {
      available: true as const,
      reason: null,
      symbol: query.symbol,
      namespace: source.namespace,
      filename: source.filename,
      sourceSha256: source.sourceSha256,
      groups: [...groups.values()].sort((a, b) => a.id - b.id),
      rows: page,
      rowCount: rows.length,
      issueCount: source.issues.length,
      warning: source.classificationWarning,
      query,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      available: false as const,
      reason: "本地未下载该证券/板块的序列文件",
      symbol: query.symbol,
      namespace: "unknown" as const,
      filename: `gp${query.symbol}.dat`,
      sourceSha256: null,
      groups: [],
      rows: [],
      rowCount: 0,
      issueCount: 0,
      warning: null,
      query,
    };
  }
}
export async function localFinancialExport(
  root: string,
  input: unknown,
  expectedSha256: string,
  expectedManifestHash: string,
) {
  const query = localFinancialQuery.parse(input);
  const history = await readLocalFinancialHistory(root, query.symbol, {
    ...query,
    reportDate: undefined,
  });
  const report = query.reportDate
    ? history.reports.find((item) => item.reportDate === query.reportDate)
    : history.reports[0];
  if (!report) throw new Error("当前报告期没有可导出的财报");
  if (report.sourceSha256 !== expectedSha256)
    throw new Error("源文件已更新，请刷新财报后重新导出");
  if (sourceManifest(history.reports) !== expectedManifestHash)
    throw new Error("计算组成期的源文件已更新，请刷新财报后重新导出");
  const content = {
    kind: "local-financial-export",
    versions: financialVersions,
    query,
    scope: "所选报告期全部字段，包含原值、标准化值及未验证槽位",
    report,
    metrics: financialMetrics(history.reports, report.reportDate),
    issues: history.issues,
    warning: history.warning,
  };
  return {
    ...content,
    createdAt: Date.now(),
    hash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
}
