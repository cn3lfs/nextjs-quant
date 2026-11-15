"use client";
import { formatNumber } from "trading-strategy-core/format-number";

import { useState } from "react";
import Link from "next/link";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { Panel } from "../panels";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
/** Small index-only query: mounting this panel never downloads price history. */
export function BinanceHistory() {
  const [exportError, setExportError] = useState("");
  const verify = api.verifyBinancePublicData.useMutation();
  const exportData = api.exportBinancePublicData.useMutation({
    onSuccess: (data) => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "BTC-ETH-归档覆盖.json";
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: (e) => setExportError(e.message),
  });
  const [minute, setMinute] = useState(false);
  const utils = api.useUtils();
  const [root, setRoot] = useState<string | null>(null);
  const status = api.binancePublicDataStatus.useQuery(undefined, {
    refetchInterval: 30000,
  });
  const start = api.startBinancePublicDataBackfill.useMutation({
    onSuccess: () => {
      void utils.jobs.invalidate();
      void utils.binancePublicDataStatus.invalidate();
    },
  });
  const configure = api.configureBinancePublicDataRoot.useMutation({
    onSuccess: () => {
      setRoot(null);
      void utils.binancePublicDataStatus.invalidate();
    },
  });
  return (
    <Panel
      span={12}
      title="BTC、ETH 历史行情"
      tag="币安官方公开数据"
      note="保存官方 ZIP 和 SHA256 校验文件。默认补齐日线、4小时、1小时、15分钟、5分钟，可断点续传。点击后回填历史；已有历史的实时行情仅更新最近已完成 bar。"
    >
      {status.data?.needsBackfill && (
        <p role="status">历史尚未补齐，请按需回填后再开展长区间研究。</p>
      )}
      <p className="break-all text-sm text-muted-foreground">
        保存目录：{status.data?.root ?? "正在读取…"}
      </p>
      <div className="my-3 flex gap-3">
        <Input
          aria-label="币安历史行情保存目录"
          placeholder="留空使用默认目录；可填写其他盘的绝对路径"
          value={root ?? status.data?.root ?? ""}
          onChange={(e) => setRoot(e.target.value)}
        />
        <Button
          variant="outline"
          disabled={root === null || configure.isPending}
          onClick={() => configure.mutate(root ?? "")}
        >
          保存目录
        </Button>
      </div>
      <div className="my-3 flex items-center gap-3">
        <Checkbox
          id="binance-one-minute"
          checked={minute}
          onCheckedChange={(v) => setMinute(v === true)}
        />
        <label htmlFor="binance-one-minute">
          同时下载 1 分钟（占用更多空间）
        </label>
        <Button
          disabled={!status.data || start.isPending}
          onClick={() => start.mutate({ includeOneMinute: minute })}
        >
          回填/补齐 BTC、ETH 历史
        </Button>
        <Link href="/system/tasks">查看任务进度与取消</Link>
        <Button
          variant="outline"
          disabled={verify.isPending}
          onClick={() => verify.mutate()}
        >
          校验本地归档
        </Button>
        <Button
          variant="outline"
          disabled={exportData.isPending}
          onClick={() => exportData.mutate()}
        >
          导出覆盖与校验索引
        </Button>
      </div>
      {(status.error || start.error || configure.error) && (
        <p role="alert">
          {status.error?.message ??
            start.error?.message ??
            configure.error?.message}
        </p>
      )}
      {start.data && (
        <p role="status">已创建任务 {start.data.id}，完成后刷新覆盖记录。</p>
      )}
      {verify.data && (
        <p role="status">
          校验任务已创建：
          <Link
            className="underline"
            href={`/system/tasks?id=${encodeURIComponent(verify.data.id)}`}
          >
            查看校验结果
          </Link>
          ；缺失周期保持未回填。
        </p>
      )}
      {(verify.error || exportError) && (
        <p role="alert">{verify.error?.message ?? exportError}</p>
      )}
      <ul className="grid gap-2 text-sm lg:grid-cols-2">
        {status.data?.series.map((s) => (
          <li key={`${s.symbol}/${s.interval}`}>
            <strong>
              {s.symbol} {s.interval}
            </strong>
            ：
            {s.manifest
              ? `${s.manifest.start ?? "—"} 至 ${s.manifest.end ?? "—"} · ${s.manifest.rows.toLocaleString()} 根 · ${s.manifest.gaps.length} 处缺口 · ${formatNumber(s.manifest.bytes / 1024 ** 2, 1)} MiB`
              : "未回填"}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
