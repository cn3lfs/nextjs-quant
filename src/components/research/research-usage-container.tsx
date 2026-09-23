"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import type { ResearchRange } from "~/lib/research-usage";
import { ResearchUsagePanel } from "./research-usage-panel";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { ResearchAttemptsContainer } from "./research-attempts-container";
import { Notebook } from "@phosphor-icons/react";
import { Panel, StatCards } from "../panels";

export function ResearchUsageContainer({ range }: { range?: ResearchRange }) {
  const query = api.researchUsage.useQuery(
    range ?? { start: "0001-01-01", end: "9999-12-31" },
    { refetchOnMount: "always" },
  );
  const config = api.holdoutSettings.useQuery();
  const utils = api.useUtils();
  const [draft, setDraft] = useState<string | null>(null);
  const save = api.saveHoldoutStart.useMutation({
    onSuccess: async () => {
      setDraft(null);
      await Promise.all([
        utils.holdoutSettings.invalidate(),
        utils.researchUsage.invalidate(),
      ]);
    },
  });
  return (
    <Panel
      icon={Notebook}
      title="研究使用台账"
      bodyClassName="space-y-3 text-[12px] text-nc-text-2"
    >
      {query.data && (
        <StatCards
          items={[
            {
              label: "试验次数（下界）",
              value: query.data.trialLowerBound,
              note: "不是统计阈值",
            },
            { label: "运行", value: query.data.runs },
            { label: "不同配置", value: query.data.distinctConfigs },
            { label: "候选累计", value: query.data.candidateSum },
            {
              label: "留出集覆盖",
              value:
                query.data.holdout.start === null
                  ? "未启用"
                  : `${query.data.holdout.touches} 次`,
              note: query.data.holdout.start ?? undefined,
              tone:
                query.data.holdout.start !== null &&
                query.data.holdout.touches > 0
                  ? "warn"
                  : "neutral",
            },
          ]}
        />
      )}
      <p className="m-0">
        {range
          ? `${range.start} 至 ${range.end}，含边界重叠运行`
          : "全部日期范围"}
        ；自 V5 启用起记录，历史结果不补造。累计值为当前台账。
      </p>
      {query.isLoading && <p role="status">正在读取台账…</p>}
      {query.error ? (
        <p role="alert">
          台账读取失败：{query.error.message}{" "}
          <Button onClick={() => void query.refetch()}>重试</Button>
        </p>
      ) : (
        query.data && <ResearchUsagePanel summary={query.data} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          留出集起点
          <Input
            aria-label="留出集起点"
            type="date"
            value={draft ?? config.data?.holdoutStart ?? ""}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!config.data || save.isPending}
          />
        </label>
        <Button
          disabled={!config.data || save.isPending}
          onClick={() =>
            save.mutate((draft ?? config.data?.holdoutStart) || null)
          }
        >
          保存（留空停用）
        </Button>
        <Button variant="outline" onClick={() => void query.refetch()}>
          刷新台账
        </Button>
      </div>
      <p className="m-0 text-[11px] text-nc-text-4">
        手动设置，不自动平移；只记录不拦截。变更起点会重新核对既有运行范围，不会清除历史记录。
      </p>
      {config.error && (
        <p role="alert">
          设置读取失败{" "}
          <Button onClick={() => void config.refetch()}>重试</Button>
        </p>
      )}
      {save.error && <p role="alert">保存失败：{save.error.message}</p>}
      {save.isSuccess && <p role="status">留出集设置已保存</p>}
      <ResearchAttemptsContainer />
    </Panel>
  );
}
