"use client";
import type { Channel } from "~/lib/domain";
import type { MonitorDraft } from "~/lib/strategy-facts/monitor-workspace-draft";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Field } from "../workbench/shared";
import { StrategyFields } from "../workbench/strategy-fields";
import { MarketSourceSelect } from "../market/market-source-select";
import { MonitorSelect } from "./monitor-workspace-fields";
export function MonitorEditor({
  draft,
  channels,
  watchlist,
  busy,
  error,
  onChange,
  onSave,
  onClose,
  onReload,
}: {
  draft: MonitorDraft;
  channels: Channel[];
  watchlist: readonly string[];
  busy: boolean;
  error?: string;
  onChange: (patch: Partial<MonitorDraft>) => void;
  onSave: () => void;
  onClose: () => void;
  onReload?: () => void;
}) {
  const type = draft.strategy.type ?? "ma-cross";
  return (
    <section aria-label="订阅编辑" className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3>
          {draft.id ? "编辑订阅" : "新建订阅"}
          {draft.dirty ? " · 未保存" : ""}
        </h3>
        <Button variant="outline" size="sm" onClick={onClose}>
          返回订阅
        </Button>
      </div>
      <p className="text-xs text-nc-text-3">
        修改配置或恢复订阅会重新建立基线，不补发历史信号。本机退出或休眠时监控停止。
      </p>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <Field label="订阅名称">
          <Input
            value={draft.name}
            maxLength={80}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </Field>
        <Field label="证券代码（留空使用当前自选）">
          <Input
            value={draft.symbolText}
            onChange={(event) => onChange({ symbolText: event.target.value })}
            placeholder="sh600519, sz000001"
          />
        </Field>
        <p className="break-words text-xs text-nc-text-3">
          {draft.symbolText.trim()
            ? "最多20个证券，逗号或空格分隔。"
            : `本次将使用自选快照（${watchlist.length}个）：${watchlist.join("、") || "暂无自选，请填写证券"}`}
        </p>
        <Field label="订阅策略">
          <MonitorSelect
            label="订阅策略"
            value={type}
            options={[
              { value: "ma-cross", label: "双均线趋势" },
              { value: "czsc", label: "缠论买卖点" },
              { value: "dual-breakout", label: "双突破" },
            ]}
            onChange={(next) =>
              onChange({
                strategy:
                  next === "ma-cross"
                    ? { ...draft.strategy, type: undefined }
                    : next === "czsc"
                      ? {
                          ...draft.strategy,
                          type: "czsc",
                          params: { config: 0 },
                        }
                      : {
                          ...draft.strategy,
                          type: "dual-breakout",
                          params: {},
                        },
                period: next === "ma-cross" ? draft.period : "day",
              })
            }
          />
        </Field>
        {type === "ma-cross" ? (
          <>
            <MonitorSelect
              label="订阅周期"
              value={draft.period}
              options={[
                { value: "day", label: "日线" },
                { value: "5m", label: "五分钟线" },
              ]}
              onChange={(value) =>
                onChange({ period: value as MonitorDraft["period"] })
              }
            />
            <StrategyFields
              strategy={draft.strategy}
              setStrategy={(strategy) => onChange({ strategy })}
            />
          </>
        ) : (
          <p className="text-sm">
            {type === "czsc"
              ? "日线15:05后核对缠论确认及强质量买卖点；配置0。"
              : "日线15:05后核对双突破规则与质量；向下突破仅为破位观察。"}
          </p>
        )}
        <Field label="订阅数据源">
          <MarketSourceSelect
            value={draft.source}
            onChange={(source) => onChange({ source })}
          />
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-sm">通知渠道（可不选，仅保留信号）</legend>
          {channels.length ? (
            channels.map((channel) => (
              <label
                key={channel.id}
                className="flex items-center gap-2 text-sm"
              >
                <Checkbox
                  checked={draft.channels.includes(channel.id)}
                  onCheckedChange={(checked) =>
                    onChange({
                      channels:
                        checked === true
                          ? [...draft.channels, channel.id]
                          : draft.channels.filter((id) => id !== channel.id),
                    })
                  }
                />
                {channel.name}
                {!channel.enabled ? "（未启用）" : ""}
                {!channel.configured ? "（未配置）" : ""}
              </label>
            ))
          ) : (
            <p className="text-xs text-nc-text-3">
              暂无渠道，可前往数据与连接配置。
            </p>
          )}
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.ai}
            onCheckedChange={(checked) => onChange({ ai: checked === true })}
          />
          新信号后附加AI解读
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.enabled}
            onCheckedChange={(checked) =>
              onChange({ enabled: checked === true })
            }
          />
          保存后启用监控
        </label>
        {error && (
          <div role="alert" className="space-y-2 text-sm text-nc-bad">
            <p>{error}</p>
            {onReload && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onReload}
              >
                重新读取配置（保留草稿）
              </Button>
            )}
          </div>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? "正在保存…" : draft.enabled ? "保存并启用" : "保存订阅"}
        </Button>
      </form>
    </section>
  );
}
