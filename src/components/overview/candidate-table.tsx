"use client";
import Link from "next/link";
import { DataTable, type DataTableProps } from "../ui/data-table";
import { formatNumber } from "trading-strategy-core/format-number";
import type { RouterOutputs } from "~/trpc/react";
import { Button } from "../ui/button";
import { glossary } from "~/lib/common/ui-glossary";
import { securityDisplayName } from "~/lib/market/security-display";
import { cryptoDisplayName, cryptoSymbol } from "~/lib/market/crypto";
import { strategyDisplayName } from "~/lib/strategy-facts/strategy-display";

export type WorkspaceCandidate =
  RouterOutputs["workspaceCandidates"]["items"][number];
export const qualificationLabel = {
  research: "未晋级 · 研究中",
  shadow: `${glossary.shadowForward} · 研究中`,
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
  securityNames = {},
  total,
  page = 0,
  onPage = () => {},
  infiniteScroll,
  loading,
  error,
  onRetry,
  onSelect,
  onPlan,
  canPlan,
  emptyMessage = `尚无收盘扫描或${glossary.shadowForward}候选。先补齐数据并登记策略；缺失不会生成计划。`,
}: {
  data: WorkspaceCandidate[];
  securityNames?: Record<string, string>;
  total: number;
  page?: number;
  onPage?: (p: number) => void;
  infiniteScroll?: DataTableProps<WorkspaceCandidate>["infiniteScroll"];
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
      infiniteScroll={infiniteScroll}
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
                    <span
                      className="text-sub text-nc-text-4"
                      title="历史来源 · 仅查看；不开放新建计划，打开图表核对行情"
                    >
                      仅查看
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
            const shortDate = (iso: string | number | null) =>
              iso === null
                ? "时点未记录"
                : new Date(iso).toLocaleDateString("zh-CN", {
                    month: "2-digit",
                    day: "2-digit",
                  });
            // Reasons stay available on hover; the row itself carries only the
            // strategy names and their observation dates.
            const reasonTitle = r.sources
              .map((s) => {
                const sourceFreshness = candidateFreshness(s);
                return [
                  `${s.strategyId} v${s.version}：${s.reason}`,
                  `扫描 ${s.scanAt === null ? "时点未记录" : new Date(s.scanAt).toLocaleString("zh-CN")}`,
                  `bar ${s.bar}`,
                  sourceFreshness ? freshnessLabels[sourceFreshness] : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
              })
              .join("\n");
            const rawName =
              r.market === "crypto"
                ? cryptoDisplayName(cryptoSymbol(r.symbol.replace(/^cx/, "")))
                : securityDisplayName(r.symbol, securityNames);
            const displayName =
              rawName && rawName !== "名称待补全" && rawName !== r.symbol
                ? rawName
                : null;
            const warnings = [
              r.scan?.hasHistorical ? "含历史来源" : "",
              r.scan?.hasUnverified ? "来源待核验" : "",
              r.tradingStatusEvidence?.status === "unknown"
                ? "交易状态待核验"
                : "",
            ].filter(Boolean);
            return (
              <div className="max-w-[26rem] min-w-0">
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
                    {displayName
                      ? `${displayName} ${r.symbol} · 打开图表`
                      : `${r.symbol} · 打开图表`}
                  </Link>
                  {freshness && (
                    <FreshnessBadge
                      freshness={freshness}
                      title="该行最旧来源的新鲜度；任一历史来源都会标为历史只读"
                    />
                  )}
                </span>
                <p
                  className="truncate text-sub text-nc-text-3"
                  title={reasonTitle}
                >
                  {r.sources
                    .map(
                      (s) =>
                        `${strategyDisplayName(s.strategyId)} · ${shortDate(s.scanAt)}`,
                    )
                    .join(" / ")}{" "}
                  · {r.bar}
                </p>
                {warnings.length > 0 && (
                  <p className="truncate text-sub text-nc-warn">
                    {warnings.join(" · ")}
                  </p>
                )}
              </div>
            );
          },
        },
        {
          id: "levels",
          header: () => (
            <span className="block text-right">入场 / 止损 / 目标</span>
          ),
          cell: ({ row: { original: r } }) => (
            <div
              className="text-right tabular-nums"
              title={`复权口径：${r.adjustment}`}
            >
              {formatNumber(r.price)} / {formatNumber(r.stop)} /{" "}
              {formatNumber(r.target)}
            </div>
          ),
        },
        {
          id: "quantity",
          header: () => <span className="block text-right">建议数量</span>,
          cell: ({ row: { original: r } }) => {
            const snapshot = r.positionSnapshot;
            const title = [
              r.quantityReason ?? "已预留撮合费用；实际成交与滑点需核对",
              snapshot
                ? `${snapshot.basis === "post-close" ? "收盘快照" : "盘中核对"} · ${new Date(snapshot.at).toLocaleString("zh-CN")}${
                    snapshot.unassignedValue > 0
                      ? ` · 未分配分仓 ${formatNumber(snapshot.unassignedValue)}，已计入市场占用，请分配`
                      : ""
                  }`
                : null,
            ]
              .filter(Boolean)
              .join("\n");
            return (
              <span className="block text-right tabular-nums" title={title}>
                {formatNumber(r.quantity, r.market === "crypto" ? 6 : 0)}
                {snapshot && snapshot.unassignedValue > 0 && (
                  <span className="ml-1 text-sub text-nc-warn">未分配</span>
                )}
              </span>
            );
          },
        },
        {
          id: "rps",
          header: () => <span className="block text-right">RPS20</span>,
          cell: ({ row: { original: r } }) => (
            <span
              className="block text-right tabular-nums"
              title={`后复权横截面排名 · ${r.rpsDate ?? "未发布"}`}
            >
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
