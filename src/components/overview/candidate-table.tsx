"use client";
import Link from "next/link";
import { DataTable } from "../ui/data-table";
import { formatNumber } from "trading-strategy-core/format-number";
import type { RouterOutputs } from "~/trpc/react";
import { Button } from "../ui/button";

export type WorkspaceCandidate =
  RouterOutputs["workspaceCandidates"]["items"][number];
export const qualificationLabel = {
  research: "未晋级 · 研究中",
  shadow: "影子前推中 · 研究中",
  promoted: "已晋级",
};
/** One vocabulary for how old a candidate is, shared by list and detail. */
export type CandidateFreshness =
  "fresh-close" | "intraday" | "stale" | "unverified";
export const freshnessLabels: Record<CandidateFreshness, string> = {
  "fresh-close": "本次收盘",
  intraday: "盘中观察",
  stale: "历史只读",
  unverified: "待核验",
};
type FreshnessSource = {
  scanFreshness?: "current" | "intraday" | "stale" | "unknown" | null;
  /** Optional advisory field; the list uses `scanFreshness` when absent. */
  freshness?: CandidateFreshness | null;
};
export function candidateFreshness(
  source: FreshnessSource,
): CandidateFreshness | null {
  if (source.freshness) return source.freshness;
  switch (source.scanFreshness) {
    case "current":
      return "fresh-close";
    case "intraday":
      return "intraday";
    case "stale":
      return "stale";
    case "unknown":
      return "unverified";
    default:
      return null;
  }
}
/** A row is as fresh as its weakest source: one historical source is enough
 *  to warn before the row is opened. */
function rowFreshness(row: WorkspaceCandidate): CandidateFreshness | null {
  const values = row.sources
    .map((source) => candidateFreshness(source))
    .filter((value): value is CandidateFreshness => value !== null);
  if (!values.length) return null;
  if (values.every((value) => value === "fresh-close")) return "fresh-close";
  if (values.includes("stale")) return "stale";
  return values.includes("intraday") ? "intraday" : "unverified";
}
function freshnessState(freshness: CandidateFreshness) {
  if (freshness === "fresh-close") return "ok";
  if (freshness === "stale") return "warn";
  if (freshness === "intraday") return "idle";
  return undefined;
}
function FreshnessBadge({
  freshness,
  title,
}: {
  freshness: CandidateFreshness;
  title?: string;
}) {
  return (
    <span
      className="nc-status-chip"
      data-state={freshnessState(freshness)}
      title={title}
    >
      <i aria-hidden="true" />
      {freshnessLabels[freshness]}
    </span>
  );
}
export function candidateHref(row: WorkspaceCandidate) {
  const params = new URLSearchParams({
    candidate: row.key,
    adjustment: "none",
    symbol: row.symbol,
  });
  if (row.market === "crypto") {
    params.set("tab", "crypto");
    params.set("pair", row.symbol.replace(/^cx/, ""));
  }
  return `/scan?${params}`;
}
export function CandidateTable({
  data,
  total,
  page = 0,
  onPage = () => {},
  loading,
  error,
  onRetry,
  onSelect,
  onPlan,
  canPlan,
  emptyMessage = "尚无收盘扫描或影子入场候选。先补齐数据并登记策略；缺失不会生成计划。",
}: {
  data: WorkspaceCandidate[];
  total: number;
  page?: number;
  onPage?: (p: number) => void;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onSelect?: (row: WorkspaceCandidate) => void;
  onPlan?: (row: WorkspaceCandidate) => void;
  canPlan?: (row: WorkspaceCandidate) => boolean;
  emptyMessage?: string;
}) {
  return (
    <DataTable
      label="明日计划候选"
      data={data}
      rowCount={total}
      loading={loading}
      error={error}
      onRetry={onRetry}
      pagination={{ pageIndex: page, pageSize: 20 }}
      onPaginationChange={(u) =>
        onPage(
          (typeof u === "function" ? u({ pageIndex: page, pageSize: 20 }) : u)
            .pageIndex,
        )
      }
      sorting={[]}
      onSortingChange={() => {}}
      getRowId={(r) => r.key}
      emptyMessage={emptyMessage}
      columns={[
        ...(onPlan
          ? [
              {
                id: "plan",
                header: "计划",
                cell: ({
                  row: { original: r },
                }: {
                  row: { original: WorkspaceCandidate };
                }) =>
                  canPlan && !canPlan(r) ? (
                    <span className="text-xs text-nc-text-3">
                      历史来源 · 仅查看
                    </span>
                  ) : (
                    <Button onClick={() => onPlan(r)}>加入计划</Button>
                  ),
              },
            ]
          : []),
        {
          id: "symbol",
          header: "标的 / 来源策略",
          cell: ({ row: { original: r } }) => {
            const freshness = rowFreshness(r);
            return (
              <div>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Link
                    href={candidateHref(r)}
                    onClick={
                      onSelect
                        ? (e) => {
                            e.preventDefault();
                            onSelect(r);
                          }
                        : undefined
                    }
                    className="underline"
                  >
                    {r.symbol} · 打开图表
                  </Link>
                  {freshness && (
                    <FreshnessBadge
                      freshness={freshness}
                      title="该行最旧来源的新鲜度；任一历史来源都会标为历史只读"
                    />
                  )}
                </span>
                <p className="text-xs text-nc-text-3">
                  {r.sources
                    .map((s) => `${s.strategyId} v${s.version}`)
                    .join(" / ")}{" "}
                  · {r.bar}
                </p>
                {r.sources.map((s) => {
                  const sourceFreshness = candidateFreshness(s);
                  return (
                    <p key={s.key} className="max-w-80 text-xs text-nc-text-3">
                      {s.strategyId}：{s.reason}
                      {sourceFreshness && (
                        <span
                          className={
                            sourceFreshness === "stale"
                              ? "text-nc-warn"
                              : "text-nc-text-3"
                          }
                        >
                          {" "}
                          · <FreshnessBadge freshness={sourceFreshness} /> ·
                          扫描{" "}
                          {s.scanAt === null
                            ? "时点未记录"
                            : new Date(s.scanAt).toLocaleString("zh-CN")}{" "}
                          · bar {s.bar}
                        </span>
                      )}
                    </p>
                  );
                })}
                {r.scan && (r.scan.hasHistorical || r.scan.hasUnverified) && (
                  <p className="text-xs text-nc-warn">
                    {[
                      r.scan.hasHistorical ? "含历史来源" : "",
                      r.scan.hasUnverified ? "来源待核验" : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
                {r.tradingStatusEvidence?.status === "unknown" && (
                  <p className="text-xs text-nc-warn">交易状态未知，请核验</p>
                )}
              </div>
            );
          },
        },
        {
          id: "levels",
          header: "入场 / 止损 / 目标",
          cell: ({ row: { original: r } }) => (
            <div>
              {formatNumber(r.price)} / {formatNumber(r.stop)} /{" "}
              {formatNumber(r.target)}
              <p className="text-xs text-nc-text-3">{r.adjustment}</p>
            </div>
          ),
        },
        {
          id: "quantity",
          header: "建议数量",
          cell: ({ row: { original: r } }) => (
            <span
              title={r.quantityReason ?? "已预留撮合费用；实际成交与滑点需核对"}
            >
              {formatNumber(r.quantity, r.market === "crypto" ? 6 : 0)}
              {r.quantityReason && (
                <p className="max-w-64 text-xs text-nc-text-3">
                  {r.quantityReason}
                </p>
              )}
              {r.positionSnapshot && (
                <p className="max-w-64 text-xs text-nc-text-3">
                  {r.positionSnapshot.basis === "post-close"
                    ? "收盘快照"
                    : "盘中核对"}{" "}
                  · {new Date(r.positionSnapshot.at).toLocaleString("zh-CN")}
                  {r.positionSnapshot.unassignedValue > 0
                    ? ` · 未分配分仓 ${formatNumber(r.positionSnapshot.unassignedValue)}，已计入市场占用，请分配`
                    : ""}
                </p>
              )}
            </span>
          ),
        },
        {
          id: "rps",
          header: "RPS20",
          cell: ({ row: { original: r } }) => (
            <span title={`后复权横截面排名 · ${r.rpsDate ?? "未发布"}`}>
              {formatNumber(r.rps20, 1)}
            </span>
          ),
        },
        {
          id: "qualification",
          header: "成绩单状态",
          cell: ({ row: { original: r } }) => (
            <strong
              className={
                r.qualification === "promoted" ? "text-nc-ok" : "text-nc-warn"
              }
            >
              {qualificationLabel[r.qualification]}
            </strong>
          ),
        },
      ]}
    />
  );
}
