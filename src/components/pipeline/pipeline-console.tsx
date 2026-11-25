"use client";

import {
  ArrowsClockwise,
  Broadcast,
  CheckCircle,
  Gauge,
  Lightning,
  ListMagnifyingGlass,
  PlayCircle,
  Plus,
  ShieldCheck,
  StopCircle,
  XCircle,
} from "@phosphor-icons/react/ssr";
import { useState } from "react";
import {
  isExecutionModeCompatibleWithVenue,
  isLiveVenueKind,
  poolSyncSnapshotSchema,
  strategyTargetProposalSchema,
  type ExecutionMode,
  type ExecutionVenueKind,
} from "trading-strategies";
import { formatNumber } from "trading-strategy-core/format-number";
import { Panel, Segmented, StateBanner } from "~/components/panels";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/common/classnames";
import { chinaDate } from "~/lib/market/security-trading-status";
import { api, type RouterInputs, type RouterOutputs } from "~/trpc/react";
import { DeployStrategyDialog } from "./deploy-strategy-dialog";

type DeploymentItem = RouterOutputs["deploymentList"]["items"][number];
type DeploymentStatus = DeploymentItem["status"];
type StrategyKind = DeploymentItem["strategySpec"]["kind"];
type RunDetail = RouterOutputs["pipelineRunDetail"];
type OrderIntent = RunDetail["intents"][number];
type PoolEntry = RouterOutputs["deploymentPoolList"]["items"][number];
type StepInput = RouterInputs["pipelineRunStep"];
type StepResult = RouterOutputs["pipelineRunStep"];
type ExecutionResult = RouterOutputs["pipelineIntentApprove"];

const liveConfirmationPhrase = "ENABLE_LIVE_TRADING";

const statusLabels: Record<DeploymentStatus, string> = {
  draft: "草稿",
  active: "运行中",
  paused: "已暂停",
  archived: "已归档",
};

const modeLabels: Record<ExecutionMode, string> = {
  shadow: "影子观察",
  manual_confirm: "手动确认",
  auto_sim: "自动模拟",
  auto_live: "自动实盘",
};

const venueLabels: Record<ExecutionVenueKind, string> = {
  local_sim: "本地模拟",
  ths_mock: "同花顺模拟",
  crypto_sim: "数字货币模拟",
  cn_broker_live: "A 股实盘",
  crypto_live: "数字货币实盘",
};

const strategyKindLabels: Record<StrategyKind, string> = {
  "study-rule": "研究规则",
  "theory-screener": "理论选股器",
  "etf-rotation": "ETF 轮动",
  "alpha-composite": "因子复合",
  "macro-clock": "宏观时钟",
  "pair-switch": "配对切换",
  "value-pit": "价值洼地",
  formula: "自定义公式",
  "double-breakout": "双突破",
  "chan-native": "缠论原生",
  "crypto-dual-ma": "数字货币双均线",
  "multi-book": "多策略组合",
};

const runStageLabels: Record<string, string> = {
  pending: "待运行",
  universe_done: "监控池已同步",
  signals_done: "信号已生成",
  risk_checked: "风控规划完成",
  executing: "执行中",
  completed: "已完成",
  partial: "部分完成",
  blocked: "已拦截",
  failed: "失败",
};

const intentStatusLabels: Record<string, string> = {
  planned: "已计划",
  queued: "排队中",
  submitting: "提交中",
  submitted: "已提交",
  filled: "已成交",
  partial_filled: "部分成交",
  rejected: "已拒绝",
  cancelled: "已取消",
  unknown_reconcile: "待对账",
};

const signalActionLabels = { BUY: "买入", SELL: "卖出", HOLD: "持有" };

const skipReasonLabels: Record<string, string> = {
  "execution-mode-blocked": "影子观察模式不发送委托",
  "shadow-mode": "影子观察模式不发送委托",
  "manual-approval-required": "手动确认模式需要逐单审批",
  "kill-switch-off": "模拟盘自动下单总开关未开启",
  "live-kill-switch-off": "实盘自动下单总开关未开启",
  "deployment-inactive": "策略部署未启用",
  "execute-date-expired": "执行日期已过期",
  "pending-sell-phase": "卖单尚未全部进入终态",
  "execute-date-mismatch": "执行日期与运行不一致",
  "manual-confirm-mode-required": "逐单执行仅用于手动确认模式",
};

const stageSteps = [
  {
    key: "universe",
    label: "每日选股 → 监控池",
    action: "同步监控池",
    icon: ArrowsClockwise,
  },
  {
    key: "signals",
    label: "池内出信号",
    action: "生成信号",
    icon: ListMagnifyingGlass,
  },
  { key: "risk", label: "门控与风控", action: "风控规划", icon: ShieldCheck },
  { key: "execute", label: "下单执行", action: "立即执行", icon: PlayCircle },
  { key: "reconcile", label: "成交与审计", action: "对账", icon: Gauge },
] as const;

function formatTime(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(source: unknown, key: string): number | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(source: unknown, key: string): string | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function readBoolean(source: unknown, key: string): boolean | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === "boolean" ? value : null;
}

function readArray(source: unknown, key: string): unknown[] | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return Array.isArray(value) ? value : null;
}

function describeExecution(result: ExecutionResult): string {
  return result.skipped
    ? `执行已跳过：${skipReasonLabels[result.reason] ?? result.reason}。`
    : `执行处理结果：${runStageLabels[result.stage] ?? result.stage}。`;
}

function describeStepResult(data: StepResult): string {
  if ("queried" in data) return `对账完成，查询 ${data.queried} 笔订单意图。`;
  if ("skipped" in data) return describeExecution(data);
  const { run, intents } = data;
  const planning = `运行状态：${runStageLabels[run.stage] ?? run.stage}，订单意图 ${intents.length} 笔。`;
  return "execution" in data && data.execution
    ? `${planning} ${describeExecution(data.execution)}`
    : planning;
}

function CompactSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-nc-text-4">
      <span>{label}</span>
      <select
        aria-label={label}
        className="h-8 rounded-md border border-input bg-nc-field px-1.5 text-xs text-nc-text"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function DeploymentCard({
  deployment,
  onChanged,
}: {
  deployment: DeploymentItem;
  onChanged: () => Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [stepNotice, setStepNotice] = useState("");
  const [decisionDate, setDecisionDate] = useState("");
  const [executeDate, setExecuteDate] = useState("");
  const venueKind = deployment.venueBinding.kind;
  const live = isLiveVenueKind(venueKind);
  const updateMode = api.deploymentUpdateMode.useMutation({
    onSuccess: () => {
      setStepNotice("已更新部署状态。");
      return onChanged();
    },
  });
  const runStep = api.pipelineRunStep.useMutation({
    onSuccess: (data) => {
      setStepNotice(describeStepResult(data));
      return onChanged();
    },
    onError: () => onChanged(),
  });

  const stage = deployment.latestRun?.stage ?? null;
  const latestRun = deployment.latestRun;
  const reached = [
    latestRun?.universeSnapshot != null,
    latestRun?.signals != null,
    latestRun?.riskVerdict != null,
    stage === "executing" || stage === "partial",
    latestRun != null,
  ];
  const modeOptions = (
    ["shadow", "manual_confirm", "auto_sim", "auto_live"] as const
  )
    .filter((mode) => isExecutionModeCompatibleWithVenue(mode, venueKind))
    .map((mode) => ({ value: mode, label: modeLabels[mode] }));

  const runStage = (stage: StepInput["stage"]) => {
    updateMode.reset();
    setStepNotice("");
    const run = stage === "execute" ? latestRun : null;
    const decision =
      run?.decisionDate ?? (decisionDate || chinaDate(Date.now()));
    if (
      stage !== "execute" &&
      stage !== "reconcile" &&
      executeDate &&
      executeDate < decision
    ) {
      setStepNotice("计划执行日须与决策日相同或晚于决策日。");
      return;
    }
    runStep.mutate({
      deploymentId: deployment.id,
      stage,
      decisionDate: decision,
      ...(run && { runSlot: run.runSlot }),
      ...(stage !== "execute" &&
        stage !== "reconcile" &&
        executeDate && { executeDate }),
    });
  };
  const actionPending = updateMode.isPending || runStep.isPending;

  return (
    <section className="rounded-lg border border-nc-border bg-nc-card">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-nc-border-soft px-3 py-2">
        <strong className="text-sm font-semibold text-nc-text">
          {deployment.name}
        </strong>
        <span
          className="nc-status-chip"
          data-state={deployment.market === "crypto" ? "idle" : "ok"}
          title="部署市场"
        >
          {deployment.market === "crypto" ? "数字货币" : "A 股"}
        </span>
        <span
          className="nc-status-chip"
          data-state={live ? "bad" : "idle"}
          title={`交易通道：${venueLabels[venueKind]}`}
        >
          <i aria-hidden="true" />
          {venueLabels[venueKind]}
        </span>
        <span className="text-[11px] text-nc-text-4">
          {strategyKindLabels[deployment.strategySpec.kind]}
        </span>
        <span
          className="nc-status-chip"
          data-state={
            deployment.status === "active"
              ? "ok"
              : deployment.status === "paused"
                ? "warn"
                : "idle"
          }
        >
          {statusLabels[deployment.status]}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <CompactSelect
            label="状态"
            value={deployment.status}
            disabled={actionPending}
            options={(["draft", "active", "paused", "archived"] as const).map(
              (status) => ({
                value: status,
                label: statusLabels[status],
              }),
            )}
            onChange={(status) => {
              if (status === deployment.status) return;
              runStep.reset();
              updateMode.mutate({ id: deployment.id, status });
            }}
          />
          <CompactSelect
            label="模式"
            value={deployment.executionMode}
            disabled={actionPending}
            options={modeOptions}
            onChange={(executionMode) => {
              if (executionMode === deployment.executionMode) return;
              runStep.reset();
              updateMode.mutate({ id: deployment.id, executionMode });
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "收起详情" : "展开详情"}
          </Button>
        </div>
      </header>

      <div className="space-y-2 px-3 py-2">
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
          {stageSteps.map((step, index) => (
            <div
              key={step.key}
              className={cn(
                "min-w-0 rounded-md border px-2 py-1.5",
                reached[index]
                  ? "border-nc-accent-800 bg-nc-accent-900 text-nc-text"
                  : "border-nc-border-soft bg-nc-inset text-nc-text-4",
              )}
              title={step.label}
            >
              <span className="block text-[10px]">
                {index + 1}. {step.label}
              </span>
              <span className="block truncate text-[11px]">
                {index === 0
                  ? `在监 ${deployment.activePoolCount} 只`
                  : index === 2 && stage === "blocked"
                    ? "已拦截"
                    : index === 3 && stage === "completed"
                      ? "运行已结束"
                      : reached[index]
                        ? index === 4
                          ? "有运行记录"
                          : "已推进"
                        : "待运行"}
              </span>
            </div>
          ))}
        </div>
        <details className="text-sub text-nc-text-3">
          <summary className="cursor-pointer">单步规划日期</summary>
          <div className="mt-1 flex flex-wrap gap-2">
            <label className="flex items-center gap-1">
              决策日
              <Input
                type="date"
                className="h-8 w-auto"
                value={decisionDate}
                onChange={(event) => setDecisionDate(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-1">
              计划执行日
              <Input
                type="date"
                className="h-8 w-auto"
                value={executeDate}
                onChange={(event) => setExecuteDate(event.target.value)}
              />
            </label>
          </div>
          <p className="mt-1 text-nc-text-4">
            决策日留空时取北京时间当天，计划执行日留空时取决策日。「立即执行」使用最近一次运行已保存的日期。
          </p>
        </details>
        <div className="flex flex-wrap items-center gap-1.5">
          {stageSteps.map(({ key, action, icon: Icon }) => (
            <Button
              key={key}
              type="button"
              size="sm"
              variant={key === "execute" && live ? "danger" : "outline"}
              disabled={
                actionPending ||
                (key !== "reconcile" && deployment.status === "archived")
              }
              onClick={() => runStage(key)}
            >
              <Icon size={14} aria-hidden="true" />
              {action}
            </Button>
          ))}
          <Button
            type="button"
            size="sm"
            variant={
              live && deployment.executionMode === "auto_live"
                ? "danger"
                : "default"
            }
            disabled={actionPending || deployment.status === "archived"}
            onClick={() => runStage("full")}
          >
            <Lightning size={14} aria-hidden="true" />
            一键跑完
          </Button>
          {runStep.isPending && (
            <span role="status" className="text-[11px] text-nc-text-4">
              正在运行…
            </span>
          )}
        </div>
        {(stepNotice || updateMode.error || runStep.error) && (
          <p
            role={updateMode.error || runStep.error ? "alert" : "status"}
            className={cn(
              "text-[11px]",
              updateMode.error || runStep.error
                ? "text-nc-bad"
                : "text-nc-text-3",
            )}
          >
            {updateMode.error?.message ?? runStep.error?.message ?? stepNotice}
          </p>
        )}
        {deployment.pauseReason && deployment.status === "paused" && (
          <p className="text-[11px] text-nc-warn">
            暂停原因：{deployment.pauseReason}
          </p>
        )}
      </div>

      {expanded && (
        <div className="space-y-2 border-t border-nc-border-soft px-3 py-2">
          <DeploymentDetail deployment={deployment} onChanged={onChanged} />
        </div>
      )}
    </section>
  );
}

function DeploymentDetail({
  deployment,
  onChanged,
}: {
  deployment: DeploymentItem;
  onChanged: () => Promise<unknown>;
}) {
  const [view, setView] = useState<"pool" | "run">("pool");
  return (
    <div className="space-y-2">
      <Segmented
        label="运行详情视图"
        value={view}
        onChange={setView}
        options={[
          { value: "pool", label: "监控池" },
          { value: "run", label: "最近运行与订单意图" },
        ]}
      />
      {view === "pool" ? (
        <PoolView deploymentId={deployment.id} onChanged={onChanged} />
      ) : (
        <RunView deployment={deployment} onChanged={onChanged} />
      )}
    </div>
  );
}

function PoolView({
  deploymentId,
  onChanged,
}: {
  deploymentId: string;
  onChanged: () => Promise<unknown>;
}) {
  const [status, setStatus] = useState<"watching" | "evicted">("watching");
  const [symbol, setSymbol] = useState("");
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const list = api.deploymentPoolList.useInfiniteQuery(
    { deploymentId, status, limit: 50 },
    { getNextPageParam: ({ nextCursor }) => nextCursor ?? undefined },
  );
  const add = api.deploymentPoolAdd.useMutation({
    onSuccess: (entry) => {
      setNotice(`已将 ${entry.symbol} 加入监控池。`);
      setSymbol("");
      setReason("");
      return onChanged();
    },
  });
  const evict = api.deploymentPoolEvict.useMutation({
    onSuccess: (entry) => {
      setNotice(`已将 ${entry.symbol} 移出监控池。`);
      return onChanged();
    },
  });
  const entries: readonly PoolEntry[] =
    list.data?.pages.flatMap(({ items }) => items) ?? [];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="监控池状态"
          value={status}
          onChange={setStatus}
          options={[
            { value: "watching", label: "在监标的" },
            { value: "evicted", label: "已移出" },
          ]}
        />
        <span className="text-[11px] text-nc-text-4">
          {list.data
            ? `${list.hasNextPage ? "已加载" : "共"} ${entries.length} 条`
            : "—"}
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-1.5 rounded-lg border border-nc-border-soft bg-nc-inset px-2 py-1.5">
        <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-[11px] text-nc-text-4">
          <span>手动加票</span>
          <Input
            aria-label="手动加票代码"
            className="h-8"
            placeholder="sh600000"
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-[11px] text-nc-text-4">
          <span>入池原因（可选）</span>
          <Input
            aria-label="入池原因"
            className="h-8"
            placeholder="观察理由"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <Button
          type="button"
          size="sm"
          disabled={!symbol.trim() || add.isPending || evict.isPending}
          onClick={() => {
            evict.reset();
            add.mutate({
              deploymentId,
              symbol: symbol.trim(),
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            });
          }}
        >
          <Plus size={14} aria-hidden="true" />
          加票入池
        </Button>
      </div>
      {(notice || add.error || evict.error) && (
        <p
          role={add.error || evict.error ? "alert" : "status"}
          className={cn(
            "text-[11px]",
            add.error || evict.error ? "text-nc-bad" : "text-nc-text-3",
          )}
        >
          {add.error?.message ?? evict.error?.message ?? notice}
        </p>
      )}
      {list.isPending && (
        <p role="status" className="text-[11px] text-nc-text-4">
          正在读取监控池…
        </p>
      )}
      {list.error && (
        <StateBanner
          state="error"
          title="监控池读取失败"
          action={{ label: "重试", onClick: () => void list.refetch() }}
        >
          {list.error.message}
        </StateBanner>
      )}
      {!list.isPending && !list.error && entries.length === 0 && (
        <p className="text-[11px] text-nc-text-4">
          {status === "watching"
            ? "监控池暂无在监标的。可在上方手动加票，或运行「同步监控池」。"
            : "暂无已移出的标的。"}
        </p>
      )}
      {entries.length > 0 && (
        <ul className="divide-y divide-nc-border-soft rounded-lg border border-nc-border-soft">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 text-[11px]"
            >
              <strong className="w-20 shrink-0 font-medium text-nc-text">
                {entry.symbol}
              </strong>
              <span className="text-nc-text-4">入池 {entry.enteredDate}</span>
              <span className="text-nc-text-4">
                来源 {entry.source === "manual" ? "手动" : "选股器"}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-nc-text-3"
                title={entry.entryReason}
              >
                {entry.entryReason || "—"}
              </span>
              <span className="text-nc-text-4">
                连续未命中 {entry.consecutiveMissedDays} 天
              </span>
              <span className="text-nc-text-4">
                信号{" "}
                {entry.lastSignalDate
                  ? `${entry.lastSignalDate} · ${entry.lastSignalAction ? signalActionLabels[entry.lastSignalAction] : "—"}`
                  : "—"}
              </span>
              {entry.status === "watching" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={evict.isPending || add.isPending}
                  onClick={() => {
                    add.reset();
                    evict.mutate({ deploymentId, symbol: entry.symbol });
                  }}
                >
                  移出监控池
                </Button>
              ) : (
                <span className="text-nc-text-4">
                  移出 {entry.evictedDate ?? "—"} · {entry.evictReason ?? "—"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={list.isFetching}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? "正在加载…" : "加载更多"}
        </Button>
      )}
    </div>
  );
}

function RunView({
  deployment,
  onChanged,
}: {
  deployment: DeploymentItem;
  onChanged: () => Promise<unknown>;
}) {
  const runId = deployment.latestRun?.id ?? "";
  const [notice, setNotice] = useState("");
  const detail = api.pipelineRunDetail.useQuery(
    { runId },
    { enabled: Boolean(runId) },
  );
  const approve = api.pipelineIntentApprove.useMutation({
    onSuccess: (result) => {
      setNotice(describeExecution(result));
      return onChanged();
    },
  });
  const cancel = api.pipelineIntentCancel.useMutation({
    onSuccess: () => {
      setNotice("已取消订单意图。");
      return onChanged();
    },
  });

  if (!runId)
    return (
      <StateBanner state="empty" title="尚未运行" hideIcon>
        先执行任一规划阶段，运行结果与订单意图会显示在这里。
      </StateBanner>
    );
  if (detail.isPending)
    return (
      <p role="status" className="text-[11px] text-nc-text-4">
        正在读取最近运行…
      </p>
    );
  if (detail.error)
    return (
      <StateBanner
        state="error"
        title="运行详情读取失败"
        action={{ label: "重试", onClick: () => void detail.refetch() }}
      >
        {detail.error.message}
      </StateBanner>
    );
  const data = detail.data;
  if (!data) return null;
  const run = data.run;
  const snapshot = poolSyncSnapshotSchema.safeParse(run.universeSnapshot).data;
  const proposal = strategyTargetProposalSchema.safeParse(run.signals).data;
  const signals = proposal?.signals;
  const verdict = run.riskVerdict;
  const regime = isRecord(verdict) ? verdict.regime : null;
  const allowEntries = readBoolean(verdict, "allowNewEntries");
  const drawdown = readNumber(verdict, "drawdownPct");
  const reasons = [
    ...new Set(
      [
        ...(readArray(regime, "reasons") ?? []),
        ...(readArray(verdict, "reasons") ?? []),
      ].filter((reason): reason is string => typeof reason === "string"),
    ),
  ];
  const intents: readonly OrderIntent[] = data.intents;

  return (
    <div className="space-y-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="nc-status-chip" data-state="idle">
          决策日 {run.decisionDate}
        </span>
        <span
          className="nc-status-chip"
          data-state={
            run.stage === "failed"
              ? "bad"
              : run.stage === "completed" || run.stage === "partial"
                ? "ok"
                : "idle"
          }
        >
          {runStageLabels[run.stage] ?? run.stage}
        </span>
        <span className="text-nc-text-4">
          开始 {formatTime(run.startedAt)} · 结束 {formatTime(run.finishedAt)}
        </span>
      </div>
      {run.errorSummary && (
        <p role="alert" className="text-nc-bad">
          运行错误：{run.errorSummary}
        </p>
      )}
      <div className="rounded-lg border border-nc-border-soft bg-nc-inset px-2 py-1.5">
        <p className="m-0 font-medium text-nc-text-2">监控池变动</p>
        <p className="m-0 text-nc-text-3">
          新进 {snapshot ? `+${snapshot.added.length}` : "—"} · 留池{" "}
          {snapshot?.retained.length ?? "—"} · 移出{" "}
          {snapshot ? `-${snapshot.evicted.length}` : "—"} · 宽限{" "}
          {snapshot?.missedGrace.length ?? "—"} · 在监{" "}
          {snapshot?.activePoolCount ?? "—"} 只
          {snapshot && ` · 截至 ${snapshot.asOf}`}
        </p>
      </div>
      <div className="rounded-lg border border-nc-border-soft bg-nc-inset px-2 py-1.5">
        <p className="m-0 font-medium text-nc-text-2">
          信号明细（{signals?.length ?? "—"}）
        </p>
        {!signals ? (
          <p className="m-0 text-nc-text-4">信号尚未生成。</p>
        ) : signals.length === 0 ? (
          <p className="m-0 text-nc-text-4">本次运行没有信号。</p>
        ) : (
          <ul className="m-0 list-none space-y-0.5 p-0">
            {signals.map(
              (
                { symbol, action, score, stopPrice, targetPrice, reason },
                index,
              ) => {
                return (
                  <li key={`${symbol}:${index}`} className="text-nc-text-3">
                    {symbol} · {action} · 评分 {score ?? "—"} · 止损{" "}
                    {stopPrice === null ? "—" : formatNumber(stopPrice, 2)} ·
                    目标{" "}
                    {targetPrice === null ? "—" : formatNumber(targetPrice, 2)}{" "}
                    · {reason || "—"}
                  </li>
                );
              },
            )}
          </ul>
        )}
      </div>
      <div className="rounded-lg border border-nc-border-soft bg-nc-inset px-2 py-1.5">
        <p className="m-0 font-medium text-nc-text-2">风控结论</p>
        <p className="m-0 text-nc-text-3">
          门控 {readString(regime, "status") ?? "—"} ·{" "}
          {allowEntries === null
            ? "新开仓：—"
            : allowEntries
              ? "允许新开仓"
              : "禁止新开仓"}{" "}
          · 回撤 {drawdown === null ? "—" : `${(drawdown * 100).toFixed(2)}%`}
        </p>
        {reasons.length > 0 && (
          <p className="m-0 text-nc-text-4">{reasons.join("；")}</p>
        )}
      </div>
      <div className="rounded-lg border border-nc-border-soft bg-nc-inset px-2 py-1.5">
        <p className="m-0 font-medium text-nc-text-2">
          订单意图（{intents.length}）
        </p>
        {intents.length === 0 ? (
          <p className="m-0 text-nc-text-4">本次运行没有订单意图。</p>
        ) : (
          <ul className="m-0 list-none space-y-1 p-0">
            {intents.map((intent) => {
              const pending =
                intent.status === "planned" || intent.status === "queued";
              return (
                <li
                  key={intent.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1"
                >
                  <span
                    className="nc-status-chip"
                    data-state={intent.phase === 1 ? "warn" : "ok"}
                  >
                    {intent.phase === 1 ? "阶段1 卖出" : "阶段2 买入"}
                  </span>
                  <strong className="font-medium text-nc-text">
                    {intent.symbol}
                  </strong>
                  <span className="text-nc-text-3">
                    {intent.side} · 数量{" "}
                    {formatNumber(
                      intent.quantity,
                      deployment.market === "crypto" ? 6 : 0,
                    )}{" "}
                    · 参考价 {formatNumber(intent.referencePrice, 2)}
                  </span>
                  <span className="text-nc-text-4">
                    {intentStatusLabels[intent.status] ?? intent.status}
                  </span>
                  {intent.errorSummary && (
                    <span className="text-nc-bad">{intent.errorSummary}</span>
                  )}
                  {pending &&
                    deployment.status === "active" &&
                    deployment.executionMode === "manual_confirm" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={approve.isPending || cancel.isPending}
                        onClick={() => {
                          cancel.reset();
                          approve.mutate({ intentId: intent.id });
                        }}
                      >
                        <CheckCircle size={14} aria-hidden="true" />
                        审批并执行
                      </Button>
                    )}
                  {pending && (
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={cancel.isPending || approve.isPending}
                      onClick={() => {
                        approve.reset();
                        cancel.mutate({ intentId: intent.id });
                      }}
                    >
                      <XCircle size={14} aria-hidden="true" />
                      取消
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {(notice || approve.error || cancel.error) && (
        <p
          role={approve.error || cancel.error ? "alert" : "status"}
          className={cn(
            "m-0",
            approve.error || cancel.error ? "text-nc-bad" : "text-nc-text-3",
          )}
        >
          {approve.error?.message ?? cancel.error?.message ?? notice}
        </p>
      )}
      {data.auditEvents.length > 0 && (
        <details className="rounded-lg border border-nc-border-soft bg-nc-inset px-2 py-1.5">
          <summary className="cursor-pointer font-medium text-nc-text-2">
            成交与审计（最近 {data.auditEvents.length} 条）
          </summary>
          <ul className="m-0 list-none space-y-1 p-0">
            {data.auditEvents.map((event) => (
              <li key={event.id} className="text-nc-text-3">
                {formatTime(event.createdAt)} · {event.eventType}
                {event.intentId && ` · 订单意图 ${event.intentId}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function PipelineConsole() {
  const utils = api.useUtils();
  const [deployOpen, setDeployOpen] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [notice, setNotice] = useState("");
  const config = api.pipelineGlobalConfig.useQuery();
  const deployments = api.deploymentList.useInfiniteQuery(
    { limit: 50 },
    { getNextPageParam: ({ nextCursor }) => nextCursor ?? undefined },
  );
  const refreshDeployments = () =>
    Promise.all([
      utils.deploymentList.invalidate(),
      utils.deploymentPoolList.invalidate(),
      utils.pipelineRunDetail.invalidate(),
    ]);
  const autoSim = api.pipelineSetGlobalAutoSim.useMutation({
    onSuccess: (data) => {
      utils.pipelineGlobalConfig.setData(undefined, (previous) =>
        previous ? { ...previous, autoSimEnabled: data.autoSimEnabled } : data,
      );
      setNotice(`模拟盘自动下单已${data.autoSimEnabled ? "开启" : "关闭"}。`);
      return utils.pipelineGlobalConfig.invalidate();
    },
  });
  const autoLive = api.pipelineSetGlobalAutoLive.useMutation({
    onSuccess: (data) => {
      utils.pipelineGlobalConfig.setData(undefined, (previous) =>
        previous
          ? { ...previous, autoLiveEnabled: data.autoLiveEnabled }
          : data,
      );
      setNotice(`实盘自动下单已${data.autoLiveEnabled ? "开启" : "关闭"}。`);
      setLiveOpen(false);
      setPhrase("");
      return utils.pipelineGlobalConfig.invalidate();
    },
  });
  const autoSimEnabled = config.data?.autoSimEnabled;
  const autoLiveEnabled = config.data?.autoLiveEnabled;
  const items = deployments.data?.pages.flatMap(({ items }) => items) ?? [];

  return (
    <div className="space-y-4">
      <Panel
        title="全局执行总开关"
        icon={Broadcast}
        meta="模拟与实盘分别控制"
        actions={
          <Button type="button" size="sm" onClick={() => setDeployOpen(true)}>
            <Plus size={14} aria-hidden="true" />
            新建部署
          </Button>
        }
        bodyClassName="space-y-2"
      >
        <div className="grid gap-2 lg:grid-cols-2">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2">
            <span className="text-sm font-medium text-nc-text">
              模拟盘自动下单
            </span>
            <span
              className="nc-status-chip"
              data-state={autoSimEnabled ? "ok" : "idle"}
            >
              <i aria-hidden="true" />
              {config.isPending
                ? "读取中"
                : autoSimEnabled === undefined
                  ? "—"
                  : autoSimEnabled
                    ? "已开启"
                    : "已关闭"}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={autoSim.isPending || autoSimEnabled === undefined}
              onClick={() => {
                setNotice("");
                autoSim.mutate({ enabled: !autoSimEnabled });
              }}
            >
              {autoSimEnabled ? "关闭自动模拟" : "开启自动模拟"}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-nc-bad-edge bg-nc-inset px-3 py-2">
            <span className="text-sm font-medium text-nc-bad">
              实盘自动下单
            </span>
            <span
              className="nc-status-chip"
              data-state={autoLiveEnabled ? "bad" : "idle"}
            >
              <i aria-hidden="true" />
              {config.isPending
                ? "读取中"
                : autoLiveEnabled === undefined
                  ? "—"
                  : autoLiveEnabled
                    ? "已开启"
                    : "已关闭"}
            </span>
            {autoLiveEnabled !== false ? (
              <Button
                type="button"
                size="sm"
                variant="danger"
                className="ml-auto"
                disabled={autoLive.isPending}
                onClick={() => {
                  setNotice("");
                  autoLive.mutate({ enabled: false });
                }}
              >
                <StopCircle size={14} aria-hidden="true" />
                一键急停实盘
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="danger"
                className="ml-auto"
                disabled={autoLive.isPending}
                onClick={() => {
                  setPhrase("");
                  autoLive.reset();
                  setLiveOpen(true);
                }}
              >
                开启实盘自动
              </Button>
            )}
          </div>
        </div>
        <p className="m-0 text-[11px] text-nc-text-4">
          模拟盘开关控制自动模拟。实盘开关开启时，点击「一键急停实盘」可阻止新的实盘委托，包括手动确认的实盘单。
        </p>
        {notice && (
          <p role="status" className="m-0 text-[11px] text-nc-text-3">
            {notice}
          </p>
        )}
        {(config.error || autoSim.error || autoLive.error) && (
          <StateBanner
            state="error"
            title="总开关读取或设置失败"
            action={
              config.error
                ? { label: "重新读取", onClick: () => void config.refetch() }
                : undefined
            }
          >
            {config.error?.message ??
              autoSim.error?.message ??
              autoLive.error?.message}
          </StateBanner>
        )}
      </Panel>

      <Panel
        title="已部署策略"
        icon={ListMagnifyingGlass}
        meta={
          deployments.data
            ? `${deployments.hasNextPage ? "已加载 " : ""}${items.length} 个`
            : "—"
        }
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={deployments.isFetching}
            onClick={() => void deployments.refetch()}
          >
            <ArrowsClockwise size={14} aria-hidden="true" />
            刷新
          </Button>
        }
        bodyClassName="space-y-2"
      >
        {deployments.isPending && (
          <StateBanner state="info" title="正在读取策略部署…" hideIcon />
        )}
        {deployments.error && (
          <StateBanner
            state="error"
            title="策略部署读取失败"
            action={{
              label: "重试",
              onClick: () => void deployments.refetch(),
            }}
          >
            {deployments.error.message}
          </StateBanner>
        )}
        {!deployments.isPending && !deployments.error && items.length === 0 && (
          <StateBanner
            state="empty"
            title="尚无策略部署"
            action={{ label: "新建部署", onClick: () => setDeployOpen(true) }}
          >
            部署后，每日选股、监控池、信号、风控与执行会按 5 段链路自动衔接。
          </StateBanner>
        )}
        {items.map((deployment) => (
          <DeploymentCard
            key={deployment.id}
            deployment={deployment}
            onChanged={refreshDeployments}
          />
        ))}
        {deployments.hasNextPage && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={deployments.isFetching}
            onClick={() => void deployments.fetchNextPage()}
          >
            {deployments.isFetchingNextPage ? "正在加载…" : "加载更多"}
          </Button>
        )}
      </Panel>

      <DeployStrategyDialog
        open={deployOpen}
        onOpenChange={setDeployOpen}
        onDeployed={(deploymentId) => {
          setNotice(`已创建策略部署 ${deploymentId}。`);
        }}
      />

      <Dialog
        open={liveOpen}
        onOpenChange={(next) => {
          if (!autoLive.isPending) setLiveOpen(next);
        }}
      >
        <DialogContent
          showCloseButton={!autoLive.isPending}
          className="lg:max-w-lg"
        >
          <DialogHeader>
            <DialogTitle>开启实盘自动下单</DialogTitle>
            <DialogDescription>
              开启后，自动实盘部署可在满足执行条件时发送真实委托，手动确认模式也可提交经审批的实盘单。请输入确认短语以继续。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="flex flex-col gap-1 text-sub text-nc-text-3">
              <span>
                确认短语：<code>{liveConfirmationPhrase}</code>
              </span>
              <Input
                aria-label="实盘确认短语"
                autoComplete="off"
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
                placeholder={liveConfirmationPhrase}
              />
            </label>
            {autoLive.error && (
              <p role="alert" className="m-0 text-[11px] text-nc-bad">
                {autoLive.error.message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={autoLive.isPending}
              onClick={() => setLiveOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={phrase !== liveConfirmationPhrase || autoLive.isPending}
              onClick={() => {
                setNotice("");
                autoLive.mutate({
                  enabled: true,
                  confirmationPhrase: phrase,
                });
              }}
            >
              {autoLive.isPending ? "正在开启…" : "确认开启实盘自动"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
