"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import {
  intradayConfigSchema,
  type IntradayConfig,
} from "~/lib/intraday-schedule";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Checkbox } from "./ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select";

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
export function IntradayControls() {
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
    { refetchInterval: 5000 },
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
  return (
    <div className="space-y-6">
      {exportError && (
        <p role="alert" className="text-destructive">
          {exportError}
        </p>
      )}
      {remove.error && (
        <p role="alert" className="text-destructive">
          {remove.error.message}
        </p>
      )}
      <p className="text-muted-foreground text-sm">
        预选使用上一交易日 RPS
        和当日完整5分钟线。应用需保持运行；错过时段会留记录。盘中结果在收盘后另行核对。
      </p>
      <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
        <label className="flex items-center gap-2">
          <Checkbox
            checked={config.enabled}
            onCheckedChange={(checked) => change({ enabled: checked === true })}
          />
          启用自动预选
        </label>
        <label>
          行情来源
          <Select
            value={config.source}
            onValueChange={(value) =>
              change({ source: value as IntradayConfig["source"] })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tdx-local">本地通达信</SelectItem>
              <SelectItem value="tdx-7709">通达信在线行情</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label>
          午盘时刻
          <Input
            type="time"
            step={300}
            value={config.noon}
            onChange={(e) => change({ noon: e.target.value })}
          />
        </label>
        <label>
          尾盘时刻
          <Input
            type="time"
            step={300}
            value={config.late}
            onChange={(e) => change({ late: e.target.value })}
          />
        </label>
        <label>
          RPS周期
          <Select
            value={String(config.rpsPeriod)}
            onValueChange={(value) => change({ rpsPeriod: Number(value) })}
          >
            <SelectTrigger>
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
        <label>
          最低RPS
          <Input
            type="number"
            min={0}
            max={100}
            value={config.minimumRps}
            onChange={(e) => change({ minimumRps: Number(e.target.value) })}
          />
        </label>
        <label>
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
                        category: category as "index" | "industry" | "concept",
                        name: category === "index" ? "中证A500" : "",
                      },
              });
            }}
          >
            <SelectTrigger>
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
          <label>
            成分名单
            <Select
              value={config.pool.name}
              onValueChange={(value) =>
                change({ pool: { ...config.pool!, name: value } })
              }
            >
              <SelectTrigger>
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
          <p role="alert">
            {catalog.error.message}
            <Button variant="outline" onClick={() => void catalog.refetch()}>
              重读名单
            </Button>
          </p>
        )}
        <label>
          缠论配置
          <Select
            value={String(config.czscConfig)}
            onValueChange={(value) =>
              change({ czscConfig: Number(value) as 0 | 1100 })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">配置0</SelectItem>
              <SelectItem value="1100">配置1100</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <div className="flex gap-2">
          <Button
            disabled={
              !status.data ||
              save.isPending ||
              !intradayConfigSchema.safeParse(config).success
            }
            onClick={() => save.mutate(config)}
          >
            保存设置
          </Button>
          <Button
            variant="outline"
            disabled={
              !config.enabled || run.isPending || status.data?.worker.running
            }
            onClick={() => run.mutate()}
          >
            检查并执行当前时段
          </Button>
        </div>
      </div>
      {(status.error ||
        save.error ||
        run.error ||
        status.data?.worker.error) && (
        <p role="alert" className="text-destructive">
          {status.error?.message ??
            save.error?.message ??
            run.error?.message ??
            status.data?.worker.error}
        </p>
      )}
      {status.isLoading && <p>正在读取预选记录…</p>}
      {saved && <p role="status">设置已保存</p>}
      {status.data?.lastCheck && (
        <div className="rounded border p-3 text-sm">
          <p>
            最近检查：
            {new Date(status.data.lastCheck.checkedAt).toLocaleString(
              "zh-CN",
            )}{" "}
            · {status.data.lastCheck.calendarSource}
          </p>
          {status.data.lastCheck.schedule.slots.map((slot) => (
            <p key={slot.slot}>
              {slot.slot === "noon" ? "午盘" : "尾盘"} {slot.barCutoff}：
              {labels[slot.status]}（实际执行结果见批次）
            </p>
          ))}
        </div>
      )}
      {status.data && (
        <p className="text-muted-foreground text-sm">
          研究快照 {(status.data.storage.bytes / 1024 / 1024).toFixed(1)} /{" "}
          {status.data.storage.limitBytes / 1024 / 1024} MiB，保留至手动清理。
        </p>
      )}
      {status.error && (
        <Button onClick={() => void status.refetch()}>重新加载</Button>
      )}
      <section className="space-y-2">
        <h2 className="text-lg font-medium">最近批次</h2>
        {status.data?.runs.length === 0 && <p>还没有执行记录。</p>}
        {status.data?.runs.map((batch) => (
          <details key={batch.id} className="rounded border p-3">
            <summary>
              {batch.date} · {batch.slot === "noon" ? "午盘" : "尾盘"} ·{" "}
              {labels[batch.status]} · {batch.results.length}/
              {batch.pool?.rows.length ?? 0}
            </summary>
            <p>{batch.error}</p>
            {batch.results
              .filter((result) => result.reason)
              .map((result) => (
                <p key={result.symbol}>
                  {result.symbol}：{result.reason}
                </p>
              ))}
          </details>
        ))}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-medium">预选记录</h2>
        {status.data?.rows.length === 0 && (
          <p>暂无预选记录。缺少当日行情不会生成候选。</p>
        )}
        {status.data?.rows.map((row) => (
          <article key={row.id} className="rounded border p-3">
            {removing === row.id ? (
              <div className="flex items-center gap-2">
                <span>将删除原始行情及收盘核对，建议先导出。</span>
                <Button
                  variant="danger"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(row.id)}
                >
                  确认清理
                </Button>
                <Button variant="outline" onClick={() => setRemoving(null)}>
                  取消
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                disabled={status.data?.worker.running}
                onClick={() => setRemoving(row.id)}
              >
                清理记录
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => void exportObservation(row.id)}
            >
              导出行情与核对依据
            </Button>
            <p>
              {row.value.snapshot.symbol} · {row.value.barCutoff} · RPS{" "}
              {row.value.rps.toFixed(2)}
            </p>
            <p className="text-sm">
              {row.value.signals.length
                ? row.value.signals
                    .map((signal) =>
                      signal.strategy === "czsc" ? "缠论买点" : "双突破",
                    )
                    .join("、")
                : "未出现买入信号"}
            </p>
            {row.attempts.length === 0 ? (
              <p>等待收盘核对</p>
            ) : (
              row.attempts.map((attempt, index) => (
                <p key={index}>
                  {attempt.close.reason ??
                    (attempt.signals.length
                      ? attempt.signals
                          .map((signal) => labels[signal.status])
                          .join("、")
                      : "收盘核对完成，无预选信号")}
                </p>
              ))
            )}
          </article>
        ))}
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            disabled={(status.data?.rows.length ?? 0) < 20}
            onClick={() => setOffset(offset + 20)}
          >
            下一页
          </Button>
        </div>
      </section>
    </div>
  );
}
