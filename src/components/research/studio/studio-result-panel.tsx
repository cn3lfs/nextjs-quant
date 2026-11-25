import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { TaskEvidence } from "~/components/workbench/task-evidence";
import type { DiagnoseArchiveSummary } from "~/lib/research/diagnose-contract";
import type { ResearchStudioDraftInput } from "~/lib/research/studio-result";
import { taskStatusLabels } from "~/lib/research/workflow/task-history";
import { taskHistoryHref } from "~/lib/research/workflow/task-history-location";
import { api, type RouterOutputs } from "~/trpc/react";
import { StateBanner } from "../../panels";
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
    <section aria-label="诊断归档详情" className="space-y-3">
      <DiagnoseForwardActions summary={detail.data.summary} />
      <DiagnoseDetailView
        detail={detail.data}
        active={active}
        onPageChange={setPage}
        onRerun={onRerun}
      />
    </section>
  );
}

type ForwardFeedback = {
  state: "info" | "error";
  title: string;
  detail: string;
};

/**
 * Promote a completed diagnose archive into forward observation. Both actions
 * require an explicit click plus confirmation and never place an order.
 *
 * The blocked-key test mirrors the server guards in
 * `src/server/paper/promote-from-research.ts`; the server remains authoritative.
 */
function DiagnoseForwardActions({
  summary,
}: {
  summary: DiagnoseArchiveSummary;
}) {
  const [confirmShadow, setConfirmShadow] = useState(false);
  const [paperOpen, setPaperOpen] = useState(false);
  const [feedback, setFeedback] = useState<ForwardFeedback | null>(null);
  const shadow = api.alertWatchResearchShadow.useMutation({
    onSuccess: (result) => {
      setConfirmShadow(false);
      setFeedback({
        state: "info",
        title: "已加入收盘监控（影子模式）",
        detail: `${result.strategyId} @ v${result.version} · ${result.symbolCount} 只标的${result.alreadyWatched ? " · 此前已监控" : ""}。仅登记观察与提醒，不会创建委托。`,
      });
    },
    onError: (error) =>
      setFeedback({
        state: "error",
        title: "影子监控登记失败",
        detail: error.message,
      }),
  });
  const promote = api.paperPromoteFromResearch.useMutation({
    onSuccess: (account) => {
      setPaperOpen(false);
      setFeedback({
        state: "info",
        title: "已登记纸面跟踪",
        detail: `纸面账户 ${account.name ?? account.id} 已创建，初始资金 ${account.initial.toLocaleString("zh-CN")} 元。仅纸面模拟，不会下单或进入实盘。`,
      });
    },
    onError: (error) =>
      setFeedback({
        state: "error",
        title: "纸面跟踪登记失败",
        detail: error.message,
      }),
  });
  const strategyKey =
    summary.run?.strategyKey ??
    (summary.strategyKeys.length === 1 ? summary.strategyKeys[0]! : null);
  const symbols = summary.symbols;
  const hasBook = Boolean(
    summary.book ||
    summary.bookPreset ||
    summary.run?.book ||
    summary.run?.bookPreset ||
    summary.strategyKeys.includes("core-4"),
  );
  const baseBlocker = !strategyKey
    ? "归档未包含单一策略键，无法登记前向跟踪。"
    : hasBook
      ? "组合分仓归档需要独立适配，当前不支持前向跟踪。"
      : strategyKey === "hold"
        ? "hold 是研究对照，不能登记为前向信号策略。"
        : strategyKey.includes("-pit")
          ? "该策略依赖时点（PIT）财务数据，尚未接入前向跟踪。"
          : symbols.length === 0
            ? "归档未包含可跟踪的证券池。"
            : null;
  const shadowBlocker =
    baseBlocker ??
    (symbols.some((symbol) => symbol.startsWith("bj"))
      ? "影子收盘监控目前仅支持沪深证券代码。"
      : null);
  const paperBlocker =
    baseBlocker ??
    (strategyKey?.startsWith("research-chan")
      ? "纸面账户尚未接入原生缠论观测。"
      : strategyKey?.startsWith("screener:f11-")
        ? "F11 龙头策略依赖情绪周期门控与前向涨停四池观察，请使用情绪周期前向视图。"
        : null);
  const busy = shadow.isPending || promote.isPending;

  function submitPaper(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!strategyKey) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const initial = Number(form.get("initial"));
    if (!name) {
      setFeedback({
        state: "error",
        title: "请填写纸面账户名称",
        detail: "名称用于在纸面账本中识别这次研究登记。",
      });
      return;
    }
    if (!Number.isFinite(initial) || initial <= 0 || initial > 1e9) {
      setFeedback({
        state: "error",
        title: "初始资金无效",
        detail: "请输入 0–10 亿元之间的正数。",
      });
      return;
    }
    promote.mutate({ name, initial, strategyKey, symbols });
  }

  return (
    <section aria-label="研究策略前向跟踪" className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sub font-semibold text-nc-text">前向跟踪</h3>
        <span className="text-sub text-nc-text-3">
          仅登记影子观察或纸面账户，不会下单，也不会切换为实盘。
        </span>
      </div>
      <TooltipProvider>
        <div className="flex flex-wrap items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="inline-flex"
                tabIndex={shadowBlocker ? 0 : undefined}
              >
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || shadowBlocker !== null}
                  onClick={() => {
                    setFeedback(null);
                    setConfirmShadow(true);
                  }}
                >
                  加入收盘监控（影子模式）
                </Button>
              </span>
            </TooltipTrigger>
            {shadowBlocker && (
              <TooltipContent className="max-w-80">
                {shadowBlocker}
              </TooltipContent>
            )}
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="inline-flex"
                tabIndex={paperBlocker ? 0 : undefined}
              >
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || paperBlocker !== null}
                  onClick={() => {
                    setFeedback(null);
                    setPaperOpen(true);
                  }}
                >
                  登记纸面跟踪
                </Button>
              </span>
            </TooltipTrigger>
            {paperBlocker && (
              <TooltipContent className="max-w-80">
                {paperBlocker}
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      </TooltipProvider>
      {confirmShadow && strategyKey && (
        <div className="space-y-2 rounded-lg bg-nc-inset p-3">
          <p className="text-sub text-nc-text-2">
            将以「{strategyKey}」和 {symbols.length} 只标的登记收盘影子观察。
            登记后只产生观察与提醒，不会创建委托。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => shadow.mutate({ strategyKey, symbols })}
            >
              确认加入影子监控
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmShadow(false)}
            >
              取消
            </Button>
          </div>
        </div>
      )}
      {paperOpen && strategyKey && (
        <form
          className="space-y-2 rounded-lg bg-nc-inset p-3"
          onSubmit={submitPaper}
        >
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sub text-nc-text-2">
              纸面账户名称
              <Input
                name="name"
                required
                maxLength={120}
                defaultValue={summary.title.slice(0, 120)}
                disabled={busy}
              />
            </label>
            <label className="grid gap-1 text-sub text-nc-text-2">
              初始资金（元）
              <Input
                name="initial"
                type="number"
                required
                min={1}
                max={1e9}
                step={1000}
                defaultValue={100000}
                disabled={busy}
              />
            </label>
          </div>
          <p className="text-sub text-nc-text-3">
            将冻结「{strategyKey}」当前版本并建立纸面账户，不会下单。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {promote.isPending ? "登记中…" : "确认登记纸面跟踪"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setPaperOpen(false)}
            >
              取消
            </Button>
          </div>
        </form>
      )}
      {feedback && (
        <StateBanner state={feedback.state} title={feedback.title}>
          {feedback.detail}
        </StateBanner>
      )}
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
        {draft.template === "etf-rotation" && (
          <Button asChild variant="outline">
            <Link
              href={`/?ticketSource=etf_rotation&etfStrategy=${encodeURIComponent(draft.config.strategyId)}#rebalance-tickets`}
            >
              按默认预设去作战室生成次日调仓单
            </Link>
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
