"use client";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "~/trpc/react";
import {
  alertHistorySchema,
  alertKindGroups,
  alertKinds,
  alertKindLabels,
  alertModes,
  alertModeLabels,
  type AlertEvent,
  type AlertHistoryInput,
  type AlertKind,
} from "~/lib/strategy-facts/alerts";
import { alertDisplayCopy } from "~/lib/common/ui-glossary";
import { cryptoDisplayName, cryptoSymbol } from "~/lib/market/crypto";
import { securityDisplayName } from "~/lib/market/security-display";
import {
  alertChartHref,
  formatAlertReason,
  sleeveDisplayName,
  strategyDisplayName,
} from "~/lib/strategy-facts/strategy-display";
import { useSecurityNames } from "../market/use-security-names";
import { useTaskVisible } from "../workbench/use-task-visible";
import { Pill, Segmented } from "../panels";
import type { Tone } from "../panels/tone";
import { Button } from "../ui/button";
import { useAccumulatedPages, useTablePage } from "../ui/use-infinite-table";
import { DataTable } from "../ui/data-table";
import { LedgerInput, LedgerSelect } from "./ledger-fields";
import { AlertStatus } from "./alert-status";

type AlertKindGroupId = (typeof alertKindGroups)[number]["id"];

const categoryOptions = [
  { value: "all" as const, label: "全部" },
  ...alertKindGroups.map(({ id, label }) => ({
    value: id,
    label: label.replace(" / ", "·"),
  })),
];

const signalBadges: Record<AlertKindGroupId, { prefix: string; tone: Tone }> = {
  "entry-group": { prefix: "买入", tone: "bad" },
  "exit-group": { prefix: "卖出", tone: "ok" },
  "execution-group": { prefix: "计划", tone: "accent" },
  "risk-group": { prefix: "风控", tone: "warn" },
};

function groupForKind(kind: AlertKind) {
  return alertKindGroups.find((group) => group.kinds.some((k) => k === kind));
}

function compareHistoryOrder(a: AlertEvent, b: AlertEvent) {
  const [left, right] = a.bar === b.bar ? [a.key, b.key] : [a.bar, b.bar];
  return left < right ? 1 : left > right ? -1 : 0;
}

export function AlertWorkspace() {
  const visible = useTaskVisible();
  const search = useSearchParams();
  const eventKey = search.get("event") ?? undefined;
  const strategyId = search.get("strategy") ?? "";
  const locationKey = JSON.stringify([eventKey, strategyId]);
  const [lastLocation, setLastLocation] = useState(locationKey);
  const [filter, setFilter] = useState(() =>
    alertHistorySchema.parse({
      key: eventKey,
      strategyId,
    }),
  );
  const [category, setCategory] = useState<AlertKindGroupId | "all">("all");
  const categoryKinds = alertKindGroups.find(
    ({ id }) => id === category,
  )?.kinds;
  const groupOnly = !filter.kind && !!categoryKinds;
  const historyInputs = groupOnly
    ? categoryKinds.map((kind) => ({ ...filter, kind }))
    : [filter];
  if (lastLocation !== locationKey) {
    setLastLocation(locationKey);
    setFilter((current) => ({
      ...current,
      key: eventKey,
      strategyId,
      page: 0,
    }));
  }
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<AlertEvent | null>(null);
  const [entries, setEntries] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [expiry, setExpiry] = useState("");
  const [step, setStep] = useState("");
  const [minimum, setMinimum] = useState("");
  const [rulesSource, setRulesSource] = useState("");
  const historyKey = JSON.stringify([filter, category]);
  const historyCursor = useTablePage(historyKey);
  const planId = search.get("plan") ?? undefined;
  const planKey = JSON.stringify(planId ?? null);
  const planCursor = useTablePage(planKey);
  const securityNames = useSecurityNames().data ?? {};
  const catalog = api.strategyCenterCatalog.useQuery(undefined, {
    enabled: visible,
    staleTime: 300000,
  });
  const strategyNames = useMemo(
    () =>
      new Map<string, string>(
        (catalog.data ?? []).map((item) => [item.id, item.name] as const),
      ),
    [catalog.data],
  );
  const historyQueries = api.useQueries((t) =>
    historyInputs.map((input) =>
      t.alertHistory(
        { ...input, page: historyCursor.pageIndex },
        {
          enabled: visible,
          staleTime: 0,
          refetchInterval:
            visible && historyCursor.pageIndex === 0 ? 30000 : false,
        },
      ),
    ),
  );
  const plans = api.alertPlans.useQuery(
    { page: planCursor.pageIndex, id: planId },
    { enabled: visible, staleTime: 0 },
  );
  const historyPages = historyQueries.flatMap((query) =>
    query.isSuccess && !query.isPlaceholderData ? [query.data] : [],
  );
  const historyLoading = historyQueries.some((query) => query.isFetching);
  const historyError = historyQueries.find((query) => query.error)?.error;
  const allHistoryPagesReady = historyPages.length === historyInputs.length;
  const events = useAccumulatedPages({
    resetKey: historyKey,
    pageIndex: historyCursor.pageIndex,
    items: historyPages.flatMap((page) => page.items),
    total: historyPages.reduce((total, page) => total + page.total, 0),
    isSuccess: allHistoryPagesReady && !historyLoading,
    snapshotKey: historyPages.map((page) => page.total).join(","),
    onSnapshotDrift: historyCursor.restart,
    pageSize: filter.size,
    metadata: historyCursor.pageIndex + 1,
    getKey: (row) => row.key,
  });
  // Each requested kind contributes enough rows to determine the next page
  // of the merged history, even when one kind supplies that entire page.
  const historyRows = groupOnly
    ? [...events.rows]
        .sort(compareHistoryOrder)
        .slice(0, filter.size * (events.metadata ?? 0))
    : events.rows;
  const planPage =
    plans.isSuccess && !plans.isPlaceholderData ? plans.data : undefined;
  const planRows = useAccumulatedPages({
    resetKey: planKey,
    pageIndex: planCursor.pageIndex,
    items: planPage?.items,
    total: planPage?.total,
    isSuccess: !plans.isFetching,
    snapshotKey: planPage?.total,
    onSnapshotDrift: planCursor.restart,
    pageSize: 20,
    getKey: (row) => row.id,
  });
  const utils = api.useUtils();
  const create = api.createAlertPlan.useMutation({
    onSuccess: () => {
      setMessage("交易计划已保存；仅提醒，须人工交易");
      setSelected(null);
      planCursor.restart();
      void utils.alertPlans.invalidate();
    },
    onError: (e) => setMessage(e.message),
  });
  const cancel = api.cancelAlertPlan.useMutation({
    onSuccess: () => {
      planCursor.restart();
      void utils.alertPlans.invalidate();
    },
    onError: (e) => setMessage(e.message),
  });
  const exportHistory = useMutation({
    mutationFn: async (inputs: AlertHistoryInput[]) => {
      const [first, ...rest] = await Promise.all(
        inputs.map((input) => utils.client.exportAlertHistory.mutate(input)),
      );
      if (!rest.length) return first!;
      return {
        ...first!,
        items: [first!, ...rest]
          .flatMap((data) => data.items)
          .sort(compareHistoryOrder),
      };
    },
    onSuccess: (data) => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "提醒历史.json";
      link.click();
      URL.revokeObjectURL(url);
    },
    onError: (e) => setMessage(e.message),
  });
  const change = (patch: Partial<typeof filter>) =>
    setFilter({ ...filter, ...patch, page: 0 });
  const number = (v: number | null) => (v === null ? "—" : displayNumber(v, 2));
  const symbolLabel = (
    symbol: string,
    market?: AlertEvent["market"],
  ): string => {
    if (market === "crypto" || symbol.startsWith("cx"))
      return cryptoDisplayName(cryptoSymbol(symbol.replace(/^cx/, "")));
    const code = symbol.toUpperCase();
    const name = securityDisplayName(symbol, securityNames);
    return name === "名称待补全" ? code : `${name} ${code}`;
  };
  return (
    <div className="space-y-4 p-4">
      <h1>提醒历史与交易计划</h1>
      <AlertStatus />
      <p className="text-xs text-nc-text-3">
        T为实际观察日；T+1开盘入场、T+5/10/20收盘，原价无成本滑点；A股按交易日、数字货币按UTC自然日。缺行情和除权证据留空。非策略业绩。
      </p>
      <Segmented
        label="信号分类"
        options={categoryOptions}
        value={category}
        onChange={(value) => {
          setCategory(value);
          change({ kind: undefined });
        }}
      />
      <div className="flex flex-wrap items-end gap-3">
        <LedgerInput
          label="完成行情起始日"
          type="date"
          value={filter.from}
          onChange={(from) => change({ from: from || undefined })}
        />
        <LedgerInput
          label="完成行情截止日"
          type="date"
          value={filter.to}
          onChange={(to) => change({ to: to || undefined })}
        />
        <LedgerInput
          label="提醒证券"
          value={filter.symbol}
          onChange={(symbol) => change({ symbol })}
        />
        <LedgerInput
          label="来源策略"
          value={filter.strategyId}
          onChange={(strategyId) => change({ strategyId })}
        />
        <LedgerSelect
          label="提醒类型"
          value={filter.kind}
          onChange={(value) => {
            const kind = value ? (value as AlertKind) : undefined;
            if (kind) setCategory(groupForKind(kind)?.id ?? "all");
            change({ kind });
          }}
          options={[
            { value: "all", label: categoryKinds ? "本类全部" : "全部" },
            ...(categoryKinds ?? alertKinds).map((value) => ({
              value,
              label: alertKindLabels[value],
            })),
          ]}
        />
        <LedgerSelect
          label="记录模式"
          value={filter.mode}
          onChange={(mode) =>
            change({
              mode: mode ? (mode as typeof filter.mode) : undefined,
            })
          }
          options={[
            { value: "all", label: "全部" },
            ...alertModes.map((value) => ({
              value,
              label: alertModeLabels[value],
            })),
          ]}
        />
        <Button
          disabled={exportHistory.isPending}
          onClick={() => exportHistory.mutate(historyInputs)}
        >
          导出提醒历史
        </Button>
      </div>
      <DataTable
        label="提醒历史"
        data={historyRows}
        rowCount={events.total}
        loading={historyLoading}
        error={
          historyError ? alertDisplayCopy(historyError.message) : undefined
        }
        onRetry={() => {
          for (const query of historyQueries) void query.refetch();
        }}
        infiniteScroll={{
          hasMore:
            events.hasMore || (groupOnly && historyRows.length < events.total),
          loadingMore: historyCursor.pageIndex > 0 && historyLoading,
          onLoadMore: historyCursor.loadMore,
        }}
        sorting={[]}
        onSortingChange={() => {}}
        getRowId={(r) => r.key}
        columns={[
          {
            id: "bar",
            header: "日期 / 策略",
            cell: ({ row }) => (
              <div className="space-y-0.5">
                <span className="block text-xs text-nc-text-3 tabular-nums">
                  {row.original.bar}
                </span>
                <span
                  className="block text-sm font-medium"
                  title={`${row.original.strategyId} v${row.original.version}`}
                >
                  {strategyDisplayName(row.original.strategyId, strategyNames)}
                </span>
              </div>
            ),
          },
          {
            id: "symbol",
            header: "标的 / 信号",
            cell: ({ row }) => {
              const { type, symbol, market } = row.original;
              const group = groupForKind(type);
              const badge = group ? signalBadges[group.id] : undefined;
              const prefix = type === "paper-fill" ? "成交" : badge?.prefix;
              return (
                <div className="flex flex-col items-start gap-1">
                  <Link
                    href={alertChartHref(row.original)}
                    className="font-medium text-nc-accent hover:underline"
                    title="打开行情图表"
                  >
                    {symbolLabel(symbol, market)}
                  </Link>
                  <Pill tone={badge?.tone} className="whitespace-nowrap">
                    {prefix && `${prefix}·`}
                    {alertKindLabels[type]}
                  </Pill>
                </div>
              );
            },
          },
          {
            id: "mode",
            header: "状态",
            cell: ({ row }) =>
              `${alertModeLabels[row.original.mode]} · ${
                row.original.status === "missed" ? "错过窗口" : "已记录"
              }`,
          },
          {
            id: "reason",
            header: "信号说明",
            cell: ({ row }) => (
              <p
                className="m-0 max-w-md whitespace-normal break-words text-xs leading-relaxed text-nc-text-2"
                title={alertDisplayCopy(row.original.reason)}
              >
                {formatAlertReason(row.original)}
              </p>
            ),
          },
          ...([5, 10, 20] as const).map((h) => ({
            id: `t${h}`,
            header: `T+${h}%`,
            cell: ({ row }: { row: { original: AlertEvent } }) => {
              const o = row.original.outcomes.find((v) => v.horizon === h);
              return (
                <span title={o?.reasons.join("；")}>
                  {number(o?.returnPct ?? null)}
                </span>
              );
            },
          })),
          {
            id: "plan",
            header: "计划",
            cell: ({ row }) =>
              row.original.type === "entry" &&
              row.original.status !== "missed" ? (
                <Button
                  size="sm"
                  onClick={() => {
                    const e = row.original;
                    setSelected(e);
                    setEntries(String(e.price ?? ""));
                    setStop(String(e.stop ?? ""));
                    setTarget(String(e.target ?? ""));
                  }}
                >
                  加入计划
                </Button>
              ) : (
                "—"
              ),
          },
        ]}
      />
      {selected && (
        <form
          className="space-y-3 rounded border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!expiry || !Number.isFinite(Date.parse(expiry))) {
              setMessage("请填写有效到期时间");
              return;
            }
            create.mutate({
              eventKey: selected.key,
              stages: entries
                .split(/[,，\s]+/)
                .filter(Boolean)
                .map(Number),
              stop: Number(stop),
              target: target ? Number(target) : null,
              expiresAt: new Date(expiry).toISOString(),
              ...(selected.market === "crypto"
                ? {
                    quantityRules: {
                      step: Number(step),
                      minimum: Number(minimum),
                      source: rulesSource,
                    },
                  }
                : {}),
            });
          }}
        >
          <h2>
            <Link
              href={alertChartHref(selected)}
              className="font-medium text-nc-accent hover:underline"
              title="打开行情图表"
            >
              {symbolLabel(selected.symbol, selected.market)}
            </Link>{" "}
            · {sleeveDisplayName(selected.sleeve)} 加入计划
          </h2>
          <div className="flex flex-wrap gap-3">
            <LedgerInput
              label="分批入场价（逗号分隔）"
              value={entries}
              onChange={setEntries}
            />
            <LedgerInput label="计划止损" value={stop} onChange={setStop} />
            <LedgerInput
              label="计划目标（可空）"
              value={target}
              onChange={setTarget}
            />
            <LedgerInput
              label="计划到期时间"
              type="datetime-local"
              value={expiry}
              onChange={setExpiry}
            />
            {selected.market === "crypto" && (
              <>
                <LedgerInput
                  label="平台数量步长"
                  value={step}
                  onChange={setStep}
                />
                <LedgerInput
                  label="平台最小数量"
                  value={minimum}
                  onChange={setMinimum}
                />
                <LedgerInput
                  label="数量规则来源"
                  value={rulesSource}
                  onChange={setRulesSource}
                />
              </>
            )}
          </div>
          <p>
            数量复用所选策略的分仓风险与剩余额度，已预留撮合费用；实际成交与滑点需核对。分批档位均为向上达到入场价后提醒。
          </p>
          <Button disabled={create.isPending}>保存交易计划</Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setSelected(null)}
          >
            关闭
          </Button>
        </form>
      )}
      <h2>交易计划</h2>
      <DataTable
        label="交易计划"
        data={planRows.rows}
        rowCount={planRows.total}
        loading={plans.isFetching}
        error={plans.error?.message}
        onRetry={() => void plans.refetch()}
        infiniteScroll={{
          hasMore: planRows.hasMore,
          loadingMore: planCursor.pageIndex > 0 && plans.isFetching,
          onLoadMore: planCursor.loadMore,
        }}
        sorting={[]}
        onSortingChange={() => {}}
        getRowId={(p) => p.id}
        columns={[
          {
            id: "symbol",
            header: "标的 / 分仓",
            cell: ({ row }) => (
              <div className="space-y-1">
                <Link
                  href={alertChartHref({
                    symbol: row.original.symbol,
                    market: row.original.market,
                  })}
                  className="font-medium text-nc-accent hover:underline"
                  title="打开行情图表"
                >
                  {symbolLabel(row.original.symbol, row.original.market)}
                </Link>
                <span className="block text-xs text-nc-text-3">
                  {sleeveDisplayName(row.original.sleeve)}
                </span>
              </div>
            ),
          },
          {
            id: "entry",
            header: "入场/数量/止损/目标",
            cell: ({ row }) =>
              `${row.original.entry} / ${row.original.quantity ?? "—"} / ${row.original.stop ?? "—"} / ${row.original.target ?? "—"}`,
          },
          {
            id: "expiry",
            header: "到期/状态",
            cell: ({ row }) =>
              `${row.original.expiresAt ?? "—"} / ${row.original.closeReason === "cancelled" ? "已取消" : row.original.status === "expired" ? "已到期" : row.original.status === "closed" ? "触发完成" : "待触发"}`,
          },
          {
            id: "cancel",
            header: "管理",
            cell: ({ row }) =>
              row.original.status === "open" ? (
                <Button
                  size="sm"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(row.original.id)}
                >
                  取消计划
                </Button>
              ) : (
                "—"
              ),
          },
        ]}
      />
      {message && <p role="status">{message}</p>}
    </div>
  );
}
