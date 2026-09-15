"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { industryEmptyLabels, industryExclusions } from "~/lib/industry-rps";
import { rpsPeriods } from "~/lib/rps";
import {
  IndustryRpsStatus,
  industryExclusionLabels,
} from "./industry-rps-status";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { DataTable, type DataTableColumn } from "./ui/data-table";
import { PoolMembersLink } from "./pool-members-link";
import { usePanelVisible } from "./workbench/keep-alive";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import type { RouterOutputs } from "~/trpc/react";

type Row = RouterOutputs["industryRpsPage"]["rows"][number];
const columns: DataTableColumn<Row>[] = [
  {
    id: "name",
    header: "行业",
    enableSorting: false,
    cell: ({ row }) => (
      <PoolMembersLink category="industry" name={row.original.name} />
    ),
  },
  {
    id: "rank",
    header: "排名 / RPS / 等权涨幅",
    enableSorting: false,
    cell: ({ row }) => {
      const v = row.original.value;
      return v
        ? `${v.rank} / ${v.rps.toFixed(2)} / ${(v.return * 100).toFixed(2)}%`
        : industryEmptyLabels[row.original.reason!];
    },
  },
  {
    id: "members",
    header: "成分 / 本周期有效 / 端点不足",
    enableSorting: false,
    cell: ({ row }) =>
      `${row.original.total} / ${row.original.valid} / ${row.original.endpointMissing}`,
  },
  {
    id: "excluded",
    header: "剔除原因及数量",
    enableSorting: false,
    cell: ({ row }) =>
      industryExclusions
        .filter((k) => row.original.excluded[k])
        .map((k) => `${industryExclusionLabels[k]} ${row.original.excluded[k]}`)
        .join("；") || "无",
  },
  {
    id: "source",
    header: "名单文件证据",
    enableSorting: false,
    cell: ({ row }) => (
      <details>
        <summary>{row.original.file.file}</summary>
        <p className="break-all">SHA256：{row.original.file.hash}</p>
        <p>mtime：{new Date(row.original.file.mtimeMs).toISOString()}</p>
      </details>
    ),
  },
];

/** Container owns requests; status and DataTable consume server-prepared props. */
export function IndustryRpsControls() {
  const [root, setRoot] = useState<string>();
  const [message, setMessage] = useState("");
  const [date, setDate] = useState("");
  const [period, setPeriod] = useState(20);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 });
  const visible = usePanelVisible();
  const status = api.industryRpsStatus.useQuery(undefined, {
    enabled: visible,
    refetchInterval: 2000,
  });
  const page = api.industryRpsPage.useQuery(
    { date: date || undefined, period, page: pagination.pageIndex },
    { enabled: visible, refetchInterval: 4000 },
  );
  const onError = (error: { message: string }) => setMessage(error.message);
  const onSuccess = () => {
    setMessage("请求已处理");
    void status.refetch();
    void page.refetch();
  };
  const configure = api.industryRpsConfigure.useMutation({
    onSuccess,
    onError,
  });
  const sourceConfigure = api.industryRpsSourceConfigure.useMutation({
    onSuccess,
    onError,
  });
  const inspect = api.industryRpsInspect.useMutation({ onError });
  const start = api.rpsStart.useMutation({ onSuccess, onError });
  const cancel = api.rpsCancel.useMutation({ onSuccess, onError });
  const running = status.data?.progress?.status === "running";
  const directoryDirty = root !== undefined && root !== status.data?.root;
  const busy =
    running ||
    start.isPending ||
    status.isPending ||
    status.isError ||
    configure.isPending ||
    sourceConfigure.isPending;
  return (
    <section className="space-y-4" aria-label="行业RPS数据管理">
      <div className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-2">
        <label className="space-y-2 text-sm">
          <span className="font-medium">板块成分来源</span>
          <Select
            value={status.data?.membershipSource ?? "blocks"}
            disabled={busy}
            onValueChange={(value) =>
              sourceConfigure.mutate(value as "blocks" | "tdx")
            }
          >
            <SelectTrigger aria-label="板块RPS成分来源">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="blocks">
                外部 Blocks：申万行业 / 概念
              </SelectItem>
              <SelectItem value="tdx">通达信：研究一级行业 / 概念</SelectItem>
            </SelectContent>
          </Select>
          <span className="block text-xs text-muted-foreground">
            来源同时用于行业和概念的新批次，已完成的快照保持原来源。
          </span>
        </label>
        <label className="space-y-2 text-sm">
          <span className="font-medium">外部 Blocks 根目录</span>
          <Input
            value={root ?? status.data?.root ?? ""}
            placeholder="D:\wsWDZ\Blocks"
            onChange={(e) => setRoot(e.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            选择外部来源时使用；目录只读。
          </span>
        </label>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={busy}
          onClick={() => {
            inspect.reset();
            configure.mutate(root ?? status.data?.root ?? "");
          }}
        >
          保存目录
        </Button>
        <Button
          variant="outline"
          disabled={
            busy || directoryDirty || inspect.isPending || !status.data?.ready
          }
          onClick={() => inspect.mutate()}
        >
          核对当前文件变化
        </Button>
        <Button
          disabled={busy || directoryDirty || !status.data?.ready}
          onClick={() =>
            start.mutate({ target: "industry", mode: "backfill", days: 250 })
          }
        >
          回填行业最近250日
        </Button>
        <Button
          disabled={busy || directoryDirty || !status.data?.ready}
          onClick={() =>
            start.mutate({ target: "industry", mode: "forward", days: 1 })
          }
        >
          计算今日行业
        </Button>
        <Button
          variant="outline"
          disabled={!running || cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          取消当前RPS任务
        </Button>
      </div>
      {message && <p role="status">{message}</p>}
      {directoryDirty && <p>目录尚未保存，请先保存再核对或计算。</p>}
      {status.isPending && <p role="status">读取行业状态…</p>}
      {status.isError && (
        <p role="alert">
          {status.error.message}
          <Button onClick={() => void status.refetch()}>重试</Button>
        </p>
      )}
      {inspect.isPending && <p role="status">读取当前名单…</p>}
      {inspect.data && (
        <p className="break-all">
          当前解析 {inspect.data.count} 个行业；
          {inspect.data.baseline ? "相对最近已存快照" : "尚无已存快照基线"}
          ：变更 {inspect.data.changed.join("、") || "无"}；新增{" "}
          {inspect.data.added.join("、") || "无"}；缺失{" "}
          {inspect.data.removed.join("、") || "无"}。快照hash：
          {inspect.data.hash}
        </p>
      )}
      <IndustryRpsStatus latest={status.data?.latest ?? null} />
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-3">
        <label className="space-y-1 text-sm">
          <span className="block">结果日期（留空为最近）</span>
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
          onValueChange={(v) => {
            setPeriod(Number(v));
            setPagination({ pageIndex: 0, pageSize: 20 });
          }}
        >
          <SelectTrigger aria-label="行业RPS周期">
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
          {page.data.day.date} ·{" "}
          {page.data.day.mode === "backfill"
            ? "回填（成分漂移 / 生存者偏差）"
            : "向前新增（当次成分快照）"}{" "}
          · 本周期排名基数 {page.data.day.count}；按RPS降序，未排名行业置后。
          分类：
          {page.data.day.classification === "tdx-research-level1"
            ? "通达信研究一级行业"
            : "申万行业"}
          ；成分快照来源：{page.data.day.root}；行情来源：
          {page.data.day.source.root}；{page.data.day.source.calendar}
          ；GBBQ覆盖至 {page.data.day.source.actionsCoverage}。
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
        label="行业RPS排名与成分审计"
        loading={page.isPending}
        error={page.error?.message}
        onRetry={() => void page.refetch()}
        emptyMessage="该日尚无行业结果。"
      />
    </section>
  );
}
