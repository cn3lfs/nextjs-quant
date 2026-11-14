"use client";
import { createContext, useContext } from "react";
import type { RouterOutputs } from "~/trpc/react";
import {
  displayFinancialNumber,
  displayFinancialMetric,
} from "~/lib/financial/financial-display";
import {
  DataTable,
  type DataTableColumn,
  type DataTableProps,
} from "../ui/data-table";
import { Button } from "../ui/button";

export type FinancialViewData = RouterOutputs["localFinancialView"];
export const FinancialDisplayUnit = createContext("元");
function FinancialMetricValue({
  metric,
}: {
  metric: FinancialViewData["metrics"][number];
}) {
  const display = useContext(FinancialDisplayUnit);
  return <>{displayFinancialMetric(metric, display)}</>;
}
function FinancialValue({
  value,
  unit,
}: {
  value: number | null;
  unit: string;
}) {
  const display = useContext(FinancialDisplayUnit),
    scale =
      unit === "元"
        ? display === "亿元"
          ? 1e8
          : display === "万元"
            ? 1e4
            : 1
        : 1;
  return (
    <>
      {displayFinancialNumber(value === null ? null : value / scale, unit)}{" "}
      {unit === "元" ? display : unit}
    </>
  );
}
function FinancialUnit({ unit }: { unit: string }) {
  const display = useContext(FinancialDisplayUnit);
  return <>{unit === "元" ? display : unit}</>;
}
type FieldRow = FinancialViewData["rows"][number];
const statusLabels: Record<string, string> = {
  value: "有效",
  "source-zero": "来源零值待核",
  missing: "缺失",
  "not-applicable": "不适用",
  unverified: "未核验",
};
const fieldColumns: DataTableColumn<FieldRow>[] = [
  {
    id: "slot",
    header: "字段",
    enableSorting: true,
    cell: ({ row }) => row.original.code,
  },
  {
    id: "label",
    header: "名称",
    enableSorting: true,
    cell: ({ row }) => (
      <span title={row.original.reason ?? undefined}>{row.original.label}</span>
    ),
  },
  {
    id: "value",
    header: "标准化值",
    enableSorting: true,
    cell: ({ row }) => (
      <FinancialValue value={row.original.value} unit={row.original.unit} />
    ),
  },
  {
    id: "unit",
    header: "单位",
    cell: ({ row }) => <FinancialUnit unit={row.original.unit} />,
  },
  {
    id: "raw",
    header: "原值 / 原单位",
    cell: ({ row }) =>
      `${displayFinancialNumber(row.original.raw, row.original.rawUnit)} ${row.original.rawUnit}`,
  },
  {
    id: "status",
    header: "状态与原因",
    cell: ({ row }) => (
      <span title={row.original.reason ?? undefined}>
        {statusLabels[row.original.status]}
        {row.original.reason && (
          <span className="block text-xs text-muted-foreground">
            {row.original.reason}
          </span>
        )}
      </span>
    ),
  },
];
export function FinancialFieldTable(props: {
  data: FinancialViewData | undefined;
  loading: boolean;
  error?: string;
  retry: () => void;
  pagination: DataTableProps<FieldRow>["pagination"];
  sorting: DataTableProps<FieldRow>["sorting"];
  onPaginationChange: DataTableProps<FieldRow>["onPaginationChange"];
  onSortingChange: DataTableProps<FieldRow>["onSortingChange"];
}) {
  return (
    <DataTable
      columns={fieldColumns}
      data={props.data?.rows ?? []}
      rowCount={props.data?.rowCount ?? 0}
      pagination={props.pagination}
      sorting={props.sorting}
      onPaginationChange={props.onPaginationChange}
      onSortingChange={props.onSortingChange}
      getRowId={(row) => row.code}
      label="本地财务字段"
      loading={props.loading}
      error={props.error}
      onRetry={props.retry}
      emptyMessage="当前报告期或筛选条件没有字段。"
    />
  );
}
export function FinancialOverview({ data }: { data: FinancialViewData }) {
  return (
    <div className="space-y-3">
      {!data.selected ? (
        <p role="status">
          本地未覆盖该证券的有效财报。板块、市场和ETF请查看序列数据。
        </p>
      ) : (
        <>
          <p className="text-sm">
            报告期 {data.selected.reportDate} · 公告日{" "}
            {data.selected.announcementDate ?? "缺失/无效"} ·{" "}
            {data.financialCompany === true
              ? "金融企业"
              : data.financialCompany === false
                ? "非金融企业"
                : "行业未核验"}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {data.metrics
              .filter((metric) =>
                [
                  "debt-ratio",
                  "gross-margin",
                  "net-margin",
                  "cash-to-profit",
                  "74-yoy",
                  "96-yoy",
                  "source-308",
                  "source-281",
                ].includes(metric.id),
              )
              .map((metric) => (
                <div
                  key={metric.id}
                  className="rounded-lg border border-border p-3"
                  title={metric.reason ?? metric.formula}
                >
                  <p className="text-xs text-muted-foreground">
                    {metric.label}
                  </p>
                  <p className="tabular-nums">
                    <FinancialMetricValue metric={metric} />
                  </p>
                  {metric.reason && (
                    <p className="text-xs text-muted-foreground">
                      {metric.reason}
                    </p>
                  )}
                </div>
              ))}
          </div>
        </>
      )}
      <p className="text-xs text-muted-foreground">{data.warning}</p>
      {data.selected?.warnings.map((warning) => (
        <p key={warning} className="text-xs text-muted-foreground">
          {warning}
        </p>
      ))}
      <div className="flex flex-wrap gap-3 text-xs">
        {Object.entries(data.statusCounts).map(([status, count]) => (
          <span key={status}>
            {statusLabels[status] ?? status}：{count}
          </span>
        ))}
      </div>
      {!!data.issues.length && (
        <details>
          <summary className="cursor-pointer text-sm">
            跳过的文件与原因（{data.issues.length}）
          </summary>
          <ul className="text-xs text-muted-foreground">
            {data.issues.map((issue) => (
              <li key={issue.filename}>
                {issue.filename}：{issue.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
export function FinancialMetricView({ data }: { data: FinancialViewData }) {
  return (
    <div className="space-y-2">
      {data.metrics.map((metric) => (
        <details key={metric.id} className="rounded border border-border p-2">
          <summary className="cursor-pointer text-sm">
            {metric.label}：
            <FinancialMetricValue metric={metric} />
          </summary>
          <p className="text-xs text-muted-foreground">
            {metric.formula} · {metric.reason ?? "计算输入齐全"}
          </p>
          <ul className="text-xs text-muted-foreground">
            {metric.inputs.map((input, index) => (
              <li key={index}>
                {input.reportDate} · {input.code} ·{" "}
                {input.sourceSha256.slice(0, 16)}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
type TimelineRow = FinancialViewData["timeline"][number];
const timelineColumns: DataTableColumn<TimelineRow>[] = [
  {
    id: "reportDate",
    header: "报告期",
    cell: ({ row }) => row.original.reportDate,
  },
  {
    id: "announcement",
    header: "公告日",
    cell: ({ row }) => row.original.announcementDate ?? "未知",
  },
  {
    id: "value",
    header: "指标值",
    cell: ({ row }) =>
      row.original.metric ? (
        <FinancialMetricValue metric={row.original.metric} />
      ) : (
        "—"
      ),
  },
  {
    id: "basis",
    header: "公式与缺口",
    cell: ({ row }) => (
      <span className="text-xs">
        {row.original.metric?.reason ??
          row.original.metric?.formula ??
          "未计算"}
      </span>
    ),
  },
];
export function FinancialTimeline({
  data,
  pagination,
  onPaginationChange,
}: {
  data: FinancialViewData;
  pagination: DataTableProps<TimelineRow>["pagination"];
  onPaginationChange: DataTableProps<TimelineRow>["onPaginationChange"];
}) {
  return (
    <DataTable
      columns={timelineColumns}
      data={data.timeline}
      rowCount={data.timelineCount}
      pagination={pagination}
      onPaginationChange={onPaginationChange}
      sorting={[]}
      onSortingChange={() => {}}
      getRowId={(row) => row.reportDate}
      label="多期财务对比"
      emptyMessage="没有可对比的历史财报。"
    />
  );
}
export function FinancialSourceView({
  data,
  onAudit,
  auditing,
}: {
  data: FinancialViewData;
  onAudit: () => void;
  auditing: boolean;
}) {
  return (
    <div className="space-y-3 text-sm">
      <p>
        字段版本：{data.versions.mapping} · 计算版本：
        {data.versions.calculation}
      </p>
      {data.selected && (
        <div className="break-all text-xs">
          <p>
            文件：{data.selected.sourceFilename} · 记录偏移：
            {data.selected.recordOffset}
          </p>
          <p>SHA-256：{data.selected.sourceSha256}</p>
          <p>内容 SHA-256：{data.selected.contentSha256}</p>
        </div>
      )}
      <p>
        每股、三表、单季、股东机构及预告快报按各自原始口径读取。日期、单位和零值不确定性随字段保留。
      </p>
      <details>
        <summary className="cursor-pointer">
          尚无已验证本地映射的官方项目（{data.unmapped.length}）
        </summary>
        <ul className="max-h-72 overflow-y-auto text-xs">
          {data.unmapped.map((field) => (
            <li key={field.code}>
              {field.code} · {field.label} ·{" "}
              {field.mappingStatus === "no-local-carrier"
                ? "未确认本地载体"
                : "物理映射未核验"}
            </li>
          ))}
        </ul>
      </details>
      <Button variant="outline" disabled={auditing} onClick={onAudit}>
        全目录只读审计
      </Button>
    </div>
  );
}
