import { useState } from "react";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { TaskEvidence } from "~/components/workbench/task-evidence";
import type { DiagnoseArchiveSummary } from "~/lib/research/diagnose-contract";
import type { ResearchStudioDraftInput } from "~/lib/research/studio-result";
import { taskStatusLabels } from "~/lib/research/workflow/task-history";
import { taskHistoryHref } from "~/lib/research/workflow/task-history-location";
import { api, type RouterOutputs } from "~/trpc/react";
import { DiagnoseDetailView } from "../diagnose/diagnose-detail-view";
import { formatPercent } from "../diagnose/format";
import { useArchiveDownload } from "../use-archive-download";
import { StudioResultView } from "./studio-result-view";
import { studioRunMarkdown, type StudioSessionRun } from "./studio-session";

export function StudioDiagnoseResult({
  id,
  active,
  onRerun,
}: {
  id: string;
  active: boolean;
  onRerun: (archive: DiagnoseArchiveSummary) => void;
}) {
  const [page, setPage] = useState(1);
  const detail = api.strategyLabDiagnoseArchiveDetail.useQuery(
    { id, page, pageSize: 10 },
    { enabled: active },
  );
  if (detail.error)
    return (
      <div className="space-y-2">
        <p role="alert">读取诊断归档失败：{detail.error.message}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void detail.refetch()}
        >
          重新读取诊断归档
        </Button>
      </div>
    );
  if (detail.isPending) return <p role="status">正在读取诊断归档…</p>;
  if (!detail.data) return <p role="status">找不到诊断归档 {id}。</p>;
  return (
    <section aria-label="诊断归档详情">
      <DiagnoseDetailView
        detail={detail.data}
        active={active}
        onPageChange={setPage}
        onRerun={onRerun}
      />
    </section>
  );
}

export function StudioJobResult({
  id,
  job,
  active,
}: {
  id: string;
  job: {
    data?: RouterOutputs["jobSummary"];
    error: { message: string } | null;
    isPending: boolean;
    refetch: () => Promise<unknown>;
  };
  active: boolean;
}) {
  const utils = api.useUtils();
  const cancel = api.cancel.useMutation({
    onSuccess: () => utils.jobSummary.invalidate({ id }),
  });
  if (job.error)
    return (
      <div className="space-y-2">
        <p role="alert">读取任务失败：{job.error.message}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void job.refetch()}
        >
          重试读取任务
        </Button>
      </div>
    );
  if (job.isPending) return <p role="status">正在读取研究任务…</p>;
  if (job.data?.type !== "backtest")
    return <p role="status">找不到研究回测任务 {id}。</p>;
  const { status, progress, phase, error, localEvidence } = job.data;
  return (
    <section aria-label="研究任务结果" className="space-y-3">
      <p role="status">
        {taskStatusLabels[status]} · {progress}%{phase && ` · ${phase}`}
      </p>
      {(error || cancel.error) && (
        <p role="alert">{error ?? cancel.error?.message}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {(status === "queued" || status === "running") && (
          <Button
            type="button"
            variant="outline"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(id)}
          >
            取消任务
          </Button>
        )}
        <Button asChild variant="outline">
          <Link href={taskHistoryHref({ id })}>在任务中心查看</Link>
        </Button>
      </div>
      {active && status === "completed" && localEvidence && (
        <TaskEvidence id={id} />
      )}
    </section>
  );
}

type DirectDraft = Extract<
  ResearchStudioDraftInput,
  { template: "etf-rotation" | "alpha-formula" | "exit-family" }
>;

export function StudioSessionResult({
  run,
  storageError,
  onViewArchive,
  onRerun,
}: {
  run: StudioSessionRun;
  storageError: boolean;
  onViewArchive: (id: string) => void;
  onRerun: (draft: DirectDraft) => void;
}) {
  const download = useArchiveDownload();
  const { id, result, draft } = run;
  const archiveId = result.archiveId;
  return (
    <section aria-label="研究回测结果" className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            download.save(
              () => studioRunMarkdown(run, formatPercent),
              `${id}.md`,
              "text/markdown;charset=utf-8",
            )
          }
        >
          导出 Markdown
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            download.save(
              () => JSON.stringify(run, null, 2),
              `${id}.json`,
              "application/json",
            )
          }
        >
          导出研究结果 JSON
        </Button>
        {archiveId && (
          <Button
            type="button"
            variant="outline"
            onClick={() => onViewArchive(archiveId)}
          >
            查看诊断归档
          </Button>
        )}
        {(draft.template === "etf-rotation" ||
          draft.template === "alpha-formula" ||
          draft.template === "exit-family") && (
          <Button
            type="button"
            variant="outline"
            onClick={() => onRerun(draft)}
          >
            用相同参数复跑
          </Button>
        )}
      </div>
      {storageError && (
        <p role="status">浏览器未能保存此运行。刷新前请导出研究结果。</p>
      )}
      {download.error && <p role="alert">{download.error}</p>}
      <StudioResultView result={result} />
    </section>
  );
}
