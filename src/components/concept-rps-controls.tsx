"use client";
import { useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { UniverseAuditContainer } from "./universe-audit-container";
import { usePanelVisible } from "./workbench/keep-alive";
import { rpsPeriods } from "~/lib/rps";
import { industryEmptyLabels, industryExclusions } from "~/lib/industry-rps";
import { industryExclusionLabels } from "./industry-rps-status";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { DataTable, type DataTableColumn } from "./ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

type Row = RouterOutputs["conceptRpsPage"]["rows"][number];
const columns: DataTableColumn<Row>[] = [
  {
    id: "name",
    header: "概念",
    enableSorting: false,
    cell: ({ row }) => (
      <a
        className="text-primary underline"
        href={`/?poolCategory=concept&poolName=${encodeURIComponent(row.original.name)}`}
      >
        {row.original.name} · 查看成分
      </a>
    ),
  },
  {
    id: "rank",
    header: "排名 / RPS / 等权涨幅",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.value
        ? `${row.original.value.rank} / ${row.original.value.rps.toFixed(2)} / ${(row.original.value.return * 100).toFixed(2)}%`
        : industryEmptyLabels[row.original.reason!],
  },
  {
    id: "coverage",
    header: "成分 / 有效 / 端点不足",
    enableSorting: false,
    cell: ({ row }) =>
      `${row.original.total} / ${row.original.valid} / ${row.original.endpointMissing}`,
  },
  {
    id: "excluded",
    header: "剔除原因",
    enableSorting: false,
    cell: ({ row }) =>
      industryExclusions
        .filter((reason) => row.original.excluded[reason])
        .map(
          (reason) =>
            `${industryExclusionLabels[reason]} ${row.original.excluded[reason]}`,
        )
        .join("；") || "无",
  },
];
export function ConceptRpsControls() {
  const [date, setDate] = useState("");
  const [period, setPeriod] = useState(50);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 });
  const [message, setMessage] = useState("");
  const visible = usePanelVisible();
  const status = api.conceptRpsStatus.useQuery(undefined, {
    enabled: visible,
    refetchInterval: 3000,
  });
  const page = api.conceptRpsPage.useQuery(
    { date: date || undefined, period, page: pagination.pageIndex },
    { enabled: visible, refetchInterval: 5000 },
  );
  const onError = (e: { message: string }) => setMessage(e.message);
  const start = api.rpsStart.useMutation({
    onError,
    onSuccess: () => {
      setMessage("概念任务已启动");
      void status.refetch();
    },
  });
  const cancel = api.rpsCancel.useMutation({ onError });
  const running = status.data?.progress?.status === "running";
  const busy =
    running ||
    start.isPending ||
    status.isPending ||
    status.isError ||
    !status.data?.ready;
  return (
    <section className="space-y-4" aria-label="概念RPS数据管理">
      <h2 className="text-xl font-semibold">概念RPS排名</h2>
      {page.data?.day && (
        <UniverseAuditContainer
          key={`${page.data.day.date}:${page.data.day.hash}`}
          source={{
            kind: "concept",
            date: page.data.day.date,
            hash: page.data.day.hash,
          }}
          end={page.data.day.date}
        />
      )}
      <p>
        使用上方选择的 Blocks
        或通达信概念名单。以有效成分股后复权涨幅的等权平均对概念分别排名，不混入申万行业排名，也不等于通达信概念指数。重叠成分在不同概念内分别计数。
      </p>
      <p className="text-sm text-muted-foreground">
        当前名单不是历史成分；回填有成分漂移和生存者偏差。每日按工作流设置与个股、行业串行批处理；行情或日历不齐则失败。保留最近750个结果日，清理与写入同事务；取消保留已完成日期，重试补缺。
      </p>
      {!status.data?.ready && (
        <p>请先在上方选择通达信来源，或配置只读 Blocks 根目录。</p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={busy}
          onClick={() =>
            start.mutate({ target: "concept", mode: "backfill", days: 250 })
          }
        >
          回填概念最近250日
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            start.mutate({ target: "concept", mode: "forward", days: 1 })
          }
        >
          计算今日概念
        </Button>
        <Button
          variant="outline"
          disabled={!running || cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          取消当前RPS任务
        </Button>
      </div>
      {status.isError && (
        <p role="alert">
          {status.error.message}
          <Button onClick={() => void status.refetch()}>重试</Button>
        </p>
      )}
      {status.data?.progress && (
        <p role="status">
          {
            { stock: "个股", industry: "行业", concept: "概念" }[
              status.data.progress.target ?? "stock"
            ]
          }
          任务：
          {status.data.progress.status} · {status.data.progress.phase} · 完成
          {status.data.progress.completedDays}/{status.data.progress.totalDays}
          日 {status.data.progress.error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="flex flex-wrap gap-3">
        <label>
          结果日期（留空为最近）
          <Input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setPagination({ pageIndex: 0, pageSize: 20 });
            }}
          />
        </label>
        <Select
          value={String(period)}
          onValueChange={(value) => {
            setPeriod(Number(value));
            setPagination({ pageIndex: 0, pageSize: 20 });
          }}
        >
          <SelectTrigger aria-label="概念RPS周期">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {rpsPeriods.map((p) => (
              <SelectItem key={p} value={String(p)}>
                RPS{p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {page.data?.day && (
        <p>
          基准日{page.data.day.date} ·{" "}
          {page.data.day.mode === "backfill" ? "回填（存在偏差）" : "向前观察"}{" "}
          · 概念排名基数{page.data.day.count}；成分快照{page.data.day.hash}
          ；行情源{page.data.day.source.root}。
        </p>
      )}
      <DataTable
        columns={columns}
        data={page.data?.rows ?? []}
        rowCount={page.data?.total ?? 0}
        pagination={pagination}
        onPaginationChange={setPagination}
        sorting={[]}
        onSortingChange={() => {}}
        getRowId={(r) => r.name}
        label="概念RPS排名"
        loading={page.isPending}
        error={page.error?.message}
        onRetry={() => void page.refetch()}
        emptyMessage="该日尚无概念排名，请核对数据后计算。"
      />
    </section>
  );
}
