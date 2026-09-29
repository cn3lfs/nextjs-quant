"use client";
import { useState } from "react";
import {
  Crosshair,
  FloppyDisk,
  Play,
  SlidersHorizontal,
} from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import { IntradayHistoryPanel } from "./intraday-history-panel";
import {
  intradayConfigSchema,
  type IntradayConfig,
} from "~/lib/strategy-facts/intraday-schedule";
import { PageGrid, Panel, Segmented, StatsPanel, type Tone } from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { useTaskVisible } from "../workbench/use-task-visible";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";

const labels: Record<string, string> = {
  running: "执行中",
  complete: "完成",
  partial: "部分完成",
  failed: "失败",
  missed: "已错过",
  confirmed: "收盘成立",
  withdrawn: "收盘撤销",
  unavailable: "数据不足",
  pending: "尚未到时段",
  due: "处于执行窗口",
  closed: "休市",
  unknown: "交易日历无法确认",
  disabled: "未启用",
};
const statusTone = (value?: string): Tone =>
  value === "complete" || value === "confirmed"
    ? "ok"
    : value === "failed"
      ? "bad"
      : value === "missed" ||
          value === "partial" ||
          value === "unknown" ||
          value === "withdrawn" ||
          value === "unavailable"
        ? "warn"
        : value === "running" || value === "due" || value === "pending"
          ? "accent"
          : "neutral";
const field = "flex flex-col gap-[5px] text-[11px] text-nc-text-3";
const fieldNames: Record<string, string> = {
  noon: "午盘时刻",
  late: "尾盘时刻",
  rpsPeriod: "RPS周期",
  minimumRps: "最低RPS",
  pool: "证券池",
  source: "行情来源",
  czscConfig: "缠论配置",
};

export function IntradayControls() {
  const visible = useTaskVisible();
  const utils = api.useUtils();
  const [draft, setDraft] = useState<IntradayConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const status = api.intradaySummary.useQuery(undefined, {
    enabled: visible,
    refetchInterval: (query) =>
      query.state.data?.worker.running ? 5000 : 30000,
  });
  const save = api.intradaySave.useMutation({
    onMutate: async () => {
      await utils.intradaySummary.cancel();
    },
    onSuccess: (stored, submitted) => {
      utils.intradaySummary.setData(undefined, (previous) =>
        previous ? { ...previous, config: stored } : previous,
      );
      setSaved(true);
      setDraft((current) =>
        current && JSON.stringify(current) !== JSON.stringify(submitted)
          ? current
          : null,
      );
      void status.refetch();
    },
  });
  const run = api.intradayRun.useMutation({
    onSuccess: () => {
      void status.refetch();
    },
  });
  const savedConfig = status.data?.config ?? intradayConfigSchema.parse({});
  const config = draft ?? savedConfig;
  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
  const validation = intradayConfigSchema.safeParse(config);
  const change = (patch: Partial<IntradayConfig>) => {
    setSaved(false);
    setDraft({ ...config, ...patch });
  };
  const catalog = api.marketPoolCatalog.useQuery(
    config.pool?.category ?? "index",
    { enabled: visible && config.pool !== null },
  );
  const [slot, setSlot] = useState<"noon" | "late">("noon");
  const today = status.data?.lastCheck?.schedule.date;
  const scheduled = status.data?.lastCheck?.schedule.slots.find(
    (item) => item.slot === slot,
  );
  const error = status.error
    ? `状态读取失败：${status.error.message}`
    : save.error
      ? `保存设置失败：${save.error.message}`
      : run.error
        ? `检查时段失败：${run.error.message}`
        : status.data?.worker.error
          ? `后台预选失败：${status.data.worker.error}`
          : null;
  return (
    <PageGrid>
      {error && (
        <p role="alert" className="nc-span-12 m-0 text-[12px] text-nc-bad">
          {error}
          {status.error && (
            <Button
              size="sm"
              variant="outline"
              className="ml-3"
              onClick={() => void status.refetch()}
            >
              重新加载
            </Button>
          )}
        </p>
      )}
      <StatsPanel
        icon={Crosshair}
        title="批次"
        meta={
          status.data?.lastCheck
            ? `最近检查 ${new Date(status.data.lastCheck.checkedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })} · ${status.data.lastCheck.calendarSource}`
            : status.isLoading
              ? "正在读取预选记录…"
              : "尚未检查"
        }
        actions={
          <Segmented
            label="批次"
            value={slot}
            onChange={setSlot}
            options={[
              { value: "noon", label: `${savedConfig.noon} 午盘` },
              { value: "late", label: `${savedConfig.late} 尾盘` },
            ]}
          />
        }
        items={[
          {
            label: "状态",
            value: !status.data
              ? "尚未读取"
              : !savedConfig.enabled
                ? "未启用"
                : scheduled
                  ? labels[scheduled.status]
                  : "尚未检查",
            note: "上次检查的窗口状态；实际进度见批次记录",
            tone: statusTone(scheduled?.status),
          },
          {
            label: "后台执行",
            value: !status.data
              ? "尚未读取"
              : status.data.worker.running
                ? "执行中"
                : "空闲",
            note: "隐藏页面不影响后台调度",
          },
          {
            label: "RPS 条件",
            value: `RPS${savedConfig.rpsPeriod} ≥ ${savedConfig.minimumRps}`,
            note: savedConfig.pool
              ? savedConfig.pool.name || "未选名单"
              : "全沪深",
          },
          {
            label: "收盘核对",
            value: "15:05 后",
            note: "未核对与待重试数量见结果列表",
          },
        ]}
      />
      <Panel
        span={12}
        icon={SlidersHorizontal}
        title="参数"
        note="预选使用上一交易日 RPS 和当日完整5分钟线。应用需保持运行；错过时段会留记录。盘中结果在收盘后另行核对。"
      >
        <details>
          <summary className="cursor-pointer text-sm">
            编辑参数{dirty ? " · 有未保存修改" : ""}
          </summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="flex items-center gap-2 text-[12px] text-nc-text-2">
              <Checkbox
                checked={config.enabled}
                onCheckedChange={(checked) =>
                  change({ enabled: checked === true })
                }
              />
              启用自动预选
            </label>
            <label className={field}>
              行情来源
              <Select
                value={config.source}
                onValueChange={(value) =>
                  change({ source: value as IntradayConfig["source"] })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tdx-local">本地通达信</SelectItem>
                  <SelectItem value="tdx-7709">通达信在线行情</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <div className="grid grid-cols-2 gap-[10px]">
              <label className={field}>
                午盘时刻
                <Input
                  type="time"
                  step={300}
                  value={config.noon}
                  onChange={(e) => change({ noon: e.target.value })}
                />
              </label>
              <label className={field}>
                尾盘时刻
                <Input
                  type="time"
                  step={300}
                  value={config.late}
                  onChange={(e) => change({ late: e.target.value })}
                />
              </label>
              <label className={field}>
                RPS周期
                <Select
                  value={String(config.rpsPeriod)}
                  onValueChange={(value) =>
                    change({ rpsPeriod: Number(value) })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[5, 10, 20, 50, 120, 250].map((period) => (
                      <SelectItem key={period} value={String(period)}>
                        {period}日
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className={field}>
                最低RPS
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={config.minimumRps}
                  onChange={(e) =>
                    change({ minimumRps: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <label className={field}>
              证券池类别
              <Select
                value={config.pool?.category ?? "all"}
                onValueChange={(value) => {
                  const category = value;
                  change({
                    pool:
                      category === "all"
                        ? null
                        : {
                            category: category as
                              "index" | "industry" | "concept",
                            name: category === "index" ? "中证A500" : "",
                          },
                  });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全沪深</SelectItem>
                  <SelectItem value="index">指数成分</SelectItem>
                  <SelectItem value="industry">行业（申万/通达信）</SelectItem>
                  <SelectItem value="concept">概念</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {config.pool && (
              <label className={field}>
                成分名单
                <Select
                  value={config.pool.name}
                  onValueChange={(value) =>
                    change({ pool: { ...config.pool!, name: value } })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {catalog.data?.names.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}
            {catalog.error && config.pool && (
              <p role="alert" className="m-0 text-[11.5px] text-nc-bad">
                {catalog.error.message}
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-2"
                  onClick={() => void catalog.refetch()}
                >
                  重读名单
                </Button>
              </p>
            )}
            <label className={field}>
              缠论配置
              <Select
                value={String(config.czscConfig)}
                onValueChange={(value) =>
                  change({ czscConfig: Number(value) as 0 | 1100 })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">配置0</SelectItem>
                  <SelectItem value="1100">配置1100</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <div className="nc-buttons mt-1">
              <Button
                disabled={
                  !status.data ||
                  save.isPending ||
                  !dirty ||
                  !validation.success
                }
                onClick={() => save.mutate(config)}
              >
                <FloppyDisk size={14} />
                保存设置
              </Button>
              <Button
                variant="outline"
                disabled={
                  !status.data ||
                  dirty ||
                  !savedConfig.enabled ||
                  run.isPending ||
                  status.data?.worker.running
                }
                onClick={() => run.mutate()}
              >
                <Play size={14} />
                检查并执行当前时段
              </Button>
            </div>
            {dirty && (
              <div className="text-[12px] text-nc-warn" role="status">
                有未保存修改，请先保存或放弃后再检查时段。
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setDraft(null);
                    setSaved(false);
                  }}
                >
                  放弃修改
                </Button>
              </div>
            )}
            {!validation.success &&
              validation.error.issues.map((issue) => (
                <p
                  key={issue.path.join(".")}
                  role="alert"
                  className="m-0 text-[12px] text-nc-bad"
                >
                  {fieldNames[String(issue.path[0])] ?? "设置"}：{issue.message}
                </p>
              ))}
            {run.data && (
              <p role="status" className="text-sm">
                {
                  {
                    started: "已启动检查，实际结果见批次记录",
                    running: "已有任务执行中",
                    disabled: "尚未启用自动预选",
                    pending: "尚未到执行窗口",
                    closed: "今日休市",
                    unknown: "交易日历无法确认",
                    missed: "已错过窗口，仅登记错过，不补跑预选",
                    confirming: "已发起收盘核对检查",
                  }[run.data.outcome]
                }
              </p>
            )}
            {saved && (
              <p role="status" className="m-0 text-[11.5px] text-nc-ok">
                设置已保存
              </p>
            )}
          </div>
        </details>
      </Panel>
      <IntradayHistoryPanel running={status.data?.worker.running ?? false} />
    </PageGrid>
  );
}
