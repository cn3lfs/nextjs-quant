"use client";
import { formatNumber } from "trading-strategy-core/format-number";

import Link from "next/link";
import { rpsGroupExclusions, rpsPeriods } from "quant-rps";

import { useEffect, useRef, useState } from "react";
import {
  nextTableSort,
  sortingState,
  type TableSort,
} from "~/lib/common/server-sort";
import { api } from "~/trpc/react";
import { industryEmptyLabels } from "~/lib/screening/industry-rps";
import { rpsPeriodLabel } from "~/lib/screening/rps";
import {
  rpsConditionsLabel,
  type RpsCondition,
} from "~/lib/screening/rps-conditions";
import {
  IndustryRpsStatus,
  industryExclusionLabels,
} from "./industry-rps-status";
import { RpsConditionEditor } from "./rps-condition-editor";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useAccumulatedPages, useTablePage } from "../ui/use-infinite-table";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { PoolMembersLink } from "./pool-members-link";
import { usePanelVisible } from "../workbench/keep-alive";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import type { RouterOutputs } from "~/trpc/react";

type Row = RouterOutputs["industryRpsPage"]["rows"][number];
const rowKey = (row: Row) => row.name;
function columns(conditions: RpsCondition[]): DataTableColumn<Row>[] {
  return [
    {
      id: "name",
      enableSorting: true,
      header: "行业",
      cell: ({ row }) => (
        <PoolMembersLink category="industry" name={row.original.name} />
      ),
    },
    {
      id: "rank",
      enableSorting: true,
      header: "排名 / RPS / 等权涨幅",
      cell: ({ row }) => {
        const v = row.original.value;
        return v
          ? `${v.rank} / ${formatNumber(v.rps, 2)} / ${formatNumber(v.return * 100, 2)}%`
          : industryEmptyLabels[row.original.reason!];
      },
    },
    {
      id: "members",
      enableSorting: true,
      header: "成分 / 本周期有效 / 端点不足",
      cell: ({ row }) =>
        `${row.original.total} / ${row.original.valid ?? "—"} / ${row.original.endpointMissing ?? "—"}`,
    },
    {
      id: "excluded",
      enableSorting: true,
      header: "剔除原因及数量",
      cell: ({ row }) =>
        rpsGroupExclusions
          .filter((k) => row.original.excluded[k])
          .map(
            (k) => `${industryExclusionLabels[k]} ${row.original.excluded[k]}`,
          )
          .join("；") || "无",
    },
    ...(conditions.length
      ? [
          {
            id: "conditionValues",
            enableSorting: false,
            header: "条件 RPS",
            cell: ({ row }) => (
              <span className="whitespace-nowrap tabular-nums">
                {conditions
                  .map(
                    (condition) =>
                      `${rpsPeriodLabel(condition.period)} ${formatNumber(
                        row.original.conditionValues?.[String(condition.period)]
                          ?.rps,
                        2,
                      )}`,
                  )
                  .join(" · ")}
              </span>
            ),
          } satisfies DataTableColumn<Row>,
        ]
      : []),
    {
      id: "source",
      enableSorting: true,
      header: "名单文件证据",
      cell: ({ row }) => (
        <details>
          <summary>{row.original.file.file}</summary>
          <p className="break-all">SHA256：{row.original.file.hash}</p>
          <p>mtime：{new Date(row.original.file.mtimeMs).toISOString()}</p>
        </details>
      ),
    },
  ];
}

/** Container owns requests; status and DataTable consume server-prepared props. */
export function IndustryRpsControls() {
  const [root, setRoot] = useState<string>();
  const [message, setMessage] = useState("");
  const [date, setDate] = useState("");
  const [period, setPeriod] = useState(20);
  const [conditions, setConditions] = useState<RpsCondition[]>([]);
  const [order, setOrder] = useState<TableSort>(null);
  const resetKey = JSON.stringify([date, period, conditions, order]);
  const cursor = useTablePage(resetKey);
  const visible = usePanelVisible();
  const status = api.industryRpsStatus.useQuery(undefined, {
    enabled: visible,
    refetchInterval: 2000,
  });
  const page = api.industryRpsPage.useQuery(
    {
      date: date || undefined,
      period,
      conditions,
      page: cursor.pageIndex,
      order,
    },
    {
      enabled: visible,
      staleTime: 0,
      refetchInterval:
        cursor.pageIndex === 0 && status.data?.progress?.status === "running"
          ? 4000
          : false,
    },
  );
  // Only the current key's successful response is evidence for the summary,
  // rows, bases and paging. A same-key background refresh keeps it; a key
  // change or a failed refresh never shows the previous batch as this one.
  const result =
    page.isSuccess && !page.isPlaceholderData ? page.data : undefined;
  const batches = useAccumulatedPages({
    resetKey,
    pageIndex: cursor.pageIndex,
    items: result?.rows,
    total: result?.total,
    metadata: result,
    getKey: rowKey,
  });
  const confirmed = page.isError ? undefined : batches.metadata;
  function refresh() {
    if (cursor.pageIndex === 0) void page.refetch();
    else cursor.restart();
  }
  const onError = (error: { message: string }) => setMessage(error.message);
  const onSuccess = () => {
    setMessage("请求已处理");
    void status.refetch();
    refresh();
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
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) refresh();
    wasRunning.current = running;
  });
  const directoryDirty = root !== undefined && root !== status.data?.root;
  const busy =
    running ||
    start.isPending ||
    status.isPending ||
    status.isError ||
    configure.isPending ||
    sourceConfigure.isPending;
  const conditionUnavailable =
    conditions.length > 0 && confirmed
      ? confirmed.day === null ||
        (confirmed.conditions ?? []).some(
          (condition) => condition.periodMissing,
        )
      : false;
  const appliedText = rpsConditionsLabel(conditions);
  const missingConditionPeriods = (confirmed?.conditions ?? [])
    .filter((condition) => condition.periodMissing)
    .map((condition) => rpsPeriodLabel(condition.period))
    .join("、");
  return (
    <section className="space-y-4" aria-label="行业RPS数据管理">
      {status.data?.tdxConfigured === false && (
        <p className="text-sm text-muted-foreground">
          行业和概念 RPS 需要通达信本地行情与证券范围。
          <Link href="/system" className="underline">
            配置通达信目录
          </Link>
        </p>
      )}
      <div className="grid gap-4 rounded-lg border border-border bg-card p-4 lg:grid-cols-2">
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
            placeholder="外部 Blocks 根目录（绝对路径）"
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
            }}
          />
        </label>
        <Select
          value={String(period)}
          onValueChange={(v) => {
            setPeriod(Number(v));
          }}
        >
          <SelectTrigger aria-label="行业RPS周期">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {rpsPeriods.map((p) => (
              <SelectItem key={p} value={String(p)}>
                {rpsPeriodLabel(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <RpsConditionEditor
          applied={conditions}
          onApply={(next) => {
            setConditions(next);
          }}
          onClear={() => {
            setConditions([]);
          }}
        />
      </div>
      <div
        className="space-y-1 text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <p>
          已生效条件：
          <span className="text-foreground">{appliedText}</span>
          {conditionUnavailable
            ? null
            : confirmed
              ? ` · 命中 ${confirmed.total} 个行业`
              : " · 等待当前条件的成功查询结果"}
        </p>
        {confirmed?.conditions?.length ? (
          <p>
            条件周期有效排名基数：
            {confirmed.conditions
              .map(
                (condition) =>
                  `${rpsPeriodLabel(condition.period)} ${
                    condition.count === null ? "未计算" : condition.count
                  }`,
              )
              .join(" / ")}
            。各条件来自同一批次，过滤不重新排名。
          </p>
        ) : null}
      </div>
      {confirmed?.day && (
        <p>
          {confirmed.day.date} ·{" "}
          {confirmed.day.mode === "backfill"
            ? "回填（成分漂移 / 生存者偏差）"
            : "向前新增（当次成分快照）"}{" "}
          · 本周期排名基数 {confirmed.day.count}；按RPS降序，未排名行业置后。
          分类：
          {confirmed.day.classification === "tdx-research-level1"
            ? "通达信研究一级行业"
            : "申万行业"}
          ；成分快照来源：{confirmed.day.root}；行情来源：
          {confirmed.day.source.root}；{confirmed.day.source.calendar}
          ；GBBQ覆盖至 {confirmed.day.source.actionsCoverage}。
        </p>
      )}
      <DataTable
        columns={columns(conditions)}
        data={
          conditionUnavailable || (page.isError && cursor.pageIndex === 0)
            ? []
            : batches.rows
        }
        rowCount={conditionUnavailable ? undefined : confirmed?.total}
        sorting={sortingState(order)}
        onSortingChange={(updater) => {
          setOrder(nextTableSort(updater, order));
        }}
        getRowId={rowKey}
        label="行业RPS排名与成分审计"
        loading={page.isFetching || page.isPending}
        error={page.error?.message}
        onRetry={() => void page.refetch()}
        infiniteScroll={{
          hasMore: !conditionUnavailable && batches.hasMore,
          loadingMore: cursor.pageIndex > 0 && page.isFetching,
          onLoadMore: cursor.loadMore,
        }}
        emptyMessage={
          !confirmed
            ? "等待当前条件的成功查询结果。"
            : conditionUnavailable
              ? confirmed.day === null
                ? "所选日期没有行业批次，条件未执行；这不表示筛选结果为 0。"
                : `当前批次未计算 ${missingConditionPeriods}，条件未执行；这不表示筛选结果为 0。`
              : conditions.length
                ? "没有同时满足全部条件的行业。可放宽阈值、改选周期，或确认当前批次是否计算了这些周期。"
                : "该日尚无行业结果。"
        }
      />
    </section>
  );
}
