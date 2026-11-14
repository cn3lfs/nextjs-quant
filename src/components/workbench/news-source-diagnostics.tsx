import { useState } from "react";
import { api } from "~/trpc/react";
import {
  newsSourceConfiguration,
  type NewsSourceCheck,
  type NewsSourceSettings,
} from "~/lib/settings/news-source-settings";
import { sameSetting } from "~/lib/settings/settings-draft";
import { Button } from "../ui/button";
import { Pill } from "../panels";

export function NewsSourceDiagnostics({
  value,
  dirty,
}: {
  value: NewsSourceSettings;
  dirty: boolean;
}) {
  const [result, setResult] = useState<NewsSourceCheck | null>(null);
  const check = api.checkNewsSources.useMutation({
    onMutate: () => setResult(null),
    onSuccess: setResult,
  });
  const configuration = newsSourceConfiguration(value);
  const stale =
    result !== null && !sameSetting(result.configuration, configuration);
  return (
    <div className="mt-4 space-y-3">
      <Button
        variant="outline"
        disabled={dirty || check.isPending}
        onClick={() => check.mutate(configuration)}
      >
        {check.isPending ? "正在检查新闻配置…" : "检查已保存新闻配置"}
      </Button>
      <p className="text-[13px] text-nc-text-3">
        只读检查数据库格式和 Python 版本，不运行新闻分析。
        {dirty ? "请先保存修改。" : ""}
      </p>
      {check.error && (
        <p role="alert" className="text-nc-bad">
          {check.error.message}
        </p>
      )}
      {result && (
        <div aria-live="polite" className="space-y-2">
          {stale && (
            <p className="text-nc-warn">
              新闻配置已变化，以下结果已过期，请重新检查。
            </p>
          )}
          {(
            [
              ["数据库", result.database],
              ["Python", result.python],
            ] as const
          ).map(([label, row]) => (
            <div
              key={label}
              className="flex flex-wrap items-start gap-2 text-[13px]"
            >
              <Pill tone={stale ? "idle" : row.ok ? "ok" : "warn"}>
                {label}：{row.ok ? "可用" : "待处理"}
              </Pill>
              <span className="min-w-0 break-words text-nc-text-2">
                {row.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
