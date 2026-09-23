import { MarketSourceSelect } from "../market/market-source-select";
import { marketSourceLabels } from "~/lib/market-source";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "~/components/ui/select";
import { Checkbox } from "~/components/ui/checkbox";
import { ChevronRight, Plus } from "lucide-react";
import { type Period } from "~/lib/domain";
import { securityDisplayName } from "~/lib/security-display";
import { TradingStatusEvidence } from "../signals/trading-status-evidence";
import { Button } from "../ui/button";
import { Broadcast, Lightning, PaperPlaneTilt } from "@phosphor-icons/react";
import { GridTable, PageGrid, Panel, Pill, SecurityCell } from "../panels";
import { SignalStats } from "../signals/signal-stats";

import { CalendarEvidence, Empty, Field, fmt, stamp } from "./shared";
import { StrategyFields } from "./strategy-fields";
import { type WorkbenchState } from "./use-workbench-state";

export function SignalsView({
  state,
}: {
  state: Pick<
    WorkbenchState,
    | "setTab"
    | "period"
    | "setPeriod"
    | "strategy"
    | "setStrategy"
    | "universe"
    | "setUniverse"
    | "names"
    | "channels"
    | "monitors"
    | "signals"
    | "deliveries"
    | "saveMonitor"
    | "toggleMonitor"
    | "retry"
    | "monitorType"
    | "setMonitorType"
    | "monitorName"
    | "setMonitorName"
    | "monitorChannels"
    | "setMonitorChannels"
    | "monitorAi"
    | "setMonitorAi"
    | "monitorSource"
    | "setMonitorSource"
    | "watchlist"
    | "symbols"
  >;
}) {
  const {
    setTab,
    period,
    setPeriod,
    strategy,
    setStrategy,
    universe,
    setUniverse,
    names,
    channels,
    monitors,
    signals,
    deliveries,
    saveMonitor,
    toggleMonitor,
    retry,
    monitorType,
    setMonitorType,
    monitorName,
    setMonitorName,
    monitorChannels,
    setMonitorChannels,
    monitorAi,
    setMonitorAi,
    monitorSource,
    setMonitorSource,
    watchlist,
    symbols,
  } = state;
  return (
    <PageGrid>
      <SignalStats
        monitors={monitors.data ?? []}
        signals={signals.data ?? []}
        deliveries={deliveries.data ?? []}
      />
      {/* The subscription form stays first in source order; `order-last` puts
          it after the lists on screen. */}
      <Panel
        className="order-last"
        icon={Broadcast}
        title="新建监控订阅"
        note="首次建立基线，不发送历史信号。需要本交易日已完成行情；免费在线源监控自动查询，本地模式需通达信更新文件。新信号还需通过同花顺问财当日交易状态核验，未知或停牌时暂停该证券信号。点击窗口右上角 × 会退出应用并停止监控，电脑休眠时也会停止监控。"
      >
        <div className="form-grid">
          <Field label="监控名称">
            <Input
              value={monitorName}
              onChange={(e) => setMonitorName(e.target.value)}
            />
          </Field>
          <Field label="证券池（留空使用自选）">
            <Input
              value={universe}
              onChange={(e) => setUniverse(e.target.value)}
              placeholder={watchlist.join(",")}
            />
          </Field>
          <Field label="监控策略">
            <Select
              value={monitorType}
              onValueChange={(selected) => {
                setMonitorType(
                  selected as "ma-cross" | "czsc" | "dual-breakout",
                );
                if (selected !== "ma-cross") setPeriod("day");
              }}
            >
              <SelectTrigger aria-label="监控策略" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ma-cross">双均线趋势</SelectItem>
                <SelectItem value="czsc">缠论买卖点（确认及以上）</SelectItem>
                <SelectItem value="dual-breakout">双突破（日线）</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="周期">
            <Select
              value={monitorType !== "ma-cross" ? "day" : period}
              disabled={monitorType !== "ma-cross"}
              onValueChange={(selected) => setPeriod(selected as Period)}
            >
              <SelectTrigger aria-label="周期" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">日线</SelectItem>
                <SelectItem value="5m">五分钟线</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        {monitorType === "ma-cross" ? (
          <StrategyFields strategy={strategy} setStrategy={setStrategy} />
        ) : (
          <p className="muted">
            日线 15:05 后检查一、二、三类买卖点；使用严格笔中枢（配置
            0），仅确认及强质量。
          </p>
        )}
        <Field label="监控数据源">
          <MarketSourceSelect
            value={monitorSource}
            onChange={setMonitorSource}
          />
        </Field>
        <div className="check-row">
          {channels.data?.map((c) => (
            <label key={c.id}>
              <Checkbox
                checked={monitorChannels.includes(c.id)}
                onCheckedChange={(checked) =>
                  setMonitorChannels(
                    checked === true
                      ? [...monitorChannels, c.id]
                      : monitorChannels.filter((id) => id !== c.id),
                  )
                }
              />
              {c.name}
              {!c.enabled ? "（渠道未启用）" : ""}
            </label>
          ))}
          <label>
            <Checkbox
              checked={monitorAi}
              onCheckedChange={(checked) => setMonitorAi(checked === true)}
            />
            信号后附加 AI 解读
          </label>
        </div>
        <Button
          onClick={() =>
            saveMonitor.mutate({
              name: monitorName,
              symbols: symbols() ?? watchlist,
              strategy:
                monitorType === "dual-breakout"
                  ? { type: "dual-breakout", params: {} }
                  : monitorType === "czsc"
                    ? { type: "czsc", params: { config: 0 } }
                    : strategy,
              period: monitorType !== "ma-cross" ? "day" : period,
              source: monitorSource,
              channels: monitorChannels,
              ai: monitorAi,
              enabled: true,
            })
          }
        >
          <Plus size={15} />
          启用监控
        </Button>
      </Panel>
      <Panel
        span={5}
        className="order-2"
        icon={Broadcast}
        title="运行中的订阅"
        meta={`${monitors.data?.filter((m) => m.enabled).length ?? 0} 个运行中`}
      >
        {monitors.data?.length ? (
          monitors.data.map((m) => (
            <div className="list-row" key={m.id}>
              <div>
                <div className="flex items-center gap-2">
                  <strong>{m.name}</strong>
                  <Pill tone={m.error ? "bad" : m.enabled ? "ok" : "idle"}>
                    {m.error ? "异常" : m.enabled ? "运行中" : "已暂停"}
                  </Pill>
                </div>
                <p>
                  {m.symbols
                    .map(
                      (s) =>
                        `${securityDisplayName(s, names)} (${s.toUpperCase()})`,
                    )
                    .join("、")}{" "}
                  · {m.period} ·{" "}
                  {m.source === "mcp"
                    ? "已停用（请重建监控）"
                    : marketSourceLabels[m.source]}{" "}
                  ·{" "}
                  {m.error ??
                    (m.lastCheck
                      ? `检查于 ${stamp(m.lastCheck)}`
                      : "等待首次检查")}
                </p>
                <CalendarEvidence evidence={m.calendarEvidence} />
                {Object.values(m.tradingStatusChecks ?? {}).map((check) => (
                  <TradingStatusEvidence key={check.symbol} value={check} />
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  toggleMonitor.mutate({
                    id: m.id,
                    enabled: !m.enabled,
                  })
                }
              >
                {m.enabled ? "暂停" : "启用"}
              </Button>
            </div>
          ))
        ) : (
          <Empty>添加一个策略订阅，开始跟踪新信号。</Empty>
        )}
      </Panel>
      <Panel
        span={7}
        className="order-1"
        icon={Lightning}
        title="信号记录"
        tag={signals.data?.length ?? 0}
        note="历史导入与回测不会发送通知；新信号须通过当日交易状态核验。"
      >
        <GridTable
          label="信号记录"
          minWidth={560}
          rows={signals.data ?? []}
          rowKey={(s) => s.id}
          empty="尚无新信号。历史导入与回测不会发送通知。"
          columns={[
            {
              key: "security",
              header: "证券",
              width: "1.3fr",
              cell: (s) => (
                <SecurityCell
                  name={securityDisplayName(s.symbol, names)}
                  code={s.symbol.toUpperCase()}
                  extra={`收盘 ${fmt(s.metrics.close)}`}
                />
              ),
            },
            {
              key: "strategy",
              header: "策略",
              width: "1.1fr",
              cell: (s) => (
                <span className="text-nc-text-2" title={s.id}>
                  {s.strategy.name}
                </span>
              ),
            },
            {
              key: "date",
              header: "触发",
              width: "0.8fr",
              cell: (s) => <span className="text-nc-text-3">{s.date}</span>,
            },
            {
              key: "check",
              header: "核验",
              width: "1.6fr",
              cell: (s) => (
                <div className="min-w-0 [&_details]:my-0">
                  <TradingStatusEvidence value={s.tradingStatusEvidence} />
                  <CalendarEvidence evidence={s.calendarEvidence} />
                </div>
              ),
            },
            {
              key: "send",
              header: "投递",
              width: "0.9fr",
              cell: (s) => {
                const delivery = deliveries.data?.find(
                  (d) => d.signalId === s.id,
                );
                return delivery ? (
                  <Pill
                    tone={
                      delivery.status === "sent"
                        ? "ok"
                        : delivery.status === "failed"
                          ? "bad"
                          : delivery.status === "pending" ||
                              delivery.status === "sending"
                            ? "accent"
                            : "idle"
                    }
                  >
                    {deliveryLabels[delivery.status]}
                  </Pill>
                ) : (
                  <Pill tone="idle">规则触发</Pill>
                );
              },
            },
          ]}
        />
      </Panel>
      <Panel
        className="order-3"
        icon={PaperPlaneTilt}
        title="投递历史"
        actions={
          <Button size="sm" variant="ghost" onClick={() => setTab("settings")}>
            管理渠道 <ChevronRight size={13} />
          </Button>
        }
      >
        <GridTable
          label="投递历史"
          minWidth={720}
          rows={deliveries.data ?? []}
          rowKey={(d) => d.id}
          empty="配置并启用渠道后，新信号将在此显示投递状态。"
          columns={[
            {
              key: "message",
              header: "消息",
              width: "1.8fr",
              cell: (d) => (
                <div className="min-w-0">
                  <strong className="block truncate font-medium">
                    {d.title}
                  </strong>
                  <details className="my-0">
                    <summary>消息内容</summary>
                    <pre>{d.body}</pre>
                  </details>
                </div>
              ),
            },
            {
              key: "channel",
              header: "渠道",
              width: "1fr",
              cell: (d) => (
                <span className="text-nc-text-3">
                  {channels.data?.find((c) => c.id === d.channelId)?.name ??
                    d.channelId}
                </span>
              ),
            },
            {
              key: "time",
              header: "时间",
              width: "1.1fr",
              cell: (d) => (
                <span className="text-nc-text-3">{stamp(d.createdAt)}</span>
              ),
            },
            {
              key: "attempts",
              header: "尝试",
              width: "0.5fr",
              cell: (d) => <span className="text-nc-text-3">{d.attempts}</span>,
            },
            {
              key: "result",
              header: "结果",
              width: "1.4fr",
              cell: (d) => (
                <span
                  className="block truncate text-nc-text-3"
                  title={d.error ?? d.remoteId ?? ""}
                >
                  {d.error ?? d.remoteId ?? ""}
                </span>
              ),
            },
            {
              key: "status",
              header: "状态",
              width: "1.2fr",
              align: "right",
              cell: (d) => (
                <div className="flex items-center justify-end gap-2">
                  <Pill
                    tone={
                      d.status === "sent"
                        ? "ok"
                        : d.status === "failed"
                          ? "bad"
                          : d.status === "pending" || d.status === "sending"
                            ? "accent"
                            : "idle"
                    }
                  >
                    {deliveryLabels[d.status]}
                  </Pill>
                  {["failed", "expired", "cancelled"].includes(d.status) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => retry.mutate(d.id)}
                    >
                      手动重发
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Panel>
    </PageGrid>
  );
}

const deliveryLabels = {
  pending: "待发送",
  sending: "发送中",
  sent: "平台已接受",
  failed: "失败",
  expired: "已过期",
  cancelled: "已取消",
} as const;
