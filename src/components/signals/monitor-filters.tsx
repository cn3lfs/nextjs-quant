"use client";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import type { Channel } from "~/lib/domain";
import { MonitorSelect, deliveryLabels } from "./monitor-workspace-fields";
export type MonitorTab = "monitors" | "signals" | "deliveries";
export type MonitorFilters = {
  query: string;
  from?: string;
  to?: string;
  enabled?: boolean;
  strategy?: "ma-cross" | "czsc" | "dual-breakout";
  symbol?: string;
  monitorId?: string;
  signalId?: string;
  channelId?: string;
  status?: keyof typeof deliveryLabels;
  kind?: "signal" | "analysis" | "test" | "summary";
};
export function MonitorFiltersForm({
  tab,
  value,
  channels,
  onChange,
  onSubmit,
  onReset,
}: {
  tab: MonitorTab;
  value: MonitorFilters;
  channels: Channel[];
  onChange: (patch: Partial<MonitorFilters>) => void;
  onSubmit: () => void;
  onReset: () => void;
}) {
  return (
    <form
      aria-label="监控历史筛选"
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className="block space-y-1 text-sm">
        {tab === "monitors"
          ? "订阅名称或证券"
          : tab === "signals"
            ? "证券、策略名称或信号ID"
            : "消息标题或投递ID"}
        <Input
          aria-label="历史关键词"
          maxLength={100}
          value={value.query}
          onChange={(event) => onChange({ query: event.target.value })}
        />
      </label>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {tab !== "deliveries" && (
          <>
            <MonitorSelect
              label="策略筛选"
              value={value.strategy ?? "all"}
              options={[
                { value: "all", label: "全部策略" },
                { value: "ma-cross", label: "双均线趋势" },
                { value: "czsc", label: "缠论" },
                { value: "dual-breakout", label: "双突破" },
              ]}
              onChange={(strategy) =>
                onChange({
                  strategy:
                    strategy === "all"
                      ? undefined
                      : (strategy as MonitorFilters["strategy"]),
                })
              }
            />
            <label className="text-sm">
              证券代码
              <Input
                value={value.symbol ?? ""}
                maxLength={20}
                onChange={(event) => onChange({ symbol: event.target.value })}
              />
            </label>
          </>
        )}
        {tab === "monitors" ? (
          <MonitorSelect
            label="订阅状态筛选"
            value={
              value.enabled === undefined
                ? "all"
                : value.enabled
                  ? "enabled"
                  : "paused"
            }
            options={[
              { value: "all", label: "全部订阅" },
              { value: "enabled", label: "已启用" },
              { value: "paused", label: "已暂停" },
            ]}
            onChange={(value) =>
              onChange({
                enabled: value === "all" ? undefined : value === "enabled",
              })
            }
          />
        ) : (
          <>
            <label className="text-sm">
              创建起始日期
              <Input
                type="date"
                value={value.from ?? ""}
                onChange={(event) =>
                  onChange({ from: event.target.value || undefined })
                }
              />
            </label>
            <label className="text-sm">
              创建截止日期
              <Input
                type="date"
                value={value.to ?? ""}
                onChange={(event) =>
                  onChange({ to: event.target.value || undefined })
                }
              />
            </label>
          </>
        )}
        {tab === "signals" && (
          <label className="text-sm">
            订阅ID
            <Input
              value={value.monitorId ?? ""}
              maxLength={200}
              onChange={(event) =>
                onChange({ monitorId: event.target.value || undefined })
              }
            />
          </label>
        )}
        {tab === "deliveries" && (
          <>
            <MonitorSelect
              label="投递状态筛选"
              value={value.status ?? "all"}
              options={[
                { value: "all", label: "全部状态" },
                ...Object.entries(deliveryLabels).map(([value, label]) => ({
                  value,
                  label,
                })),
              ]}
              onChange={(status) =>
                onChange({
                  status:
                    status === "all"
                      ? undefined
                      : (status as MonitorFilters["status"]),
                })
              }
            />
            <MonitorSelect
              label="渠道筛选"
              value={value.channelId ?? "all"}
              options={[
                { value: "all", label: "全部渠道" },
                ...channels.map((channel) => ({
                  value: channel.id,
                  label: channel.name,
                })),
              ]}
              onChange={(channelId) =>
                onChange({
                  channelId: channelId === "all" ? undefined : channelId,
                })
              }
            />
            <MonitorSelect
              label="消息类型筛选"
              value={value.kind ?? "all"}
              options={[
                { value: "all", label: "全部类型" },
                { value: "signal", label: "规则信号" },
                { value: "analysis", label: "AI解读" },
                { value: "test", label: "测试消息" },
                { value: "summary", label: "汇总消息" },
              ]}
              onChange={(kind) =>
                onChange({
                  kind:
                    kind === "all"
                      ? undefined
                      : (kind as MonitorFilters["kind"]),
                })
              }
            />
            <label className="text-sm">
              关联信号ID
              <Input
                value={value.signalId ?? ""}
                maxLength={200}
                onChange={(event) =>
                  onChange({ signalId: event.target.value || undefined })
                }
              />
            </label>
          </>
        )}
      </div>
      <div className="flex gap-2">
        <Button type="submit">查询历史</Button>
        <Button variant="outline" type="button" onClick={onReset}>
          重置筛选
        </Button>
      </div>
    </form>
  );
}
