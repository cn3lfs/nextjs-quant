"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { formatNumber } from "trading-strategy-core/format-number";

export function DatabaseBackup() {
  const status = api.databaseStatus.useQuery();
  const [keep, setKeep] = useState<number | null>(null);
  const save = api.saveBackupSettings.useMutation({
    onSuccess: () => {
      setKeep(null);
      void status.refetch();
    },
  });
  const backup = api.backupDatabase.useMutation({
    onSuccess: () => void status.refetch(),
  });
  return (
    <section aria-label="数据库与备份" className="space-y-3 rounded border p-4">
      <h2 className="text-lg font-semibold">数据库与备份</h2>
      {status.isLoading && <p role="status">正在读取数据库信息…</p>}
      {status.data && (
        <>
          <p>
            当前库版本 {status.data.version} · 最近备份{" "}
            {status.data.latest === null
              ? "尚无备份"
              : new Date(status.data.latest).toLocaleString("zh-CN")}
          </p>
          <p className="break-all text-sm">数据库：{status.data.database}</p>
          <p className="break-all text-sm">备份位置：{status.data.root}</p>
          <div className="flex flex-wrap items-end gap-3">
            <label>
              保留最近份数
              <Input
                aria-label="备份保留份数"
                type="number"
                min={1}
                max={30}
                value={keep ?? status.data.keep}
                onChange={(e) => setKeep(Number(e.target.value))}
                className="w-24"
              />
            </label>
            <Button
              variant="outline"
              disabled={keep === null || save.isPending}
              onClick={() => save.mutate({ keep: keep ?? status.data.keep })}
            >
              保存保留份数
            </Button>
            <Button disabled={backup.isPending} onClick={() => backup.mutate()}>
              立即备份
            </Button>
          </div>
          <p className="text-sm text-nc-text-3">
            在线一致性备份包含已提交 WAL
            数据；成功后只轮换本功能创建的备份。部署和恢复前关闭旧应用并保留版本匹配的资源。
          </p>
          <ul className="space-y-1 text-sm">
            {status.data.backups.map((b) => (
              <li key={b.path} className="break-all">
                {new Date(b.at).toLocaleString("zh-CN")} ·{" "}
                {formatNumber(b.bytes / 1024 ** 2, 1)} MiB
              </li>
            ))}
          </ul>
        </>
      )}
      {(status.error || save.error || backup.error) && (
        <p role="alert">
          {status.error?.message ??
            save.error?.message ??
            backup.error?.message}
        </p>
      )}
      {backup.isSuccess && <p role="status">数据库备份已完成。</p>}
    </section>
  );
}
