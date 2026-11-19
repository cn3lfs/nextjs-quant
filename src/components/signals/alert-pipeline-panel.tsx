"use client";
import Link from "next/link";
import { api, type RouterOutputs } from "~/trpc/react";
import { alertModeLabel } from "~/lib/common/ui-glossary";
import { useScreenVisible } from "../workbench/use-task-visible";
import { Panel } from "../panels";
import { Button } from "../ui/button";
import {
  ArrowClockwise,
  ArrowRight,
  CheckCircle,
  CircleDashed,
  Warning,
} from "@phosphor-icons/react/ssr";
import { monitorTime } from "./monitor-workspace-fields";

type Diagnostics = RouterOutputs["alertPipelineDiagnostics"];
type Stage = Diagnostics["stages"][number];
type Evidence = Diagnostics["evidence"];

/** Server stage keys are stable; these are the plain-Chinese row titles. */
const stageNames: Record<number, string> = {
  1: "触发",
  2: "入队",
  3: "订阅",
  4: "资格",
  5: "投递",
  6: "回执",
};

function stageTime(stage: number, evidence: Evidence) {
  const latest = (values: readonly (number | null | undefined)[]) => {
    const known = values.filter(
      (value): value is number => typeof value === "number",
    );
    return known.length ? Math.max(...known) : null;
  };
  switch (stage) {
    case 1:
      return evidence.event?.at ?? evidence.readiness.scanAt;
    case 2:
      return latest(evidence.deliveries.map((delivery) => delivery.createdAt));
    case 4:
    case 5:
    case 6:
      return latest([
        evidence.lastSuccess?.createdAt,
        evidence.lastFailure?.createdAt,
      ]);
    default:
      return null;
  }
}

/** One short evidence line per stage; unknown stays "—", never zero. */
function stageEvidence(stage: number, evidence: Evidence) {
  switch (stage) {
    case 1:
      return evidence.event
        ? `${evidence.event.key} · ${alertModeLabel(evidence.event.mode)}`
        : `基准日 ${evidence.readiness.expectedDate ?? "—"} · 收盘扫描 ${evidence.readiness.closeStatus ?? "未记录"}`;
    case 2:
      return `${evidence.deliveries.length} 条投递记录`;
    case 3:
      return `启用订阅 ${evidence.enabledSubscriptions} · 命中本事件 ${evidence.matchedSubscriptions}`;
    case 4:
      return `全局模式 ${alertModeLabel(evidence.mode)} · 版本授权 ${
        evidence.versionAuthorized == null
          ? "—"
          : evidence.versionAuthorized
            ? "已授权"
            : "未授权"
      }`;
    case 5:
      return `调度进程 ${
        evidence.schedulerAlive == null
          ? "—"
          : evidence.schedulerAlive
            ? "运行中"
            : "未运行"
      } · 已晋级策略 ${evidence.promotedCount}`;
    default:
      return evidence.lastFailure
        ? `最近失败：${evidence.lastFailure.failureReason ?? evidence.lastFailure.status}`
        : evidence.lastSuccess
          ? `最近成功：${monitorTime(evidence.lastSuccess.createdAt)}`
          : "尚无渠道回执";
  }
}

function stageStatus(stage: Stage, blockerStage: number | null) {
  if (stage.passed)
    return { tone: "text-nc-ok", label: "通过", kind: "passed" } as const;
  if (stage.stage === blockerStage)
    return { tone: "text-nc-warn", label: "阻断", kind: "blocked" } as const;
  return { tone: "text-nc-text-4", label: "未通过", kind: "pending" } as const;
}

function StageStatusIcon({ kind }: { kind: "passed" | "blocked" | "pending" }) {
  return kind === "passed" ? (
    <CheckCircle size={16} aria-hidden="true" className="text-nc-ok" />
  ) : kind === "blocked" ? (
    <Warning size={16} aria-hidden="true" className="text-nc-warn" />
  ) : (
    <CircleDashed size={16} aria-hidden="true" className="text-nc-text-4" />
  );
}

/**
 * Answers "can I receive an alert right now, and where does it stop" in one
 * place. It only reads existing events, subscriptions, authorizations and
 * deliveries; it never sends or retries anything.
 */
export function AlertPipelinePanel() {
  const visible = useScreenVisible();
  const query = api.alertPipelineDiagnostics.useQuery(undefined, {
    enabled: visible,
  });
  const data = query.data;
  const blocker = data?.primaryBlocker ?? null;
  const refresh = (
    <Button
      variant="outline"
      size="sm"
      disabled={query.isFetching}
      onClick={() => void query.refetch()}
    >
      <ArrowClockwise size={14} aria-hidden="true" />
      刷新诊断
    </Button>
  );
  return (
    <Panel
      title="提醒链路诊断"
      note="六个环节依次检查：触发 → 入队 → 订阅 → 资格 → 投递 → 回执。只读现有记录，不会发送或重试提醒。"
      actions={refresh}
    >
      {query.error && (
        <p role="alert" className="text-sm text-nc-bad">
          诊断读取失败：{query.error.message}
          <Button
            variant="outline"
            size="sm"
            className="ml-2"
            onClick={() => void query.refetch()}
          >
            重试诊断
          </Button>
        </p>
      )}
      {!visible && (
        <p role="status" className="text-sm text-nc-text-3">
          当前页面不可见，回到本页后自动读取提醒链路。
        </p>
      )}
      {visible && !data && !query.error && (
        <p role="status" className="text-sm text-nc-text-3">
          正在读取提醒链路…
        </p>
      )}
      {data && (
        <div className="space-y-3">
          {blocker ? (
            <div
              role="status"
              className="rounded-lg border border-nc-warn-edge p-3"
            >
              <p className="text-sub text-nc-text-3">当前结论</p>
              <p className="mt-1 font-semibold text-nc-warn">
                当前收不到提醒：卡在第 {blocker.stage} 步 ·{" "}
                {stageNames[blocker.stage] ?? ""}
              </p>
              <p className="mt-1 text-sm text-nc-text-2">{blocker.reason}</p>
              <Button asChild variant="outline" size="sm" className="mt-2">
                <Link href={blocker.fixHref}>
                  {blocker.fixLabel}
                  <ArrowRight size={14} aria-hidden="true" />
                </Link>
              </Button>
            </div>
          ) : (
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-nc-ok-edge p-3"
            >
              <CheckCircle
                size={18}
                aria-hidden="true"
                className="mt-0.5 flex-none text-nc-ok"
              />
              <div>
                <p className="font-semibold text-nc-ok">提醒链路就绪</p>
                <p className="mt-1 text-sm text-nc-text-3">
                  六个环节均通过；实际是否收到仍取决于当时是否有符合条件的触发。
                </p>
              </div>
            </div>
          )}
          <ul className="divide-y divide-nc-border-soft">
            {data.stages.map((stage) => {
              const status = stageStatus(stage, blocker?.stage ?? null);
              const at = stageTime(stage.stage, data.evidence);
              const isBlocker = blocker?.stage === stage.stage;
              return (
                <li
                  key={stage.stage}
                  className={`flex flex-wrap items-start gap-3 py-2 ${
                    isBlocker ? "border-l-2 border-nc-warn pl-2" : ""
                  }`}
                >
                  <span className="mt-0.5 flex-none">
                    <StageStatusIcon kind={status.kind} />
                  </span>
                  <div className="min-w-40 flex-1">
                    <p className="text-sm font-medium text-nc-text">
                      {stage.stage} {stageNames[stage.stage] ?? stage.label}
                      <span className={`ml-2 text-xs ${status.tone}`}>
                        {status.label}
                      </span>
                    </p>
                    <p className="mt-0.5 text-sm text-nc-text-2">
                      {stage.summary}
                    </p>
                    <p className="mt-0.5 text-xs text-nc-text-4">
                      依据：{stageEvidence(stage.stage, data.evidence)}
                    </p>
                  </div>
                  <div className="flex flex-none flex-col items-end gap-1 text-xs text-nc-text-4">
                    <span className="tabular">
                      {at == null ? "未记录时间" : monitorTime(at)}
                    </span>
                    <Link
                      href={stage.fixHref}
                      className="text-nc-accent underline"
                    >
                      {stage.fixLabel}
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-nc-text-4">
            统计截至 {monitorTime(data.evidence.asOf)}
            {data.evidence.lastCheck != null
              ? ` · 最近检查 ${monitorTime(data.evidence.lastCheck)}`
              : ""}
            。此页面不会触发真实外发。
          </p>
        </div>
      )}
    </Panel>
  );
}
