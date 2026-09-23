"use client";
import { useState } from "react";
import {
  Crosshair,
  FloppyDisk,
  ListChecks,
  Play,
  Queue,
  SlidersHorizontal,
} from "@phosphor-icons/react";
import { api } from "~/trpc/react";
import { cn } from "~/lib/common/classnames";
import {
  intradayConfigSchema,
  type IntradayConfig,
} from "~/lib/intraday-schedule";
import {
  GridTable,
  ListPanel,
  PageGrid,
  Panel,
  SecurityCell,
  Segmented,
  StatsPanel,
  toneText,
  type Tone,
} from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { usePanelVisible } from "../workbench/keep-alive";
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

export function IntradayControls() {
  const visible = usePanelVisible();
  const utils = api.useUtils();
  const [exportError, setExportError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const remove = api.intradayRemove.useMutation({
    onSuccess: () => {
      setRemoving(null);
      void utils.intradayStatus.invalidate();
    },
  });
  async function exportObservation(id: string) {
    try {
      const value = await utils.intradayExport.fetch(id);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${value.observation.snapshot.symbol}-${value.observation.barCutoff.slice(0, 10)}-preview.json`;
      link.click();
      URL.revokeObjectURL(url);
      setExportError(null);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "导出失败");
    }
  }
  const [offset, setOffset] = useState(0);
  const [draft, setDraft] = useState<IntradayConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const status = api.intradayStatus.useQuery(
    { offset },
    { enabled: visible, refetchInterval: 5000 },
  );
  const save = api.intradaySave.useMutation({
    onSuccess: () => {
      setSaved(true);
      setDraft(null);
      void status.refetch();
    },
  });
  const run = api.intradayRun.useMutation({
    onSuccess: () => {
      void status.refetch();
    },
  });
  const config = draft ?? status.data?.config ?? intradayConfigSchema.parse({});
  const change = (patch: Partial<IntradayConfig>) => {
    setSaved(false);
    setDraft({ ...config, ...patch });
  };
  const catalog = api.marketPoolCatalog.useQuery(
    config.pool?.category ?? "index",
    { enabled: config.pool !== null },
  );
  const [slot, setSlot] = useState<"noon" | "late">("noon");
  const today = status.data?.lastCheck?.schedule.date;
  const scheduled = status.data?.lastCheck?.schedule.slots.find(
    (item) => item.slot === slot,
  );
  const batch = status.data?.runs.find(
    (item) => item.date === today && item.slot === slot,
  );
  const found = batch?.results.filter((result) => result.observationId).length;
  const pending =
    status.data?.rows.filter(
      (row) =>
        row.attempts.length === 0 &&
        (!today || row.value.barCutoff.startsWith(today)),
    ).length ?? 0;
  const error =
    exportError ??
    remove.error?.message ??
    status.error?.message ??
    save.error?.message ??
    run.error?.message ??
    status.data?.worker.error;
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
            ? `最近检查 ${new Date(status.data.lastCheck.checkedAt).toLocaleString("zh-CN", { hour12: false })} · ${status.data.lastCheck.calendarSource}`
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
              { value: "noon", label: `${config.noon} 午盘` },
              { value: "late", label: `${config.late} 尾盘` },
            ]}
          />
        }
        items={[
          {
            label: "状态",
            value: batch
              ? labels[batch.status]
              : scheduled
                ? labels[scheduled.status]
                : "—",
            note: batch
              ? `开始于 ${new Date(batch.startedAt).toLocaleTimeString("zh-CN", { hour12: false })}`
              : "实际执行结果见批次",
            tone: statusTone(batch?.status ?? scheduled?.status),
          },
          {
            label: "候选",
            value: found ?? "—",
            note: batch
              ? `${batch.results.length}/${batch.pool?.rows.length ?? 0} 已评估`
              : "尚未运行",
          },
          {
            label: "RPS 条件",
            value: `RPS${config.rpsPeriod} ≥ ${config.minimumRps}`,
            note: config.pool ? config.pool.name || "未选名单" : "全沪深",
          },
          {
            label: "待收盘核对",
            value: pending,
            note: "15:05 后核对",
            tone: pending ? "accent" : "neutral",
          },
        ]}
      />
      <Panel
        span={4}
        icon={SlidersHorizontal}
        title="参数"
        note="预选使用上一交易日 RPS 和当日完整5分钟线。应用需保持运行；错过时段会留记录。盘中结果在收盘后另行核对。"
      >
        <div className="flex flex-col gap-[10px]">
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
                onValueChange={(value) => change({ rpsPeriod: Number(value) })}
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
                onChange={(e) => change({ minimumRps: Number(e.target.value) })}
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
                !intradayConfigSchema.safeParse(config).success
              }
              onClick={() => save.mutate(config)}
            >
              <FloppyDisk size={14} />
              保存设置
            </Button>
            <Button
              variant="outline"
              disabled={
                !config.enabled || run.isPending || status.data?.worker.running
              }
              onClick={() => run.mutate()}
            >
              <Play size={14} />
              检查并执行当前时段
            </Button>
          </div>
          {saved && (
            <p role="status" className="m-0 text-[11.5px] text-nc-ok">
              设置已保存
            </p>
          )}
        </div>
      </Panel>
      <Panel
        span={8}
        icon={ListChecks}
        title="候选与收盘确认"
        meta={`第 ${offset / 20 + 1} 页 · 每页 20 条`}
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一页
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={(status.data?.rows.length ?? 0) < 20}
              onClick={() => setOffset(offset + 20)}
            >
              下一页
            </Button>
          </>
        }
        note={
          status.data
            ? `收盘后标记成立 / 撤销 / 数据不足，并保存当时与收盘的行情证据。研究快照 ${(status.data.storage.bytes / 1024 / 1024).toFixed(1)} / ${status.data.storage.limitBytes / 1024 / 1024} MiB，保留至手动清理。`
            : "收盘后标记成立 / 撤销 / 数据不足，并保存当时与收盘的行情证据。"
        }
      >
        <GridTable
          label="预选记录"
          minWidth={680}
          rows={status.data?.rows ?? []}
          rowKey={(row) => row.id}
          empty="暂无预选记录。缺少当日行情不会生成候选。"
          columns={[
            {
              key: "security",
              header: "证券",
              width: "1fr",
              cell: (row) => (
                <SecurityCell
                  name={row.value.snapshot.symbol.toUpperCase()}
                  code={`RPS ${row.value.rps.toFixed(2)}`}
                />
              ),
            },
            {
              key: "cutoff",
              header: "截至时点",
              width: "0.9fr",
              cell: (row) => (
                <span className="text-nc-text-3">
                  {row.value.barCutoff.slice(5, 16).replace("T", " ")}
                </span>
              ),
            },
            {
              key: "signals",
              header: "入选信号",
              width: "1fr",
              cell: (row) => (
                <span className="text-nc-text-2">
                  {row.value.signals.length
                    ? row.value.signals
                        .map((signal) =>
                          signal.strategy === "czsc" ? "缠论买点" : "双突破",
                        )
                        .join("、")
                    : "未出现买入信号"}
                </span>
              ),
            },
            {
              key: "close",
              header: "收盘确认",
              width: "1.2fr",
              cell: (row) =>
                row.attempts.length === 0 ? (
                  <span className="nc-text-accent">等待收盘核对</span>
                ) : (
                  row.attempts.map((attempt, index) => (
                    <span
                      key={index}
                      className={cn(
                        "block",
                        toneText[
                          statusTone(
                            attempt.close.reason
                              ? "unavailable"
                              : attempt.signals[0]?.status,
                          )
                        ],
                      )}
                    >
                      {attempt.close.reason ??
                        (attempt.signals.length
                          ? attempt.signals
                              .map((signal) => labels[signal.status])
                              .join("、")
                          : "收盘核对完成，无预选信号")}
                    </span>
                  ))
                ),
            },
            {
              key: "actions",
              header: "",
              width: "1.6fr",
              align: "right",
              cell: (row) =>
                removing === row.id ? (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className="text-[11px] text-nc-warn">
                      将删除原始行情及收盘核对，建议先导出。
                    </span>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(row.id)}
                    >
                      确认清理
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRemoving(null)}
                    >
                      取消
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void exportObservation(row.id)}
                    >
                      导出行情与核对依据
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={status.data?.worker.running}
                      onClick={() => setRemoving(row.id)}
                    >
                      清理记录
                    </Button>
                  </div>
                ),
            },
          ]}
        />
      </Panel>
      <ListPanel
        icon={Queue}
        title="最近批次"
        empty="还没有执行记录。"
        items={(status.data?.runs ?? []).map((item) => ({
          key: item.id,
          title: `${item.date} · ${item.slot === "noon" ? "午盘" : "尾盘"}`,
          subtitle: `${item.results.length}/${item.pool?.rows.length ?? 0} 已评估${item.error ? ` · ${item.error}` : ""}`,
          tag: labels[item.status],
          tone: statusTone(item.status),
          children: item.results.some((result) => result.reason) ? (
            <details className="mt-2 mb-0">
              <summary>未入选原因</summary>
              {item.results
                .filter((result) => result.reason)
                .map((result) => (
                  <p key={result.symbol} className="my-1">
                    {result.symbol}：{result.reason}
                  </p>
                ))}
            </details>
          ) : undefined,
        }))}
      />
    </PageGrid>
  );
}
