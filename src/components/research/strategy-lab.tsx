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
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { Segmented } from "../panels";
import { StrategyCenter } from "./strategy-center";
import { PaperForwardStatus } from "../portfolio/paper-forward-status";
import { usePanelVisible } from "../workbench/keep-alive";
import { PaperShadowPrompt } from "./paper-shadow-prompt";

const pct = (v: number | null | undefined) =>
  formatPercent(v == null ? null : v * 100);
export function StrategyLab() {
  const search = useSearchParams(),
    id = search.get("strategy");
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
      <PaperShadowPrompt />
      <LabList />
      <PaperForwardStatus />
    </>
  );
}
function LabList() {
  const [market, setMarket] = useState<"cn-equity" | "crypto">("cn-equity"),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(0);
  const visible = usePanelVisible();
  const list = api.strategyLab.useQuery(
    { market, query, page },
    { enabled: visible },
  );
  return (
    <section aria-label="实验室策略列表" className="mb-4 space-y-4">
      <h1 className="text-xl font-semibold">策略实验室</h1>
      <p className="text-sm text-nc-text-3">
        研究中 → 影子前推 → 手动晋级 →
        手动开启提醒。成绩单、前推与真实成交各有证据，测试通过不表示策略盈利。
      </p>
      <Segmented
        label="实验室市场"
        value={market}
        options={[
          { value: "cn-equity", label: "A股中证800" },
          { value: "crypto", label: "BTC / ETH" },
        ]}
        onChange={(m) => {
          setMarket(m);
          setPage(0);
        }}
      />
      <Input
        aria-label="搜索实验室策略"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPage(0);
        }}
        placeholder="名称、规则或分仓"
      />
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
          setPage(
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
            cell: ({ row: { original: r } }) =>
              `${r.unvalidatedLive ? "未验证提醒已开" : r.status === "promoted" ? "已晋级" : r.status === "shadow" ? "影子前推中" : "研究中"} · ${r.sleeve}`,
          },
          {
            id: "return",
            header: "留出收益 / 回撤",
            cell: ({ row: { original: r } }) =>
              `${pct(r.row?.return)} / ${pct(r.row?.drawdown)}`,
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
            header: "达标窗口 / 成交",
            cell: ({ row: { original: r } }) =>
              r.row
                ? `${r.row.positiveWindows}/${r.row.oosWindows} · ${r.row.trades}`
                : "尚无验证",
          },
          {
            id: "dsr",
            header: "市场DSR",
            cell: ({ row }) => formatNumber(row.original.row?.dsr?.value, 3),
          },
        ]}
        emptyMessage="尚未登记策略。可查看方法目录，或从扫描/研究登记策略对象。"
      />
      <Link href="/lab?tab=catalog" className="underline">
        全部方法目录、现行日线研究与运行比较
      </Link>
      <AlertModeControl />
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
    <div className="flex flex-wrap gap-3 text-sm">
      <dt className="text-nc-text-3">{prefix}</dt>
      <dd>
        {typeof value === "number"
          ? formatNumber(value, Number.isInteger(value) ? 0 : 4)
          : String(value)}
      </dd>
    </div>
  );
}
function LabDetail({ id, version }: { id: string; version: number }) {
  const query = api.strategyLabDetail.useQuery({ id, version });
  const d = query.data;
  const [action, setAction] = useState<keyof typeof labActionLabels | null>(
    null,
  );
  const [riskAccepted, setRiskAccepted] = useState(false);
  const change = api.strategyLabAction.useMutation({
    onSuccess: () => {
      setAction(null);
      void query.refetch();
    },
  });
  const report = api.strategyLabReport.useQuery(
    { hash: d?.resultHash ?? "", id },
    {
      enabled: !!d?.resultHash && /^[a-f0-9]{64}$/.test(d.resultHash),
      retry: false,
    },
  );
  if (query.error)
    return (
      <p role="alert">
        {query.error.message}
        <Button onClick={() => void query.refetch()}>重试</Button>
      </p>
    );
  if (!d) return <p role="status">正在读取策略详情…</p>;
  return (
    <section aria-label="实验室策略详情" className="space-y-4">
      <Link href="/lab" className="underline">
        返回策略列表
      </Link>
      <h1 className="text-xl font-semibold">
        {d.row?.rule ?? id} · v{version}
      </h1>
      <p>
        {d.promotion ? "已晋级" : d.shadow?.active ? "影子前推中" : "研究中"} ·{" "}
        {d.live ? "策略live已开启" : "策略提醒未开启"}
      </p>
      {d.strategy ? (
        <details open>
          <summary>规则与参数</summary>
          <dl className="space-y-1">
            <RuleFields value={d.strategy} />
          </dl>
        </details>
      ) : (
        <p>
          缺少对应版本的策略对象；历史成绩保留，只可阅读，不能开启观察或提醒。
        </p>
      )}
      <h2 className="text-lg font-semibold">验证报告与门槛</h2>
      <GateStatus detail={d} />
      {d.row && (
        <>
          <p>
            留出收益 {pct(d.row.return)} · 最大回撤 {pct(d.row.drawdown)} · 成交{" "}
            {d.row.trades} · walk-forward 达标 {d.row.positiveWindows}/
            {d.row.oosWindows}
          </p>
          <p>
            市场DSR {formatNumber(d.row.dsr?.value, 3)} · 全局DSR{" "}
            {formatNumber(d.row.globalDsr?.value, 3)}（诊断）
          </p>
          <p className="text-sm">{Object.values(d.row.bias).join("；")}</p>
          {d.row.biasTags?.map((b) => (
            <p key={b.code} className="text-sm">
              {b.severity === "high" ? "高" : "中"}偏差：{b.detail}
            </p>
          ))}
        </>
      )}
      {report.error && (
        <p role="status">
          详细冻结报告不可读取：{report.error.message}
          。保留已有成绩单和前推证据，不补造明细。
        </p>
      )}
      {report.data ? (
        <ValidationWindows report={report.data} />
      ) : (
        <p className="text-sm">
          walk-forward、成本×2、延后一根、留出细项
          {report.isFetching ? "读取中" : "未提供"}
          。纸面账户中已冻结的期望另列于账户详情。
        </p>
      )}
      <h2 className="text-lg font-semibold">影子与纸面前推</h2>
      <p>
        影子样本 {d.forward?.signals ?? 0} 信号 / {d.forward?.days ?? 0}{" "}
        实际观察市场日；
        {d.forward?.assessment?.recommendation ??
          "缺少同版本冻结分布或前推样本；继续观察"}
      </p>
      <p className="text-sm text-nc-text-3">
        纸面撮合一致性使用模型滑点；真实执行尚未验证。
      </p>
      {d.accounts.map((a) => (
        <p key={a.id}>
          {a.id}：{a.summary?.signals ?? 0} 信号 / {a.summary?.days ?? 0} 日 ·{" "}
          {a.lastBar ?? "尚未推进"}
        </p>
      ))}
      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/accounts?tab=paper" className="underline">
          纸面账户与期望对照
        </Link>
        <Link
          href={`/accounts/alerts?strategy=${encodeURIComponent(id)}`}
          className="underline"
        >
          该策略提醒记录
        </Link>
        <Link
          href={`/lab/backtest?strategy=${encodeURIComponent(id)}&version=${version}`}
          className="underline"
        >
          用此策略对象回测
        </Link>
      </div>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(labActionLabels) as (keyof typeof labActionLabels)[]).map(
          (a) => (
            <Button
              key={a}
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
          ),
        )}
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
              <input
                type="checkbox"
                checked={riskAccepted}
                onChange={(event) => setRiskAccepted(event.target.checked)}
              />
              我理解该策略尚未满足回测与前推晋级条件，仍选择手动开启未验证策略提醒；真实执行未验证。
            </label>
          )}
          <p>
            影子 {d.forward?.signals ?? 0} 信号 / {d.forward?.days ?? 0}{" "}
            日。策略live仍受全局模式、启用订阅和渠道约束，不产生真实委托。
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
      <h2>全局提醒模式：{status.data?.mode ?? "读取中"}</h2>
      <p className="text-sm">
        开启 live
        前须先在策略详情核对门槛和前推样本、手动晋级及开启该策略。订阅与渠道在系统配置。
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
              ? "开启全局 live"
              : mode === "shadow"
                ? "切换全局影子"
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
