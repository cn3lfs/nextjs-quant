import { Input } from "~/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "~/components/ui/select";
import { Checkbox } from "~/components/ui/checkbox";
import { ChevronRight, Plus, Radio, Send } from "lucide-react";
import { type Period } from "~/lib/domain";
import { securityDisplayName } from "~/lib/security-display";
import { TradingStatusEvidence } from "../trading-status-evidence";
import { Button } from "../ui/button";

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
    <>
      <section className="panel">
        <div className="panel-title">
          <Radio size={18} />
          <h3>新建监控订阅</h3>
        </div>
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
          <Select
            value={monitorSource}
            onValueChange={(selected) =>
              setMonitorSource(selected as "local" | "mcp")
            }
          >
            <SelectTrigger aria-label="监控数据源" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mcp">通达信 MCP（最新行情）</SelectItem>
              <SelectItem value="local">
                本地通达信文件（需自行更新）
              </SelectItem>
            </SelectContent>
          </Select>
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
        <p className="muted">
          首次建立基线，不发送历史信号。需要本交易日已完成行情；MCP
          监控自动查询，本地模式需通达信更新文件。新信号还需通过同花顺问财当日交易状态核验，未知或停牌时暂停该证券信号。点击窗口右上角
          × 会退出应用并停止监控，电脑休眠时也会停止监控。
        </p>
      </section>
      <section className="panel">
        <div className="panel-title">
          <h3>运行中的订阅</h3>
        </div>
        {monitors.data?.length ? (
          monitors.data.map((m) => (
            <div className="list-row" key={m.id}>
              <div>
                <strong>{m.name}</strong>
                <p>
                  {m.symbols
                    .map(
                      (s) =>
                        `${securityDisplayName(s, names)} (${s.toUpperCase()})`,
                    )
                    .join("、")}{" "}
                  · {m.period} · {m.source === "mcp" ? "MCP" : "本地"} ·{" "}
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
      </section>
      <section className="panel">
        <div className="panel-title">
          <h3>信号记录</h3>
          <span className="tag">{signals.data?.length ?? 0}</span>
        </div>
        {signals.data?.length ? (
          signals.data.map((s) => (
            <div className="list-row" key={s.id}>
              <div>
                <strong>
                  {securityDisplayName(s.symbol, names)} (
                  {s.symbol.toUpperCase()}) · {s.strategy.name}
                </strong>
                <p>
                  {s.date} · 收盘 {fmt(s.metrics.close)} · {s.id}
                </p>
                <CalendarEvidence evidence={s.calendarEvidence} />
                <TradingStatusEvidence value={s.tradingStatusEvidence} />
              </div>
              <span className="tag">规则触发</span>
            </div>
          ))
        ) : (
          <Empty>尚无新信号。历史导入与回测不会发送通知。</Empty>
        )}
      </section>
      <section className="panel">
        <div className="panel-title">
          <Send size={17} />
          <h3>投递历史</h3>
          <Button size="sm" variant="ghost" onClick={() => setTab("settings")}>
            管理渠道 <ChevronRight size={13} />
          </Button>
        </div>
        {deliveries.data?.length ? (
          deliveries.data.map((d) => (
            <div className="list-row" key={d.id}>
              <div>
                <strong>
                  {d.title} ·{" "}
                  {channels.data?.find((c) => c.id === d.channelId)?.name ??
                    d.channelId}
                </strong>
                <p>
                  {stamp(d.createdAt)} · 尝试 {d.attempts} 次 ·{" "}
                  {d.error ?? d.remoteId ?? ""}
                </p>
                <details>
                  <summary>消息内容</summary>
                  <pre>{d.body}</pre>
                </details>
              </div>
              <span className="tag">
                {
                  {
                    pending: "待发送",
                    sending: "发送中",
                    sent: "平台已接受",
                    failed: "失败",
                    expired: "已过期",
                    cancelled: "已取消",
                  }[d.status]
                }
              </span>
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
          ))
        ) : (
          <Empty>配置并启用渠道后，新信号将在此显示投递状态。</Empty>
        )}
      </section>
    </>
  );
}
