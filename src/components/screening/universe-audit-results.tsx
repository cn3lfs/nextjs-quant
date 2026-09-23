import type { RouterOutputs } from "~/trpc/react";
import { universeAuditLabels } from "~/lib/screening/universe-audit";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import type { UniverseAuditRow } from "~/lib/screening/universe-audit";

const columns: DataTableColumn<UniverseAuditRow>[] = [
  { id: "symbol", header: "证券", accessorKey: "symbol", enableSorting: false },
  {
    id: "date",
    header: "依据日期",
    enableSorting: false,
    cell: ({ row }) => row.original.date ?? "—",
  },
  {
    id: "source",
    header: "证据来源 / 缺失原因",
    accessorKey: "source",
    enableSorting: false,
  },
];
export function UniverseAuditResults({
  data,
  page,
  onPage,
  loading,
}: {
  data: RouterOutputs["universeAuditPage"];
  page: number;
  onPage: (page: number) => void;
  loading: boolean;
}) {
  const { summary } = data;
  return (
    <div className="space-y-3 text-sm">
      <p>
        审计区间：{summary.start}—{summary.end}
      </p>
      <p className="break-all">名单来源：{summary.source}</p>
      <p>
        名单快照时间：{summary.rosterAsOf ?? "未知"} {summary.rosterAsOfReason}
      </p>
      <dl className="grid gap-2 sm:grid-cols-2">
        {Object.entries(universeAuditLabels).map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>
              {key === "delistedDuring" ? "≥ " : ""}
              {summary[key as keyof typeof universeAuditLabels]} 只
            </dd>
          </div>
        ))}
      </dl>
      <p>
        行情首日未知：{summary.localCoverageUnknown}{" "}
        只；已知覆盖计数不代表全部本地行情。
      </p>
      <p>{summary.unknowable.vanishedFromSource}</p>
      {data.warnings.map((warning) => (
        <p key={warning} className="text-muted-foreground">
          {warning}
        </p>
      ))}
      <DataTable
        columns={columns}
        data={data.rows}
        rowCount={data.total}
        pagination={{ pageIndex: page, pageSize: 20 }}
        onPaginationChange={(update) =>
          onPage(
            (typeof update === "function"
              ? update({ pageIndex: page, pageSize: 20 })
              : update
            ).pageIndex,
          )
        }
        sorting={[]}
        onSortingChange={() => {}}
        getRowId={(row) => row.symbol}
        label="时点审计明细"
        loading={loading}
        emptyMessage="此项没有已知命中证据，不代表已完成全市场核查。"
      />
    </div>
  );
}
