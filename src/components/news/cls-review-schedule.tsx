"use client";
import { Checkbox } from "../ui/checkbox";
import { useState } from "react";
import { api } from "~/trpc/react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { ClsError, clsTime } from "./cls-review-fields";
export function ClsReviewSchedule({ visible }: { visible: boolean }) {
  const utils = api.useUtils();
  const schedule = api.clsReviewSchedule.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 10000 : false,
  });
  const [draft, setDraft] = useState<{
    enabled: boolean;
    directory: string;
  } | null>(null);
  const [feedback, setFeedback] = useState("");
  const value = draft ??
    schedule.data?.config ?? { enabled: false, directory: "" };
  const save = api.clsReviewSaveSchedule.useMutation({
    onSuccess: (config, submitted) => {
      setDraft((current) =>
        current &&
        current.directory === submitted.directory &&
        current.enabled === submitted.enabled
          ? null
          : current,
      );
      utils.clsReviewSchedule.setData(undefined, (previous) =>
        previous ? { ...previous, config } : previous,
      );
      setFeedback("调度设置已保存");
    },
  });
  return (
    <section className="space-y-3" aria-label="调度设置">
      <p className="text-sm">
        08:00—09:30读取当日报告，文件停止修改一分钟后固定样本；15:05后核对已有样本。应用未运行时不会执行，不改动Windows新闻分析任务。
      </p>
      <label className="flex gap-2 text-sm">
        <Checkbox
          checked={value.enabled}
          onCheckedChange={(checked) =>
            setDraft({ ...value, enabled: checked === true })
          }
        />
        应用运行时自动检查
      </label>
      <label className="block text-sm">
        报告目录
        <Input
          value={value.directory}
          onChange={(event) =>
            setDraft({ ...value, directory: event.target.value })
          }
        />
      </label>
      <Button
        disabled={save.isPending || !schedule.data}
        onClick={() => save.mutate(value)}
      >
        保存调度设置
      </Button>
      {schedule.data?.lastCheck && (
        <p className="text-sm text-nc-text-3">
          最近检查：{clsTime(schedule.data.lastCheck.checkedAt)} ·{" "}
          {schedule.data.lastCheck.message}
        </p>
      )}
      <p role="status" className="text-sm">
        {feedback}
      </p>
      <ClsError error={schedule.error} retry={() => void schedule.refetch()} />
      <ClsError error={save.error} />
    </section>
  );
}
