"use client";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { rpsPeriods, rpsGroupExclusions } from "quant-rps";

import { useEffect, useRef, useState } from "react";
import {
  nextTableSort,
  sortingState,
  type TableSort,
} from "~/lib/common/server-sort";
import { api, type RouterOutputs } from "~/trpc/react";
import { UniverseAuditContainer } from "../screening/universe-audit-container";
import { usePanelVisible } from "../workbench/keep-alive";
import { rpsPeriodLabel } from "~/lib/screening/rps";
import { industryEmptyLabels } from "~/lib/screening/industry-rps";
import {
  rpsConditionsLabel,
  type RpsCondition,
} from "~/lib/screening/rps-conditions";
import { RpsConditionEditor } from "./rps-condition-editor";
import { industryExclusionLabels } from "./industry-rps-status";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { PoolMembersLink } from "./pool-members-link";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type Row = RouterOutputs["conceptRpsPage"]["rows"][number];
function columns(conditions: RpsCondition[]): DataTableColumn<Row>[] {
  return [
    {
      id: "name",
      enableSorting: true,
      header: "概念",
      cell: ({ row }) => (
        <PoolMembersLink category="concept" name={row.original.name} />
      ),
    },
    {
      id: "rank",
      enableSorting: true,
      header: "排名 / RPS / 等权涨幅",
      cell: ({ row }) =>
        row.original.value
          ? `${row.original.value.rank} / ${displayNumber(row.original.value.rps, 2)} / ${displayNumber(row.original.value.return * 100, 2)}%`
          : industryEmptyLabels[row.original.reason!],
    },
    {
      id: "coverage",
      enableSorting: true,
      header: "成分 / 有效 / 端点不足",
      cell: ({ row }) =>
        `${row.original.total} / ${row.original.valid ?? "—"} / ${row.original.endpointMissing ?? "—"}`,
    },
    {
      id: "excluded",
      enableSorting: true,
      header: "剔除原因",
      cell: ({ row }) =>
        rpsGroupExclusions
          .filter((reason) => row.original.excluded[reason])
          .map(
            (reason) =>
              `${industryExclusionLabels[reason]} ${row.original.excluded[reason]}`,
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
                      `${rpsPeriodLabel(condition.period)} ${displayNumber(
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
  ];
}
export function ConceptRpsControls() {
  const [date, setDate] = useState("");
  const [period, setPeriod] = useState(50);
  const [conditions, setConditions] = useState<RpsCondition[]>([]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 });
  const [order, setOrder] = useState<TableSort>(null);
  const [message, setMessage] = useState("");
  const visible = usePanelVisible();
  const status = api.conceptRpsStatus.useQuery(undefined, {
    enabled: visible,
    refetchInterval: 3000,
  });
  const page = api.conceptRpsPage.useQuery(
    {
      date: date || undefined,
      period,
      conditions,
      page: pagination.pageIndex,
      order,
    },
    {
      enabled: visible,
      refetchInterval:
        status.data?.progress?.status === "running" ? 5000 : false,
    },
  );
  // Only the current key's successful response is evidence for the summary,
  // rows, bases and paging. A same-key background refresh keeps it; a key
  // change or a failed refresh never shows the previous batch as this one.
  const confirmed = page.isSuccess ? page.data : undefined;
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
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) void page.refetch();
    wasRunning.current = running;
  }, [running, page]);
  const busy =
    running ||
    start.isPending ||
    status.isPending ||
    status.isError ||
    !status.data?.ready;
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
    <section className="space-y-4" aria-label="概念RPS数据管理">
      {confirmed?.day && (
        <UniverseAuditContainer
          key={`${confirmed.day.date}:${confirmed.day.hash}`}
          source={{
            kind: "concept",
            date: confirmed.day.date,
            hash: confirmed.day.hash,
          }}
          end={confirmed.day.date}
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
        <p>
          请先配置通达信目录，再在上方选择板块成分来源；外部来源还需配置只读
          Blocks 根目录。
        </p>
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
      {message && <p role="status">{message}</p>}
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
                {rpsPeriodLabel(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <RpsConditionEditor
          applied={conditions}
          onApply={(next) => {
            setConditions(next);
            setPagination({ pageIndex: 0, pageSize: 20 });
          }}
          onClear={() => {
            setConditions([]);
            setPagination({ pageIndex: 0, pageSize: 20 });
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
              ? ` · 命中 ${confirmed.total} 个概念`
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
          基准日{confirmed.day.date} ·{" "}
          {confirmed.day.mode === "backfill" ? "回填（存在偏差）" : "向前观察"}{" "}
          · 概念排名基数{confirmed.day.count}；成分快照{confirmed.day.hash}
          ；行情源{confirmed.day.source.root}。
        </p>
      )}
      <DataTable
        columns={columns(conditions)}
        data={conditionUnavailable ? [] : (confirmed?.rows ?? [])}
        rowCount={conditionUnavailable ? 0 : (confirmed?.total ?? 0)}
        pagination={pagination}
        onPaginationChange={setPagination}
        sorting={sortingState(order)}
        onSortingChange={(updater) => {
          setOrder(nextTableSort(updater, order));
          setPagination({ pageIndex: 0, pageSize: 20 });
        }}
        getRowId={(r) => r.name}
        label="概念RPS排名"
        loading={page.isPending}
        error={page.error?.message}
        onRetry={() => void page.refetch()}
        showPagination={confirmed !== undefined && !conditionUnavailable}
        emptyMessage={
          !confirmed
            ? "等待当前条件的成功查询结果。"
            : conditionUnavailable
              ? confirmed.day === null
                ? "所选日期没有概念批次，条件未执行；这不表示筛选结果为 0。"
                : `当前批次未计算 ${missingConditionPeriods}，条件未执行；这不表示筛选结果为 0。`
              : conditions.length
                ? "没有同时满足全部条件的概念。可放宽阈值、改选周期，或确认当前批次是否计算了这些周期。"
                : "该日尚无概念排名，请核对数据后计算。"
        }
      />
    </section>
  );
}
