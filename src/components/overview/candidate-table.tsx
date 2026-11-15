"use client";
import Link from "next/link";
import { DataTable } from "../ui/data-table";
import { formatNumber } from "trading-strategy-core/format-number";
import type { RouterOutputs } from "~/trpc/react";

export type WorkspaceCandidate =
  RouterOutputs["workspaceCandidates"]["items"][number];
export const qualificationLabel = {
  research: "未晋级 · 研究中",
  shadow: "影子前推中 · 研究中",
  promoted: "已晋级",
};
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
}: {
  data: WorkspaceCandidate[];
  total: number;
  page?: number;
  onPage?: (p: number) => void;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onSelect?: (row: WorkspaceCandidate) => void;
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
      emptyMessage="尚无收盘扫描或影子入场候选。先补齐数据并登记策略；缺失不会生成计划。"
      columns={[
        {
          id: "symbol",
          header: "标的 / 来源策略",
          cell: ({ row: { original: r } }) => (
            <div>
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
              <p className="text-xs text-nc-text-3">
                {r.strategyId} v{r.version} · {r.bar}
              </p>
            </div>
          ),
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
            <span title={r.quantityReason ?? "不含费用滑点"}>
              {formatNumber(r.quantity, r.market === "crypto" ? 6 : 0)}
              {r.quantityReason && (
                <p className="max-w-64 text-xs text-nc-text-3">
                  {r.quantityReason}
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
