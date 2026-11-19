"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  formatNumber,
  formatPercent,
} from "trading-strategy-core/format-number";
import { labActionLabels } from "~/lib/research/strategy-lab";
import { DataTable } from "../ui/data-table";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import {
  FilterDivider,
  FilterGroup,
  FilterToolbar,
  MethodologyPopover,
  Pill,
  Segmented,
  type MethodologyItem,
} from "../panels";
import { StrategyCenter } from "./strategy-center";
import { PortfolioEvidencePanel } from "./portfolio-evidence-panel";
import { PaperForwardStatus } from "../portfolio/paper-forward-status";
import { usePanelVisible } from "../workbench/keep-alive";
import { PaperShadowPrompt } from "./paper-shadow-prompt";
import { useScreenVisible } from "../workbench/use-task-visible";
import { labPauseSuggestion } from "./lab-review";
import { alertModeLabel } from "~/lib/common/ui-glossary";
import {
  CheckCircle,
  CircleDashed,
  CircleNotch,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react/ssr";

const pct = (v: number | null | undefined) =>
  formatPercent(v == null ? null : v * 100);
type LabListFilter = {
  market: "cn-equity" | "crypto";
  query: string;
  page: number;
};
const defaultLabListFilter: LabListFilter = {
  market: "cn-equity",
  query: "",
  page: 0,
};
/** 生命周期、成绩口径与正式提醒边界，收进标题旁的口径说明。 */
const labMethodology: readonly MethodologyItem[] = [
  {
    label: "生命周期",
    detail:
      "研究中 → 观察前推 → 模拟前推 → 手动晋级。六个阶段依次进行；测试通过与工程检查不代表策略盈利。",
  },
  {
    label: "成绩单口径",
    detail:
      "留出收益、最大回撤、成交数与 walk-forward 达标窗口取自冻结回测；市场 DSR 用于同口径诊断，全局 DSR 只作参考。",
  },
  {
    label: "留出窗口",
    detail:
      "留出诊断与滚动样本外重叠，不是独立的未来样本；缺证据时保持空值，不补造数值。",
  },
  {
    label: "正式提醒",
    detail:
      "正式提醒独立于晋级阶段，需人工确认开启；仍受全局提醒模式、启用订阅与渠道约束，不会自动下单。",
  },
];
export function StrategyLab() {
  const search = useSearchParams(),
    id = search.get("strategy");
  const [filter, setFilter] = useState<LabListFilter>(defaultLabListFilter);
  if (id)
    return (
      <LabDetail
        key={`${id}:${search.get("version")}`}
        id={id}
        version={Number(search.get("version") ?? 1)}
      />
    );
  if (search.get("tab") === "catalog") return <StrategyCenter />;
  if (search.get("tab") === "tasks") return <ResearchTasks />;
  return (
    <>
      <LabList
        filter={filter}
        onMarketChange={(market) =>
          setFilter((f) => ({ ...f, market, page: 0 }))
        }
        onQueryChange={(query) => setFilter((f) => ({ ...f, query, page: 0 }))}
        onPageChange={(page) => setFilter((f) => ({ ...f, page }))}
      />
      <LabGovernance />
    </>
  );
}
/** 前推状态保留精简横条；纸面候选、组合证据与提醒模式收进可折叠区。 */
function LabGovernance() {
  return (
    <div className="space-y-3">
      <PaperForwardStatus compact />
      <details className="rounded-lg border border-nc-border-soft bg-nc-card">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-nc-text-2">
          纸面候选、组合证据与全局提醒模式
        </summary>
        <div className="space-y-3 border-t border-nc-border-soft p-3">
          <PaperShadowPrompt />
          <PortfolioEvidencePanel />
          <AlertModeControl />
        </div>
      </details>
    </div>
  );
}
function LabStatusCell({
  status,
  unvalidatedLive,
  sleeve,
}: {
  status: string;
  unvalidatedLive: boolean;
  sleeve: string;
}) {
  const label = unvalidatedLive
    ? "未验证提醒已开"
    : status === "promoted"
      ? "已晋级"
      : status === "shadow"
        ? "观察前推中"
        : "研究中";
  const tone = unvalidatedLive
    ? "warn"
    : status === "promoted"
      ? "ok"
      : status === "shadow"
        ? "accent"
        : "neutral";
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Pill tone={tone}>{label}</Pill>
      <Pill>{sleeve}</Pill>
    </span>
  );
}
function LabList({
  filter,
  onMarketChange,
  onQueryChange,
  onPageChange,
}: {
  filter: LabListFilter;
  onMarketChange: (market: LabListFilter["market"]) => void;
  onQueryChange: (query: string) => void;
  onPageChange: (page: number) => void;
}) {
  const { market, query, page } = filter;
  const visible = usePanelVisible();
  const list = api.strategyLab.useQuery(
    { market, query, page },
    { enabled: visible },
  );
  return (
    <section aria-label="实验室策略列表" className="mb-4 space-y-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold">策略实验室</h1>
        <div className="ml-auto">
          <MethodologyPopover title="策略实验室口径" items={labMethodology} />
        </div>
      </header>
      <FilterToolbar label="策略库筛选">
        <FilterGroup label="市场">
          <Segmented
            label="实验室市场"
            value={market}
            options={[
              { value: "cn-equity", label: "A股中证800" },
              { value: "crypto", label: "BTC / ETH" },
            ]}
            onChange={onMarketChange}
          />
        </FilterGroup>
        <FilterDivider />
        <Input
          aria-label="搜索实验室策略"
          className="w-60"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="名称、规则或分仓"
        />
        <div className="ml-auto flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/lab/backtest">新建组合回测 →</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/lab?tab=catalog">策略对比 →</Link>
          </Button>
        </div>
      </FilterToolbar>
      <DataTable
        label="实验室策略"
        data={list.data?.items ?? []}
        rowCount={list.data?.total ?? 0}
        loading={list.isLoading}
        error={list.error?.message}
        onRetry={() => void list.refetch()}
        pagination={{ pageIndex: page, pageSize: 20 }}
        sorting={[]}
        onSortingChange={() => {}}
        onPaginationChange={(u) =>
          onPageChange(
            (typeof u === "function" ? u({ pageIndex: page, pageSize: 20 }) : u)
              .pageIndex,
          )
        }
        getRowId={(r) => `${r.id}:${r.version}`}
        columns={[
          {
            id: "strategy",
            header: "策略",
            cell: ({ row: { original: r } }) => (
              <Link
                href={`/lab?strategy=${encodeURIComponent(r.id)}&version=${r.version}`}
                className="underline"
              >
                {r.rule} · {r.id} v{r.version}
              </Link>
            ),
          },
          {
            id: "status",
            header: "状态 / 分仓",
            cell: ({ row: { original: r } }) => (
              <LabStatusCell
                status={r.status}
                unvalidatedLive={r.unvalidatedLive}
                sleeve={r.sleeve}
              />
            ),
          },
          {
            id: "return",
            header: () => (
              <span className="block text-right">留出收益 / 回撤</span>
            ),
            cell: ({ row: { original: r } }) => (
              <span className="block text-right tabular-nums">
                {`${pct(r.row?.return)} / ${pct(r.row?.drawdown)}`}
              </span>
            ),
          },
          {
            id: "forward",
            header: "前推一致性",
            cell: ({ row: { original: r } }) =>
              r.forwardVerdict === "conforming"
                ? "一致"
                : r.forwardVerdict === "degraded"
                  ? "衰减"
                  : "证据不足",
          },
          {
            id: "oos",
            header: () => (
              <span className="block text-right">达标窗口 / 成交</span>
            ),
            cell: ({ row: { original: r } }) => (
              <span className="block text-right tabular-nums">
                {r.row
                  ? `${r.row.positiveWindows}/${r.row.oosWindows} · ${r.row.trades}`
                  : "尚无验证"}
              </span>
            ),
          },
          {
            id: "dsr",
            header: () => <span className="block text-right">市场DSR</span>,
            cell: ({ row }) => (
              <span className="block text-right tabular-nums">
                {formatNumber(row.original.row?.dsr?.value, 3)}
              </span>
            ),
          },
        ]}
        emptyMessage="尚未登记策略。可查看方法目录，或从扫描/研究登记策略对象。"
      />
    </section>
  );
}
function RuleFields({
  value,
  prefix = "",
}: {
  value: unknown;
  prefix?: string;
}) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object")
    return (
      <>
        {Object.entries(value).map(([k, v]) => (
          <RuleFields
            key={k}
            value={v}
            prefix={prefix ? `${prefix}.${k}` : k}
          />
        ))}
      </>
    );
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 border-b border-nc-border-soft py-1 text-sm">
      <dt className="min-w-0 truncate text-nc-text-3" title={prefix}>
        {prefix}
      </dt>
      <dd className="min-w-0 break-all text-right tabular-nums text-nc-text-2">
        {typeof value === "number"
          ? formatNumber(value, Number.isInteger(value) ? 0 : 4)
          : String(value)}
      </dd>
    </div>
  );
}
function LabDetailBackLink() {
  return (
    <Link href="/lab" scroll={false} className="underline">
      返回策略列表
    </Link>
  );
}
function LabDetail({ id, version }: { id: string; version: number }) {
  const visible = useScreenVisible();
  const query = api.strategyLabDetail.useQuery(
    { id, version },
    { enabled: visible },
  );
  const d = query.data;
  const week = new Date();
  week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
  const review = api.accountWeeklyReview.useQuery(
    week.toISOString().slice(0, 10),
    { enabled: visible && !!d?.strategy && d.live, retry: false },
  );
  const pauseSuggestion = d
    ? labPauseSuggestion(
        review.data?.suggestions ?? [],
        id,
        version,
        d.revision,
      )
    : null;
  const [action, setAction] = useState<keyof typeof labActionLabels | null>(
    null,
  );
  const [riskAccepted, setRiskAccepted] = useState(false);
  const change = api.strategyLabAction.useMutation({
    onSuccess: () => {
      setAction(null);
      void query.refetch();
      void review.refetch();
    },
  });
  const report = api.strategyLabReport.useQuery(
    { hash: d?.resultHash ?? "", id },
    {
      enabled:
        visible && !!d?.resultHash && /^[a-f0-9]{64}$/.test(d.resultHash),
      retry: false,
    },
  );
  if (query.error)
    return (
      <>
        <LabDetailBackLink />
        <p role="alert">
          {query.error.message}
          <Button onClick={() => void query.refetch()}>重试</Button>
        </p>
      </>
    );
  if (!d)
    return (
      <>
        <LabDetailBackLink />
        <p role="status">正在读取策略详情…</p>
      </>
    );
  const stateLabel =
    d.eligible && d.promotion
      ? "已晋级"
      : d.shadow?.active
        ? "观察前推中"
        : "研究中";
  const stateTone =
    d.eligible && d.promotion ? "ok" : d.shadow?.active ? "accent" : "neutral";
  return (
    <section aria-label="实验室策略详情" className="space-y-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <LabDetailBackLink />
        <h1 className="text-xl font-semibold">
          {d.row?.rule ?? id} · v{version}
        </h1>
        <Pill tone={stateTone}>{stateLabel}</Pill>
        <Pill tone={d.live ? "accent" : "neutral"}>
          正式提醒：{d.live ? "已开启" : "未开启"}
        </Pill>
        <div className="ml-auto">
          <MethodologyPopover title="策略详情口径" items={labMethodology} />
        </div>
      </header>
      <LifecyclePipeline
        detail={d}
        onLiveAction={() => {
          change.reset();
          setAction("live");
          setRiskAccepted(false);
        }}
      />
      {d.row && <LabMetrics row={d.row} />}
      <div className="nc-cockpit-grid">
        <div className="min-w-0 space-y-3">
          <section
            aria-label="验证报告与留出窗口"
            className="space-y-2 rounded-lg border border-nc-border-soft bg-nc-card p-3"
          >
            <h2 className="text-sm font-semibold">验证报告与留出窗口</h2>
            {report.error && (
              <p role="status" className="text-sub text-nc-text-2">
                详细冻结报告不可读取：{report.error.message}
                。保留已有成绩单和前推证据，不补造明细。
              </p>
            )}
            {report.data ? (
              <ValidationWindows report={report.data} />
            ) : (
              <p className="text-sub text-nc-text-3">
                walk-forward、成本×2、延后一根、留出细项
                {report.isFetching ? "读取中" : "未提供"}
                。纸面账户中已冻结的期望另列于账户详情。
              </p>
            )}
            {d.row && (
              <>
                <p className="border-t border-nc-border-soft pt-2 text-sub text-nc-text-3">
                  {Object.values(d.row.bias).join("；")}
                </p>
                {d.row.biasTags?.map((b) => (
                  <p key={b.code} className="text-sub text-nc-text-2">
                    {b.severity === "high" ? "高" : "中"}偏差：{b.detail}
                  </p>
                ))}
              </>
            )}
          </section>
          <section
            aria-label="观察前推与模拟盘前推"
            className="space-y-2 rounded-lg border border-nc-border-soft bg-nc-card p-3"
          >
            <h2 className="text-sm font-semibold">观察前推与模拟盘前推</h2>
            <p className="text-sm">
              观察样本 {d.forward?.signals ?? 0} 信号 / {d.forward?.days ?? 0}{" "}
              实际观察市场日；
              {d.forward?.assessment?.recommendation ??
                "缺少同版本冻结分布或前推样本；继续观察"}
            </p>
            <p className="text-sub text-nc-text-3">
              模拟盘撮合一致性按模型滑点估算；真实执行尚未验证。
            </p>
            {review.error && (
              <p role="status" className="text-sub">
                二十日选择归因与复盘建议暂不可读：{review.error.message}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void review.refetch()}
                >
                  重试复盘建议
                </Button>
              </p>
            )}
            {pauseSuggestion && d.live && (
              <section
                aria-label="策略暂停建议"
                className="space-y-2 rounded-lg border border-nc-warn-edge bg-nc-inset p-2.5"
              >
                <p className="text-sm">{pauseSuggestion.suggestion.reason}</p>
                <p className="text-sub text-nc-text-3">
                  同策略同版本的账户复盘建议；仅供人工核对，暂停后保留观察时钟与历史证据。
                </p>
                {pauseSuggestion.current ? (
                  <Button
                    size="sm"
                    disabled={change.isPending}
                    onClick={() => {
                      change.reset();
                      setAction("pause-live");
                      setRiskAccepted(false);
                    }}
                  >
                    按复盘建议暂停 live 提醒
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void query.refetch();
                      void review.refetch();
                    }}
                  >
                    证据版本已更新，刷新复盘建议
                  </Button>
                )}
              </section>
            )}
            {d.accounts.length > 0 && (
              <ul className="space-y-0.5 text-sub text-nc-text-3">
                {d.accounts.map((a) => (
                  <li key={a.id}>
                    {a.id}：{a.summary?.signals ?? 0} 信号 /{" "}
                    {a.summary?.days ?? 0} 日 · {a.lastBar ?? "尚未推进"}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <aside className="min-w-0 space-y-3">
          <section
            aria-label="当前阻断与人工审批"
            className="space-y-2 rounded-lg border border-nc-border-soft bg-nc-card p-3"
          >
            <h2 className="text-sm font-semibold">当前阻断与人工审批</h2>
            <GateStatus detail={d} />
            <div className="flex flex-wrap gap-2">
              {(
                Object.keys(labActionLabels) as (keyof typeof labActionLabels)[]
              ).map((a) => (
                <Button
                  key={a}
                  size="sm"
                  variant={a === "live" ? "default" : "outline"}
                  disabled={
                    !d.strategy ||
                    change.isPending ||
                    (a === "promote" && !d.eligible)
                  }
                  onClick={() => {
                    change.reset();
                    setAction(a);
                    setRiskAccepted(false);
                  }}
                >
                  {labActionLabels[a]}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-nc-border-soft pt-2 text-sub">
              <Link
                href={`/lab/backtest?strategy=${encodeURIComponent(id)}&version=${version}`}
                className="underline"
              >
                用此策略对象回测
              </Link>
              <Link href="/accounts?tab=paper" className="underline">
                模拟盘对照
              </Link>
              <Link
                href={`/accounts/alerts?strategy=${encodeURIComponent(id)}`}
                className="underline"
              >
                提醒记录
              </Link>
            </div>
          </section>
          <section
            aria-label="策略规则与参数"
            className="space-y-2 rounded-lg border border-nc-border-soft bg-nc-card p-3"
          >
            <h2 className="text-sm font-semibold">策略规则与参数</h2>
            {d.strategy ? (
              <dl className="grid gap-x-4 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
                <RuleFields value={d.strategy} />
              </dl>
            ) : (
              <p className="text-sm text-nc-text-3">
                缺少对应版本的策略对象；历史成绩保留，只可阅读，不能开启观察或提醒。
              </p>
            )}
          </section>
        </aside>
      </div>
      <Dialog
        open={!!action}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
      >
        <DialogContent>
          <DialogTitle>
            确认{action ? labActionLabels[action] : "策略操作"}
          </DialogTitle>
          <DialogDescription>
            {id} · v{version}；请核对当前门槛及前推样本后确认。
          </DialogDescription>
          <GateStatus detail={d} />
          {action === "live" && (!d.eligible || !d.promotion) && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                aria-label="接受未验证策略提醒风险"
                checked={riskAccepted}
                onCheckedChange={(checked) => setRiskAccepted(checked === true)}
              />
              我理解该策略尚未满足回测与前推晋级条件，仍选择手动开启未验证策略提醒；真实执行未验证。
            </label>
          )}
          <p>
            观察前推 {d.forward?.signals ?? 0} 信号 / {d.forward?.days ?? 0}{" "}
            日。策略的正式提醒仍受全局模式、启用订阅和渠道约束，不产生真实委托。
          </p>
          <Button
            disabled={
              change.isPending ||
              (action === "live" &&
                (!d.eligible || !d.promotion) &&
                !riskAccepted)
            }
            onClick={() => {
              if (action)
                change.mutate({
                  id,
                  version,
                  action,
                  confirmed: true,
                  revision: d.revision,
                  ...(action === "live" && riskAccepted
                    ? { riskAccepted: true as const }
                    : {}),
                });
            }}
          >
            确认执行
          </Button>
          {change.error && <p role="alert">{change.error.message}</p>}
        </DialogContent>
      </Dialog>
    </section>
  );
}
/** Straight Chinese names for the six server lifecycle gates. */
const lifecycleStageNames: Record<string, string> = {
  definition: "定义冻结",
  backtest: "回测证据",
  comparison: "同口径对比",
  paper: "模拟前推",
  shadow: "观察前推",
  promotion: "晋级观察",
};
const lifecycleStatus = {
  passed: { label: "已完成", icon: CheckCircle, tone: "text-nc-ok" },
  current: { label: "进行中", icon: CircleNotch, tone: "text-nc-accent" },
  blocked: { label: "已阻断", icon: Warning, tone: "text-nc-warn" },
  pending: { label: "未开始", icon: CircleDashed, tone: "text-nc-text-4" },
} as const;

function LifecyclePipeline({
  detail,
  onLiveAction,
}: {
  detail: RouterOutputs["strategyLabDetail"];
  onLiveAction: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const blocker = detail.primaryBlocker;
  const openGate = detail.lifecycleGates.find((gate) => gate.key === expanded);
  return (
    <section
      aria-label="晋级流水线"
      className="space-y-2 rounded-lg border border-nc-border-soft bg-nc-card p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <h2 className="text-sm font-semibold">六阶段晋级流水线</h2>
        <div
          aria-label="当前主阻断原因"
          className={`flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md border bg-nc-inset px-2 py-1 text-sub ${
            blocker
              ? "border-nc-warn-edge text-nc-warn"
              : "border-nc-ok-edge text-nc-ok"
          }`}
        >
          {blocker ? (
            <>
              <Warning size={14} aria-hidden="true" className="flex-none" />
              <span className="font-semibold">
                卡在第 {blocker.stage} 阶段 ·{" "}
                {lifecycleStageNames[blocker.key] ?? blocker.key}
              </span>
              <span className="text-nc-text-2">{blocker.reason}</span>
            </>
          ) : (
            <>
              <CheckCircle size={14} aria-hidden="true" className="flex-none" />
              <span className="font-semibold">已满足晋级门槛</span>
              <span className="text-nc-text-3">
                六个阶段均通过；仍需人工确认晋级与正式提醒开关。
              </span>
            </>
          )}
        </div>
      </div>
      <ol className="grid gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
        {detail.lifecycleGates.map((gate, index) => {
          const stageName = lifecycleStageNames[gate.key] ?? gate.label;
          const status = lifecycleStatus[gate.status];
          const Icon = status.icon;
          const open = expanded === gate.key;
          return (
            <li key={gate.key}>
              <Button
                variant="plain"
                type="button"
                aria-expanded={open}
                onClick={() => setExpanded(open ? null : gate.key)}
                className={`flex w-full flex-col items-start gap-0.5 whitespace-normal rounded-md border px-2 py-1.5 text-left transition-colors ${
                  open
                    ? "border-nc-accent bg-nc-accent-900"
                    : "border-nc-border-soft hover:border-nc-accent-800"
                }`}
              >
                <span className="flex w-full items-center gap-1.5">
                  <Icon
                    size={14}
                    aria-hidden="true"
                    className={`flex-none ${status.tone} ${
                      gate.status === "current"
                        ? "motion-reduce:animate-none animate-spin"
                        : ""
                    }`}
                  />
                  <span className="text-[11px] text-nc-text-4">
                    第 {index + 1} 阶段
                  </span>
                  <span className={`ml-auto text-[11px] ${status.tone}`}>
                    {status.label}
                  </span>
                </span>
                <strong className="text-sm font-semibold text-nc-text">
                  {stageName}
                </strong>
                <span
                  className="w-full truncate text-[11px] text-nc-text-4"
                  title={gate.summary}
                >
                  {gate.summary}
                </span>
              </Button>
            </li>
          );
        })}
      </ol>
      {openGate && (
        <div
          aria-label={`${lifecycleStageNames[openGate.key] ?? openGate.label}证据`}
          className="rounded-md border border-nc-border-soft p-2.5"
        >
          <p className="text-sub font-medium text-nc-text">
            {lifecycleStageNames[openGate.key] ?? openGate.label} · 证据明细
          </p>
          <p className="mt-1 text-sub text-nc-text-3">{openGate.summary}</p>
          {openGate.evidence.length ? (
            <ul className="mt-1.5 space-y-1">
              {openGate.evidence.map((item) => (
                <li key={item} className="break-all font-mono text-sub">
                  {item}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-sub text-nc-text-4">
              尚未留下该阶段证据；补齐后重新读取本页即可核对。
            </p>
          )}
        </div>
      )}
      <div
        aria-label="正式提醒开关"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-nc-border-soft pt-2 text-sub"
      >
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck
            size={14}
            aria-hidden="true"
            className="flex-none text-nc-accent"
          />
          正式提醒（人工授权）：
          <b
            className={
              detail.liveSwitch.enabled
                ? "font-semibold text-nc-ok"
                : "font-semibold text-nc-text-2"
            }
          >
            {detail.liveSwitch.enabled ? "已开启" : "未开启"}
          </b>
        </span>
        <span className="text-nc-text-3">
          {detail.liveSwitch.enabled
            ? "仍受全局提醒模式、启用订阅和渠道约束。"
            : "不会自动推送。"}
        </span>
        <span className="text-nc-warn">晋级通过不等于自动推送。</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={!detail.strategy}
          onClick={onLiveAction}
        >
          {detail.liveSwitch.enabled ? "人工核对提醒开关" : "人工开启正式提醒"}
        </Button>
      </div>
    </section>
  );
}

/** 一行六格核心指标；缺失保持「—」，数值列等宽。 */
function LabMetrics({
  row,
}: {
  row: NonNullable<RouterOutputs["strategyLabDetail"]["row"]>;
}) {
  const tone =
    row.return == null
      ? "text-nc-text"
      : row.return > 0
        ? "text-nc-up"
        : row.return < 0
          ? "text-nc-down"
          : "text-nc-text";
  const items = [
    { label: "留出收益", value: pct(row.return), tone },
    { label: "最大回撤", value: pct(row.drawdown), tone: "text-nc-text" },
    { label: "成交数", value: String(row.trades) },
    {
      label: "达标窗口",
      value: `${row.positiveWindows}/${row.oosWindows}`,
    },
    { label: "市场DSR", value: formatNumber(row.dsr?.value, 3) },
    {
      label: "全局DSR",
      value: `${formatNumber(row.globalDsr?.value, 3)}（诊断）`,
    },
  ];
  return (
    <section
      aria-label="核心指标"
      className="grid gap-1.5 [grid-template-columns:repeat(auto-fit,minmax(132px,1fr))]"
    >
      {items.map((item) => (
        <div
          key={item.label}
          className="min-w-0 rounded-md border border-nc-border-soft bg-nc-card px-2.5 py-1.5"
        >
          <p className="text-[11px] text-nc-text-3">{item.label}</p>
          <p
            className={`mt-0.5 truncate text-base font-semibold tabular-nums ${item.tone ?? "text-nc-text"}`}
            title={item.value}
          >
            {item.value}
          </p>
        </div>
      ))}
    </section>
  );
}

function GateStatus({
  detail: d,
}: {
  detail: RouterOutputs["strategyLabDetail"];
}) {
  return (
    <div aria-label="当前策略门槛" className="space-y-1">
      <p>{d.eligible ? "当前门槛通过，可手动晋级" : "当前门槛未通过"}</p>
      {d.reasons.map((r) => (
        <p key={r} className="text-sm text-nc-text-3">
          {r}
        </p>
      ))}
    </div>
  );
}
function ValidationWindows({
  report,
}: {
  report: NonNullable<RouterOutputs["strategyLabReport"]>;
}) {
  return (
    <div className="space-y-2">
      {[
        ...report.windows.map((w, i) => ({
          ...w,
          label: `Walk-forward ${i + 1}`,
        })),
        { ...report.holdout, label: "留出诊断（与滚动样本外重叠）" },
      ].map((w) => (
        <details key={w.label}>
          <summary>
            {w.label} · {w.start} 至 {w.end}
          </summary>
          {(["base", "doubledCost", "delayed"] as const).map((k) => (
            <p key={k}>
              {
                { base: "原成本", doubledCost: "成本×2", delayed: "延后一根" }[
                  k
                ]
              }
              ：收益 {pct(w[k].return)} · 超额 {pct(w[k].excess)} · 回撤{" "}
              {pct(w[k].drawdown)} · 成交 {w[k].trades}
            </p>
          ))}
        </details>
      ))}
    </div>
  );
}
function AlertModeControl() {
  const status = api.alertStatus.useQuery(),
    [confirm, setConfirm] = useState<"off" | "shadow" | "live" | null>(null);
  const setMode = api.strategyLabMode.useMutation({
    onSuccess: () => {
      setConfirm(null);
      void status.refetch();
    },
  });
  return (
    <section aria-label="全局提醒模式" className="space-y-2 rounded border p-3">
      <h2>
        全局提醒模式：
        {status.data ? alertModeLabel(status.data.mode) : "读取中"}
      </h2>
      <p className="text-sm">
        开启正式提醒前，须先在策略详情核对门槛与前推样本、手动晋级并开启该策略。订阅与渠道在系统配置。
      </p>
      <div className="flex flex-wrap gap-2">
        {(["off", "shadow", "live"] as const).map((mode) => (
          <Button
            key={mode}
            variant="outline"
            onClick={() => {
              setMode.reset();
              setConfirm(mode);
            }}
            disabled={!status.data || setMode.isPending}
          >
            {mode === "live"
              ? "开启全局正式提醒"
              : mode === "shadow"
                ? "切换全局观察模式"
                : "关闭全局提醒"}
          </Button>
        ))}
      </div>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogTitle>确认切换全局提醒模式</DialogTitle>
          <DialogDescription>
            目标 {confirm}。仅向已启用订阅投递；不会自动订阅或下单。
          </DialogDescription>
          <Button
            onClick={() => {
              if (confirm) setMode.mutate({ mode: confirm, confirmed: true });
            }}
            disabled={setMode.isPending}
          >
            确认模式
          </Button>
          {setMode.error && <p role="alert">{setMode.error.message}</p>}
        </DialogContent>
      </Dialog>
      {status.error && <p role="alert">{status.error.message}</p>}
    </section>
  );
}
function ResearchTasks() {
  const [market, setMarket] = useState<"cn-equity" | "crypto">("cn-equity"),
    [hash, setHash] = useState("");
  const task = api.researchCommand.useMutation();
  return (
    <section className="space-y-4" aria-label="研究任务">
      <h1 className="text-xl font-semibold">研究任务</h1>
      <p>
        与研究 CLI
        共用服务入口。界面只启动读取已有成绩单和校验冻结输入的任务；采集、规模化研究及发布继续由显式隔离的
        CLI 完成。
      </p>
      <Segmented
        label="任务市场"
        value={market}
        onChange={setMarket}
        options={[
          { value: "cn-equity", label: "A股" },
          { value: "crypto", label: "BTC / ETH" },
        ]}
      />
      <Button
        disabled={task.isPending}
        onClick={() => task.mutate({ command: "inspect", market })}
      >
        检查已有成绩单
      </Button>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          task.mutate({ command: "verify-input", hash });
        }}
      >
        <Input
          aria-label="冻结输入摘要"
          placeholder="64位 SHA256"
          value={hash}
          onChange={(e) => setHash(e.target.value)}
          required
          pattern="[a-f0-9]{64}"
          className="max-w-lg"
        />
        <Button disabled={task.isPending}>校验冻结输入与版本</Button>
      </form>
      {task.error && <p role="alert">{task.error.message}</p>}
      {task.data && (
        <p role="status">
          研究任务已创建。
          <Link
            className="underline"
            href={`/system/tasks?id=${encodeURIComponent(task.data.id)}`}
          >
            查看结果与取消
          </Link>
        </p>
      )}
    </section>
  );
}
