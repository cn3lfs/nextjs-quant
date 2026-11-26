"use client";

import { CheckCircle, ListChecks, Warning } from "@phosphor-icons/react/ssr";
import { formatNumber } from "trading-strategy-core/format-number";
import { Panel, Pill, StateBanner } from "~/components/panels";
import { Button } from "~/components/ui/button";
import {
  IntentLinks,
  intentStatusLabels,
  modeLabels,
  runStageLabels,
  statusLabels,
  venueLabels,
  type DeploymentItem,
  type OrderIntent,
  type RunDetail,
} from "./pipeline-detail";

export type PipelineInboxRow = {
  deployment: DeploymentItem;
  /** Latest run detail, or null while it is not loaded / does not exist. */
  run: RunDetail | null;
  error?: string;
};

function isAbnormal(stage: string | null | undefined) {
  return stage === "failed" || stage === "blocked" || stage === "partial";
}

function IntentRow({
  intent,
  deployment,
  onOpen,
}: {
  intent: OrderIntent;
  deployment: DeploymentItem;
  onOpen: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-nc-border-soft bg-nc-inset px-2 py-1.5 text-[11px]">
      <Pill tone={intent.phase === 1 ? "warn" : "ok"}>
        {intent.phase === 1 ? "阶段1 卖出" : "阶段2 买入"}
      </Pill>
      <strong className="font-medium text-nc-text">{intent.symbol}</strong>
      <span className="text-nc-text-3">
        {deployment.name} · {intent.side === "BUY" ? "买入" : "卖出"} · 数量{" "}
        {formatNumber(intent.quantity, deployment.market === "crypto" ? 6 : 0)}{" "}
        · 参考价 {formatNumber(intent.referencePrice, 2)}
      </span>
      <span className="text-nc-text-4">
        {intentStatusLabels[intent.status] ?? intent.status}
      </span>
      {intent.errorSummary && (
        <span className="text-nc-bad">{intent.errorSummary}</span>
      )}
      <span className="ml-auto flex flex-wrap items-center gap-2">
        <IntentLinks intent={intent} market={deployment.market} />
        <Button type="button" size="sm" variant="outline" onClick={onOpen}>
          去处理
        </Button>
      </span>
    </li>
  );
}

/**
 * 今日待办收件箱：只回答「今天需要我处理什么」。五阶段运维按钮留在
 * 各部署的展开详情里，这里不重复堆叠操作。
 */
export function PipelineInbox({
  rows,
  today,
  loading = false,
  onOpen,
}: {
  rows: readonly PipelineInboxRow[];
  today: string;
  loading?: boolean;
  onOpen: (id: string) => void;
}) {
  const active = rows.filter(
    ({ deployment }) => deployment.status === "active",
  );
  const approvals = active
    .filter(({ deployment }) => deployment.executionMode === "manual_confirm")
    .flatMap(({ deployment, run }) =>
      (run?.intents ?? [])
        .filter(
          (intent) => intent.status === "planned" || intent.status === "queued",
        )
        .map((intent) => ({ deployment, intent })),
    );
  const abnormal = active.flatMap(({ deployment, run }) => {
    const latest = run?.run ?? deployment.latestRun;
    return latest && isAbnormal(latest.stage) ? [{ deployment, latest }] : [];
  });
  const activeToday = active.filter(
    ({ deployment, run }) =>
      (run?.run ?? deployment.latestRun)?.decisionDate === today,
  ).length;
  const errors = rows.filter(({ error }) => error);

  return (
    <Panel
      icon={ListChecks}
      title="今日待办"
      meta={
        loading
          ? "正在核对运行与审批…"
          : `待审批 ${approvals.length} · 异常 ${abnormal.length} · 今日已跑 ${activeToday}`
      }
      note="只汇总需要人工处理的事项；不会自动下单。点击「去处理」展开对应部署的运维区。"
      bodyClassName="space-y-3"
    >
      <section aria-label="待人工审批意图" className="space-y-1.5">
        <h4 className="m-0 flex items-center gap-1.5 text-sm font-semibold text-nc-text">
          <CheckCircle size={15} className="text-nc-warn" aria-hidden="true" />
          待人工审批意图（{approvals.length}）
        </h4>
        {approvals.length === 0 ? (
          <p className="text-sub text-nc-text-3">
            没有等待人工审批的订单意图。
          </p>
        ) : (
          <ul className="m-0 list-none space-y-1 p-0">
            {approvals.map(({ deployment, intent }) => (
              <IntentRow
                key={`${deployment.id}:${intent.id}`}
                deployment={deployment}
                intent={intent}
                onOpen={() => onOpen(deployment.id)}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="异常或拦截运行" className="space-y-1.5">
        <h4 className="m-0 flex items-center gap-1.5 text-sm font-semibold text-nc-text">
          <Warning size={15} className="text-nc-bad" aria-hidden="true" />
          异常 / 拦截运行（{abnormal.length}）
        </h4>
        {abnormal.length === 0 ? (
          <p className="text-sub text-nc-text-3">最近没有异常或拦截的运行。</p>
        ) : (
          <ul className="m-0 list-none space-y-1 p-0">
            {abnormal.map(({ deployment, latest }) => (
              <li
                key={deployment.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-nc-bad-edge bg-nc-inset px-2 py-1.5 text-[11px]"
              >
                <strong className="font-medium text-nc-text">
                  {deployment.name}
                </strong>
                <Pill tone="bad">
                  {runStageLabels[latest.stage] ?? latest.stage}
                </Pill>
                <span className="text-nc-text-3">
                  决策日 {latest.decisionDate}
                </span>
                {latest.errorSummary && (
                  <span className="min-w-0 flex-1 truncate text-nc-bad">
                    {latest.errorSummary}
                  </span>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  onClick={() => onOpen(deployment.id)}
                >
                  去处理
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="今日活跃部署状态" className="space-y-1.5">
        <h4 className="m-0 text-sm font-semibold text-nc-text">
          今日活跃部署（{active.length}）
        </h4>
        {active.length === 0 ? (
          <p className="text-sub text-nc-text-3">当前没有运行中的策略部署。</p>
        ) : (
          <ul className="m-0 list-none space-y-1 p-0">
            {active.map(({ deployment, run }) => {
              const stage = run?.run.stage ?? deployment.latestRun?.stage;
              const decisionDate =
                run?.run.decisionDate ?? deployment.latestRun?.decisionDate;
              const ranToday = decisionDate === today;
              return (
                <li
                  key={deployment.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-nc-text-3"
                >
                  <strong className="font-medium text-nc-text">
                    {deployment.name}
                  </strong>
                  <Pill tone={deployment.status === "active" ? "ok" : "idle"}>
                    {statusLabels[deployment.status]}
                  </Pill>
                  <span>{modeLabels[deployment.executionMode]}</span>
                  <span>· {venueLabels[deployment.venueBinding.kind]}</span>
                  <span>
                    · 监控池 {deployment.activePoolCount} 只 ·{" "}
                    {stage ? (runStageLabels[stage] ?? stage) : "尚未运行"}
                  </span>
                  <span className={ranToday ? "text-nc-ok" : "text-nc-warn"}>
                    · {ranToday ? "今日已运行" : "今日尚未运行"}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => onOpen(deployment.id)}
                  >
                    查看
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {errors.length > 0 && (
        <StateBanner state="warn" title="部分部署的运行详情读取失败">
          {errors
            .map(({ deployment, error }) => `${deployment.name}：${error}`)
            .join("；")}
        </StateBanner>
      )}
    </Panel>
  );
}
