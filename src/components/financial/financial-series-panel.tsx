"use client";
import { usePanelVisible } from "../workbench/keep-alive";
import { useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { displayFinancialNumber } from "~/lib/financial/financial-display";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Input } from "../ui/input";
type Row = RouterOutputs["localFinancialSeries"]["rows"][number];
const columns: DataTableColumn<Row>[] = [
  {
    id: "date",
    header: "日期 / 原日期",
    enableSorting: true,
    cell: ({ row }) =>
      row.original.date ?? `无有效日期（${row.original.rawDate}）`,
  },
  {
    id: "group",
    header: "数据组",
    cell: ({ row }) => `${row.original.code} · ${row.original.label}`,
  },
  ...[0, 1].map((side) => ({
    id: `value${side}`,
    header: `值 ${side + 1}`,
    cell: ({ row }: { row: { original: Row } }) => {
      const field = row.original.values[side]!;
      return (
        <span>
          {field.label}：{displayFinancialNumber(field.value, field.unit)}{" "}
          {field.unit}
          <span className="block text-xs text-muted-foreground">
            原值 {displayFinancialNumber(field.raw, field.rawUnit)}{" "}
            {field.rawUnit}
          </span>
        </span>
      );
    },
  })),
  {
    id: "offset",
    header: "记录依据",
    cell: ({ row }) =>
      `偏移 ${row.original.offset}${row.original.duplicate ? " · 同组同日多条，未合并" : ""}`,
  },
];
export function FinancialSeriesPanel({ symbol }: { symbol: string }) {
  const visible = usePanelVisible();
  const [source, setSource] = useState(symbol),
    [group, setGroup] = useState("all"),
    [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 30 }),
    [sorting, setSorting] = useState<{ id: string; desc: boolean }[]>([
      { id: "date", desc: true },
    ]);
  const query = api.localFinancialSeries.useQuery(
    {
      symbol: source,
      group: group === "all" ? undefined : Number(group),
      start: start || undefined,
      end: end || undefined,
      ...pagination,
      descending: sorting[0]?.desc ?? true,
    },
    { enabled: visible, staleTime: 30000, retry: false },
  );
  const reset = () => setPagination((p) => ({ ...p, pageIndex: 0 }));
  return (
    <section aria-label="股票板块市场序列" className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant={source === symbol ? "default" : "outline"}
          onClick={() => {
            setSource(symbol);
            setGroup("all");
            reset();
          }}
        >
          当前证券/板块
        </Button>
        <Button
          variant={source === "sh999999" ? "default" : "outline"}
          onClick={() => {
            setSource("sh999999");
            setGroup("all");
            reset();
          }}
        >
          全市场
        </Button>
        <Select
          value={group}
          onValueChange={(value) => {
            setGroup(value);
            reset();
          }}
        >
          <SelectTrigger aria-label="序列数据组" className="max-w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部数据组</SelectItem>
            {query.data?.groups.map((item) => (
              <SelectItem key={item.id} value={String(item.id)}>
                {item.id} · {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="date"
          aria-label="序列开始日期"
          value={start}
          onChange={(event) => {
            setStart(event.target.value);
            reset();
          }}
          className="w-40"
        />
        <Input
          type="date"
          aria-label="序列结束日期"
          value={end}
          onChange={(event) => {
            setEnd(event.target.value);
            reset();
          }}
          className="w-40"
        />
      </div>
      {query.data && (
        <p className="break-all text-xs text-muted-foreground">
          {query.data.filename} · {query.data.namespace} ·{" "}
          {query.data.sourceSha256 ?? "未下载"} · 日期异常{" "}
          {query.data.issueCount}{" "}
          条。各组有独立覆盖，记录日期不保证是公开日期；历史序列不保证保留完整历史。
        </p>
      )}
      {query.data?.warning && (
        <p role="status" className="text-xs">
          {query.data.warning}
        </p>
      )}
      {group !== "all" &&
        query.data?.groups.find((item) => item.id === Number(group)) && (
          <p className="text-xs">
            覆盖{" "}
            {query.data.groups.find((item) => item.id === Number(group))
              ?.first ?? "未知"}{" "}
            至{" "}
            {query.data.groups.find((item) => item.id === Number(group))
              ?.last ?? "未知"}
          </p>
        )}
      <DataTable
        columns={columns}
        data={query.data?.rows ?? []}
        rowCount={query.data?.rowCount ?? 0}
        pagination={pagination}
        onPaginationChange={setPagination}
        sorting={sorting}
        onSortingChange={(value) => {
          setSorting(value);
          reset();
        }}
        getRowId={(row) => String(row.offset)}
        label="本地序列数据"
        loading={query.isFetching}
        error={query.error?.message}
        onRetry={() => void query.refetch()}
        emptyMessage={
          query.data?.reason ?? "该范围没有记录，源文件未补造数据。"
        }
      />
    </section>
  );
}
