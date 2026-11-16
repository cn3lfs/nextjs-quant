"use client";
import { formatEvidenceText } from "~/lib/common/evidence-text";

import { useState } from "react";
import Link from "next/link";
import { api } from "~/trpc/react";
import {
  formatNumber,
  formatPercent,
} from "trading-strategy-core/format-number";
import { Button } from "../ui/button";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { Segmented } from "../panels";
import { useScreenVisible } from "../workbench/use-task-visible";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";

type Kind =
  | "order"
  | "fill"
  | "position"
  | "equity"
  | "rejection"
  | "action"
  | "advance"
  | "mirror";
const labels: Record<Kind, string> = {
  order: "订单",
  fill: "成交与触发",
  position: "持仓",
  equity: "每日权益",
  rejection: "拒单",
  action: "送转与分红",
  advance: "推进与补推",
  mirror: "模拟场所对照",
};
type Fact = {
  id: string;
  account: string;
  date: string;
  value: Record<string, unknown>;
};
const cell = (value: unknown) =>
  typeof value === "number"
    ? formatNumber(value, 6)
    : value === null || value === undefined
      ? "—"
      : formatEvidenceText(value);

export function PaperFacts({
  id,
  today = false,
}: {
  id?: string;
  today?: boolean;
}) {
  const [kind, setKind] = useState<Kind>("fill");
  const [page, setPage] = useState(0);
  const visible = useScreenVisible();
  const query = api.paperFacts.useQuery(
    { id, kind, page, today },
    { enabled: visible, refetchInterval: visible ? 30000 : false },
  );
  const keys: Record<Kind, string[]> = {
    order: ["symbol", "side", "status", "trigger", "due", "reason"],
    fill: [
      "symbol",
      "side",
      "quantity",
      "price",
      "fee",
      "holdingAfter",
      "trigger",
    ],
    position: ["symbol", "strategyId", "quantity", "cost", "mark", "lots"],
    equity: ["cash", "equity"],
    rejection: ["orderId", "reason"],
    action: ["symbol", "before", "quantity", "cash", "fractionalShares"],
    advance: ["from", "to", "bars", "at", "catchUp", "source"],
    mirror: [
      "phase",
      "local",
      "remote",
      "difference",
      "remoteEvidence",
      "reason",
    ],
  };
  const columnNames: Record<string, string> = {
    symbol: "标的",
    side: "方向",
    status: "状态",
    trigger: "触发",
    due: "预计执行bar",
    reason: "说明",
    quantity: "数量",
    price: "价格",
    fee: "费用",
    holdingAfter: "成交后持仓",
    strategyId: "候选",
    cost: "成本",
    mark: "现价",
    lots: "可卖批次",
    cash: "现金",
    equity: "权益",
    orderId: "订单",
    before: "调整前",
    fractionalShares: "碎股",
    from: "起始",
    to: "截止",
    bars: "bar数",
    at: "推进时间",
    catchUp: "补推",
    source: "来源",
    phase: "镜像状态",
    local: "本地成交",
    remote: "场所成交",
    difference: "逐笔差异",
  };
  const columns: DataTableColumn<Fact>[] = [
    { id: "date", header: "市场时间", cell: ({ row }) => row.original.date },
    ...(!id
      ? [
          {
            id: "account",
            header: "模拟账户",
            cell: ({ row }: { row: { original: Fact } }) =>
              row.original.account,
          },
        ]
      : []),
    ...keys[kind].map((key) => ({
      id: key,
      header: columnNames[key] ?? key,
      cell: ({ row }: { row: { original: Fact } }) => (
        <span className="whitespace-normal break-all">
          {cell(row.original.value[key])}
        </span>
      ),
    })),
  ];
  const points =
    kind === "equity"
      ? [...(query.data?.items ?? [])]
          .reverse()
          .map((r) => Number(r.value.equity))
      : [];
  const low = Math.min(...points),
    high = Math.max(...points);
  return (
    <section
      className="min-w-0 space-y-3"
      aria-label={today ? "今日模拟账户变化" : "纸面账户明细"}
    >
      <Segmented
        label="纸面记录类型"
        value={kind}
        options={(today
          ? ["order", "fill", "action"]
          : Object.keys(labels)
        ).map((v) => ({ value: v, label: labels[v as Kind] }))}
        onChange={(v) => {
          setKind(v as Kind);
          setPage(0);
        }}
      />
      {!!points.length && (
        <figure>
          <svg
            role="img"
            aria-label="当前页权益曲线（时间升序）"
            viewBox="0 0 600 120"
            className="h-32 w-full text-nc-accent"
          >
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              points={points
                .map(
                  (p, i) =>
                    `${(i * 600) / Math.max(points.length - 1, 1)},${110 - ((p - low) * 100) / Math.max(high - low, 1)}`,
                )
                .join(" ")}
            />
          </svg>
          <figcaption className="text-xs text-nc-text-3">
            当前页每日权益，含费用与滑点；翻页查看更早区间。
          </figcaption>
        </figure>
      )}
      <DataTable
        label={today ? "今日模拟账户变化" : `模拟${labels[kind]}`}
        data={query.data?.items ?? []}
        rowCount={query.data?.total ?? 0}
        columns={columns}
        getRowId={(r) => `${r.account}:${r.id}`}
        pagination={{ pageIndex: page, pageSize: 20 }}
        sorting={[]}
        onSortingChange={() => {}}
        onPaginationChange={(update) => {
          const next =
            typeof update === "function"
              ? update({ pageIndex: page, pageSize: 20 })
              : update;
          setPage(next.pageIndex);
        }}
        loading={query.isLoading}
        error={query.error?.message}
        onRetry={() => void query.refetch()}
        emptyMessage="尚无模拟记录；等待登记后已完成的真实行情。"
      />
    </section>
  );
}
export function PaperAccountsPanel() {
  const visible = useScreenVisible();
  const query = api.paperAccounts.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  const [selected, setSelected] = useState("");
  const account = selected || query.data?.[0]?.id || "";
  const detail = api.paperAccount.useQuery(account, {
    enabled: visible && !!account,
  });
  return (
    <section
      aria-label="纸面模拟账户"
      className="mb-6 min-w-0 space-y-4 rounded-lg border border-nc-accent bg-nc-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-nc-accent">
          模拟 · 纸面账户
        </h2>
        <Link href="/system?tab=paper" className="underline">
          纸面账户设置
        </Link>
      </div>
      <p className="text-sm text-nc-text-3">
        与下方用户交割账户独立；合计默认不包含模拟资金。CNY 与 USDT
        分开记账，规则自检不代表可信可投资业绩。
      </p>
      {query.error && (
        <p role="alert">
          {query.error.message}
          <Button onClick={() => void query.refetch()}>重试</Button>
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {query.data?.map((a) => (
          <Button
            key={a.id}
            variant="outline"
            className="h-auto min-w-0 flex-col items-start whitespace-normal p-3 text-left"
            aria-pressed={a.id === account}
            onClick={() => setSelected(a.id)}
          >
            <strong className="break-all text-nc-accent">
              模拟 · {a.id.replace(/^paper:/, "")}
            </strong>
            <span>
              {a.currency} · 本金 {formatNumber(a.initial)} · 累计{" "}
              {a.summary
                ? formatPercent(
                    a.summary.return === null ? null : a.summary.return * 100,
                  )
                : "尚未推进"}
            </span>
            <span>
              回撤{" "}
              {a.summary
                ? formatPercent(
                    a.summary.drawdown === null
                      ? null
                      : a.summary.drawdown * 100,
                  )
                : "—"}{" "}
              · {a.summary?.trades ?? 0} 笔闭合交易 · 胜率{" "}
              {formatPercent(
                a.summary?.winRate == null ? null : a.summary.winRate * 100,
              )}
            </span>
            <span>
              同期基准{" "}
              {formatPercent(
                a.summary?.benchmarkReturn == null
                  ? null
                  : a.summary.benchmarkReturn * 100,
              )}{" "}
              · 信号/市场日 {a.summary?.signals ?? 0}/{a.summary?.days ?? 0}
            </span>
            <span>
              最新bar {a.lastBar ?? "未观察"} ·{" "}
              {a.error ??
                a.summary?.assessment?.recommendation ??
                "前推中，30信号或60市场日后评估"}
            </span>
          </Button>
        ))}
      </div>
      {!query.isLoading && !query.data?.length && (
        <p>尚未登记；在设置中选择本金与合账方式，按冻结规则登记候选。</p>
      )}
      {detail.error && <p role="alert">{detail.error.message}</p>}
      {detail.data?.candidates.map((c) => (
        <details key={c.id} className="rounded border p-3">
          <summary className="break-all">{c.id} · 历史期望分布与偏差</summary>
          <p className="text-sm">
            历史同参数样本外窗口 {c.expectation.windows.length}{" "}
            个；已看过的研究分布，不能当作收益承诺。
          </p>
          <div className="max-h-48 overflow-auto">
            <pre className="whitespace-pre-wrap break-all text-xs">
              {formatEvidenceText(c.expectation)}
            </pre>
          </div>
          <p className="text-xs">未通过门槛：{c.reasons.join("、")}</p>
        </details>
      ))}
      {detail.data?.summary?.assessment && (
        <p role="status" className="text-nc-warn">
          {detail.data.summary.assessment.recommendation}：
          {detail.data.summary.assessment.reasons.join("、")}
          {detail.data.summary.assessment.slippageBasis === "paper-model"
            ? "；模型滑点仅验证本地撮合一致性，真实执行未验证"
            : ""}
        </p>
      )}
      {account && (
        <PaperBuildReview
          key={account}
          id={account}
          onConfirmed={() => {
            void detail.refetch();
            void query.refetch();
          }}
        />
      )}
      {account && <PaperFacts key={account} id={account} />}
    </section>
  );
}

function PaperBuildReview({
  id,
  onConfirmed,
}: {
  id: string;
  onConfirmed(): void;
}) {
  const [confirm, setConfirm] = useState(false);
  const review = api.reviewPaperBuild.useMutation();
  const apply = api.confirmPaperBuild.useMutation({
    onSuccess: () => {
      setConfirm(false);
      onConfirmed();
      review.reset();
    },
  });
  const manifest = review.data;
  return (
    <section
      aria-label="纸面执行版本复核"
      className="space-y-2 rounded border p-3"
    >
      <h3 className="font-semibold">执行版本复核</h3>
      <p className="text-xs text-nc-text-3">
        使用同一冻结请求重放并完整比较结果；一致后由你确认，仅更新执行版本，保留原始输入和财务历史。
      </p>
      <Button
        variant="outline"
        disabled={review.isPending || apply.isPending}
        onClick={() => {
          apply.reset();
          review.mutate(id);
        }}
      >
        {review.isPending ? "正在复核…" : "只读复核当前账户"}
      </Button>
      {review.error && <p role="alert">{review.error.message}</p>}
      {manifest && (
        <div className="space-y-1 break-all text-xs">
          <p>
            复核 {manifest.manifestHash} ·{" "}
            {manifest.exact
              ? "全部执行结果完全一致"
              : `结果不同：${manifest.firstDifference?.path ?? "未知字段"}`}
          </p>
          <p>
            旧版本 {manifest.oldBuild ?? "未记录"} → {manifest.newBuild}
          </p>
          {!manifest.exact && (
            <p role="alert">结果不一致，原始历史保留，不能确认版本。</p>
          )}
          {manifest.exact && manifest.oldBuild !== manifest.newBuild && (
            <Button disabled={apply.isPending} onClick={() => setConfirm(true)}>
              核对并确认执行版本
            </Button>
          )}
        </div>
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogTitle>确认纸面执行版本</DialogTitle>
          <DialogDescription>
            本次复核所有持久化结果完全一致。确认仅更新执行版本；账户、输入、运行程序或manifest已变化时会拒绝。
          </DialogDescription>
          <p className="break-all text-xs">{manifest?.manifestHash}</p>
          <Button
            disabled={apply.isPending || !manifest?.exact}
            onClick={() => {
              if (manifest)
                apply.mutate({
                  manifestHash: manifest.manifestHash,
                  confirmed: true,
                });
            }}
          >
            确认仅更新版本
          </Button>
          {apply.error && <p role="alert">{apply.error.message}</p>}
        </DialogContent>
      </Dialog>
    </section>
  );
}
