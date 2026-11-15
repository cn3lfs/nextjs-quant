"use client";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "~/trpc/react";
import {
  alertHistorySchema,
  alertKinds,
  alertKindLabels,
  alertModes,
  alertModeLabels,
  type AlertEvent,
} from "~/lib/strategy-facts/alerts";
import { useTaskVisible } from "../workbench/use-task-visible";
import { Button } from "../ui/button";
import { DataTable } from "../ui/data-table";
import { LedgerInput, LedgerSelect } from "./ledger-fields";
import { AlertStatus } from "./alert-status";
import { SignalLedgerWorkspace } from "./signal-ledger-workspace";

export function AlertWorkspace() {
  const visible = useTaskVisible();
  const search = useSearchParams();
  const [filter, setFilter] = useState(() =>
    alertHistorySchema.parse({
      key: search.get("event") ?? undefined,
      strategyId: search.get("strategy") ?? "",
    }),
  );
  const [message, setMessage] = useState("");
  const [legacy, setLegacy] = useState(false);
  const [selected, setSelected] = useState<AlertEvent | null>(null);
  const [entries, setEntries] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [expiry, setExpiry] = useState("");
  const [step, setStep] = useState("");
  const [minimum, setMinimum] = useState("");
  const [rulesSource, setRulesSource] = useState("");
  const [planPage, setPlanPage] = useState(0);
  const history = api.alertHistory.useQuery(filter, {
    enabled: visible && !legacy,
    refetchInterval: visible && !legacy ? 30000 : false,
  });
  const plans = api.alertPlans.useQuery(
    { page: planPage, id: search.get("plan") ?? undefined },
    { enabled: visible && !legacy },
  );
  const utils = api.useUtils();
  const create = api.createAlertPlan.useMutation({
    onSuccess: () => {
      setMessage("交易计划已保存；仅提醒，须人工交易");
      setSelected(null);
      void utils.alertPlans.invalidate();
    },
    onError: (e) => setMessage(e.message),
  });
  const cancel = api.cancelAlertPlan.useMutation({
    onSuccess: () => {
      void utils.alertPlans.invalidate();
    },
    onError: (e) => setMessage(e.message),
  });
  const exportHistory = api.exportAlertHistory.useMutation({
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
  return (
    <div className="space-y-4 p-4">
      <h1>提醒历史与交易计划</h1>
      <AlertStatus />
      <Button variant="outline" onClick={() => setLegacy(!legacy)}>
        {legacy ? "返回提醒历史" : "查看旧信号台账"}
      </Button>
      {legacy ? (
        <SignalLedgerWorkspace />
      ) : (
        <>
          <p className="text-xs text-nc-text-3">
            T为实际观察日；T+1开盘入场、T+5/10/20收盘，原价无成本滑点；A股按交易日、数字货币按UTC自然日。缺行情和除权证据留空。非策略业绩。
          </p>
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
              onChange={(kind) =>
                change({
                  kind: kind ? (kind as typeof filter.kind) : undefined,
                })
              }
              options={[
                { value: "all", label: "全部" },
                ...alertKinds.map((value) => ({
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
              onClick={() => exportHistory.mutate(filter)}
            >
              导出提醒历史
            </Button>
          </div>
          <DataTable
            label="提醒历史"
            data={history.data?.items ?? []}
            rowCount={history.data?.total ?? 0}
            loading={history.isFetching}
            error={history.error?.message}
            onRetry={() => {
              void history.refetch();
            }}
            pagination={{ pageIndex: filter.page, pageSize: filter.size }}
            onPaginationChange={(updater) => {
              const next =
                typeof updater === "function"
                  ? updater({ pageIndex: filter.page, pageSize: filter.size })
                  : updater;
              setFilter({
                ...filter,
                page: next.pageIndex,
                size: next.pageSize,
              });
            }}
            sorting={[]}
            onSortingChange={() => {}}
            getRowId={(r) => r.key}
            columns={[
              {
                id: "bar",
                header: "完成行情/策略",
                cell: ({ row }) => (
                  <span>
                    {row.original.bar}
                    <br />
                    {row.original.strategyId} v{row.original.version}
                  </span>
                ),
              },
              {
                id: "symbol",
                header: "证券/类型",
                cell: ({ row }) =>
                  `${row.original.symbol} / ${alertKindLabels[row.original.type]}`,
              },
              {
                id: "mode",
                header: "模式/状态",
                cell: ({ row }) =>
                  `${alertModeLabels[row.original.mode]} / ${row.original.status === "missed" ? "错过窗口" : "已记录"}`,
              },
              {
                id: "reason",
                header: "触发依据",
                cell: ({ row }) => row.original.reason,
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
                {selected.symbol} · {selected.sleeve} 加入计划
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
                数量按分仓单笔风险和剩余额度计算；不含费用滑点。分批档位均为向上达到入场价后提醒。
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
          {plans.error && <p role="alert">{plans.error.message}</p>}
          <DataTable
            label="交易计划"
            data={plans.data?.items ?? []}
            rowCount={plans.data?.total ?? 0}
            pagination={{ pageIndex: planPage, pageSize: 20 }}
            onPaginationChange={(updater) => {
              const next =
                typeof updater === "function"
                  ? updater({ pageIndex: planPage, pageSize: 20 })
                  : updater;
              setPlanPage(next.pageIndex);
            }}
            sorting={[]}
            onSortingChange={() => {}}
            getRowId={(p) => p.id}
            columns={[
              {
                id: "symbol",
                header: "证券/分仓",
                cell: ({ row }) =>
                  `${row.original.symbol} / ${row.original.sleeve}`,
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
        </>
      )}
    </div>
  );
}
