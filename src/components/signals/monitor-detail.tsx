"use client";
import { useEffect, useRef, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { useTaskVisible } from "../workbench/use-task-visible";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { CalendarEvidence } from "../workbench/shared";
import { TradingStatusEvidence } from "./trading-status-evidence";
import {
  MonitorError,
  MonitorEvidence,
  MonitorText,
  deliveryLabels,
  monitorTime,
} from "./monitor-workspace-fields";
export type MonitorSelectionKind = "monitor" | "signal" | "delivery";
export type MonitorDetailValue = NonNullable<
  RouterOutputs["monitorWorkspaceDetail"]
>;
export function MonitorDetail({
  kind,
  id,
  onBack,
  onEdit,
  onRelated,
  onChanged,
}: {
  kind: MonitorSelectionKind;
  id: string;
  onBack: () => void;
  onEdit: (value: MonitorDetailValue) => void;
  onRelated: (signalId: string) => void;
  onChanged: () => void;
}) {
  const visible = useTaskVisible(),
    live = useRef(visible),
    utils = api.useUtils();
  live.current = visible;
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const monitor = api.monitorWorkspaceDetail.useQuery(id, {
    enabled: visible && kind === "monitor",
    gcTime: 0,
  });
  const signal = api.signalWorkspaceDetail.useQuery(id, {
    enabled: visible && kind === "signal",
    gcTime: 0,
  });
  const delivery = api.deliveryWorkspaceDetail.useQuery(id, {
    enabled: visible && kind === "delivery",
    gcTime: 0,
    refetchInterval: (query) =>
      visible && ["pending", "sending"].includes(query.state.data?.status ?? "")
        ? 4000
        : false,
  });
  const active =
    kind === "monitor" ? monitor : kind === "signal" ? signal : delivery;
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<{
    deliveryId: string;
    requestId: string;
    expectedChannelVersion: string;
    title: string;
    channel: string;
    target: string;
    createdAt: number;
    reason: string;
  } | null>(null);
  const toggle = api.monitorWorkspaceToggle.useMutation({
    gcTime: 0,
    onSuccess: async () => {
      onChanged();
      if (live.current) await monitor.refetch();
      setNotice("订阅状态已保存；恢复后重新建立基线。");
    },
    onError: (cause) => setError(cause.message),
  });
  const resend = api.deliveryWorkspaceConfirm.useMutation({
    gcTime: 0,
    onSuccess: (value) => {
      onChanged();
      setConfirm(null);
      setNotice(`已加入人工重发队列：${value.id}。原投递记录保留。`);
      setError("");
    },
    onError: (cause) => setError(cause.message),
  });
  const exportInput = { kind, id };
  const evidence = api.monitorWorkspaceExport.useQuery(exportInput, {
    enabled: false,
    gcTime: 0,
  });
  async function download() {
    let href: string | undefined;
    try {
      setError("");
      const result = await evidence.refetch();
      if (result.error) throw result.error;
      if (!result.data?.value) throw new Error("记录不存在，无法导出");
      href = URL.createObjectURL(
        new Blob([JSON.stringify(result.data, null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = href;
      a.download = `signals-${kind}-${id.replace(/[^\w-]/g, "_")}.json`;
      a.click();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导出失败");
    } finally {
      if (href) URL.revokeObjectURL(href);
      await utils.monitorWorkspaceExport.reset(exportInput);
    }
  }
  const m = monitor.data,
    s = signal.data,
    d = delivery.data;
  return (
    <section aria-label="监控记录详情" className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={onBack}>
          返回列表
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={active.isFetching}
          onClick={() => void active.refetch()}
        >
          {active.isFetching ? "正在刷新…" : "刷新详情"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={evidence.isFetching || !active.data}
          onClick={() => void download()}
        >
          {evidence.isFetching ? "正在导出…" : "导出完整证据"}
        </Button>
      </div>
      <MonitorError error={active.error} retry={() => void active.refetch()} />
      {active.isLoading && <p role="status">正在读取记录…</p>}
      {active.isSuccess && !active.data && (
        <p>记录不存在或已被清理，请返回列表刷新。</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-nc-bad">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="break-all text-sm">
          {notice}
        </p>
      )}
      {kind === "monitor" && m && (
        <>
          <h3 className="text-lg font-medium">{m.name}</h3>
          <p className="text-sm">
            {m.enabled ? "已启用" : "已暂停"} · {m.strategy.name} · {m.period} ·{" "}
            {m.source}
          </p>
          <p className="break-words text-sm">证券：{m.symbols.join("、")}</p>
          <p className="text-sm">最近检查：{monitorTime(m.lastCheck)}</p>
          {m.error && (
            <p className="text-sm text-nc-bad">最近检查异常：{m.error}</p>
          )}
          <p className="text-xs text-nc-text-3">
            启用状态不代表行情或后台健康。本机退出、休眠后监控停止。
          </p>
          {m.source === "mcp" && (
            <p className="text-sm text-nc-warn">
              原MCP源已停用；编辑后将默认选择本地源，请核对后保存。
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => onEdit(m)}>编辑订阅</Button>
            <Button
              variant="outline"
              disabled={toggle.isPending}
              onClick={() => {
                setError("");
                toggle.mutate({
                  id: m.id,
                  enabled: !m.enabled,
                  expectedVersion: m.configurationVersion,
                });
              }}
            >
              {toggle.isPending
                ? "正在更新…"
                : m.enabled
                  ? "暂停订阅"
                  : "恢复订阅并重建基线"}
            </Button>
          </div>
          <CalendarEvidence evidence={m.calendarEvidence} />
          {Object.values(m.tradingStatusChecks ?? {}).map((check) => (
            <TradingStatusEvidence key={check.symbol} value={check} />
          ))}
          <MonitorEvidence value={m} label="订阅配置与核验" />
        </>
      )}
      {kind === "signal" && s && (
        <>
          <h3 className="text-lg font-medium">
            {s.symbol.toUpperCase()} · {s.strategy.name}
          </h3>
          <p className="text-sm">
            触发日 {s.date} · 记录时间 {monitorTime(s.createdAt)}
          </p>
          <p className="text-sm">
            来源 {s.source} · 周期 {s.period} · 规则触发不等于已通知
          </p>
          <p className="break-all text-xs">
            订阅 {s.monitorId} · 版本 {s.monitorRun?.revision ?? "旧记录未提供"}
          </p>
          <Button variant="outline" onClick={() => onRelated(s.id)}>
            查看全部关联投递
          </Button>
          <TradingStatusEvidence value={s.tradingStatusEvidence} />
          <CalendarEvidence evidence={s.calendarEvidence} />
          <h4 className="font-medium">通知决策</h4>
          {s.decisions.length ? (
            s.decisions.map((decision) => (
              <article
                key={decision.id}
                className="rounded border border-nc-border p-3 text-sm"
              >
                <p>
                  {decision.tier} · {monitorTime(decision.createdAt)}
                </p>
                <p>{decision.reasons.join("；") || "未记录额外原因"}</p>
                <MonitorEvidence value={decision} label="决策证据" />
              </article>
            ))
          ) : (
            <p className="text-sm text-nc-text-3">
              未找到归档决策；不能据此判断已发送或被策略过滤。
            </p>
          )}
          <MonitorEvidence value={s} label="信号完整证据" />
        </>
      )}
      {kind === "delivery" && d && (
        <>
          <h3 className="break-words text-lg font-medium">{d.title}</h3>
          <p className="text-sm">
            {deliveryLabels[d.status]} · {monitorTime(d.createdAt)} · 尝试{" "}
            {d.attempts} 次
          </p>
          <p className="text-sm">
            渠道：{d.channel?.name ?? d.channelId} ·{" "}
            {d.channel?.targetHint ?? "渠道不存在"}
          </p>
          <p className="text-xs text-nc-text-3">
            平台接受不代表收件人已读。
            {d.manualRetry ? "本条为独立人工重发，原记录不会改写。" : ""}
          </p>
          {d.sourceDeliveryId && (
            <p className="break-all text-xs">原投递：{d.sourceDeliveryId}</p>
          )}
          {d.manualRetry && !d.sourceDeliveryId && (
            <p className="text-xs text-nc-text-3">
              旧人工记录未保存原投递ID，无法追溯具体来源。
            </p>
          )}
          {d.error && (
            <div>
              <h4>完整错误</h4>
              <MonitorText label="投递错误" text={d.error} />
            </div>
          )}
          {d.remoteId && (
            <p className="break-all text-xs">平台凭据ID：{d.remoteId}</p>
          )}
          <MonitorText label="消息正文" text={d.body} />
          {["failed", "expired", "cancelled"].includes(d.status) && (
            <>
              <Button
                variant="outline"
                disabled={!d.channel?.enabled || !d.channel.configured}
                onClick={() => {
                  if (!d.channel) return;
                  setError("");
                  setConfirm({
                    deliveryId: d.id,
                    requestId: crypto.randomUUID(),
                    expectedChannelVersion: d.channel.destinationVersion,
                    title: d.title,
                    channel: d.channel.name,
                    target: d.channel.targetHint,
                    createdAt: d.createdAt,
                    reason: d.error ?? deliveryLabels[d.status],
                  });
                }}
              >
                核对并人工重发
              </Button>
              {(!d.channel?.enabled || !d.channel.configured) && (
                <p className="text-xs text-nc-text-3">
                  请先在数据与连接中配置并启用原渠道。
                </p>
              )}
            </>
          )}
          {d.decisions.length > 0 && (
            <MonitorEvidence value={d.decisions} label="关联决策" />
          )}
          <MonitorEvidence value={d} label="投递完整证据" />
        </>
      )}
      <Dialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open && !resend.isPending) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogTitle>确认人工重发历史通知</DialogTitle>
          <DialogDescription>
            将创建一条新的人工投递，原失败或取消记录保持不变。此次操作会向以下渠道发送历史正文。
          </DialogDescription>
          {confirm && (
            <div className="space-y-3 text-sm">
              <p className="break-words">{confirm.title}</p>
              <p>
                {confirm.channel} · {confirm.target}
              </p>
              <p>原记录时间：{monitorTime(confirm.createdAt)}</p>
              <p className="break-words">原结果：{confirm.reason}</p>
              {error && (
                <p role="alert" className="text-nc-bad">
                  {error}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={resend.isPending}
                  onClick={() => setConfirm(null)}
                >
                  取消
                </Button>
                <Button
                  disabled={resend.isPending}
                  onClick={() =>
                    resend.mutate({
                      deliveryId: confirm.deliveryId,
                      requestId: confirm.requestId,
                      expectedChannelVersion: confirm.expectedChannelVersion,
                    })
                  }
                >
                  {resend.isPending ? "正在提交…" : "确认重发"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
