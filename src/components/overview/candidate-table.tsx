"use client";
import Link from "next/link";
import { DataTable, type DataTableProps } from "../ui/data-table";
import { formatNumber } from "trading-strategy-core/format-number";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import type { RouterOutputs } from "~/trpc/react";
import { Button } from "../ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { glossary } from "~/lib/common/ui-glossary";
import { securityDisplayName } from "~/lib/market/security-display";
import { cryptoDisplayName, cryptoSymbol } from "~/lib/market/crypto";
import {
  extractCandidateTriggerReason,
  strategyDisplayName,
  strategyMethodInfo,
} from "~/lib/strategy-facts/strategy-display";

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
/** One live A-share quote, as returned by `overviewQuotes` for the table. */
export type CandidateLiveQuote = {
  price: number;
  quoteTime: string | null;
  source?: string;
};
/** Only a positive, finite quote is usable; anything else falls back to close. */
function usablePrice(value: number | null | undefined): number | null {
  return value !== null &&
    value !== undefined &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : null;
}
/** Tencent returns `YYYY-MM-DD HH:mm:ss`; the tooltip shows the clock only. */
function quoteClock(quoteTime: string | null | undefined): string | null {
  if (!quoteTime) return null;
  const time = quoteTime.split(" ")[1];
  return time ?? quoteTime;
}
/** Calendar date of a quote stamp, used to reject an older live quote. */
function quoteDate(quoteTime: string | null | undefined): string | null {
  const prefix = quoteTime?.match(/^(\d{4}-\d{2}-\d{2})(?=[ T]|$)/)?.[1];
  const date = researchDateSchema.safeParse(prefix);
  return date.success ? date.data : null;
}
const shortScanDate = (iso: string | number | null) =>
  iso === null
    ? "时点未记录"
    : new Date(iso).toLocaleDateString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
      });
/** Hover detail for one row's sources: id, version, scan time, bar, freshness. */
function sourceDetailTitle(row: WorkspaceCandidate) {
  return row.sources
    .map((source) => {
      const freshness = candidateFreshness(source);
      return [
        `${source.strategyId} v${source.version}：${source.reason}`,
        `扫描 ${source.scanAt === null ? "时点未记录" : new Date(source.scanAt).toLocaleString("zh-CN")}`,
        `bar ${source.bar}`,
        freshness ? freshnessLabels[freshness] : null,
      ]
        .filter(Boolean)
        .join(" · ");
    })
    .join("\n");
}
function triggerReasonOf(row: WorkspaceCandidate) {
  return row.sources
    .map((source) =>
      extractCandidateTriggerReason({
        strategyId: source.strategyId,
        reason: source.reason,
        bar: source.bar,
        price: row.price,
        stop: row.stop,
        target: row.target,
      }),
    )
    .join("；");
}
/** One badge per distinct method family behind this row, so the selection
 *  method is readable without opening the chart. */
function methodFamiliesOf(row: WorkspaceCandidate) {
  return [
    ...new Map(
      row.sources.map((source) => {
        const info = strategyMethodInfo(source.strategyId);
        return [info.family, info] as const;
      }),
    ).values(),
  ];
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
  liveQuotes,
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
  onMethodSelect,
  emptyMessage = `尚无收盘扫描或${glossary.shadowForward}候选。先补齐数据并登记策略；缺失不会生成计划。`,
}: {
  data: WorkspaceCandidate[];
  securityNames?: Record<string, string>;
  /** Live A-share quotes for the current price column; errors are ignored. */
  liveQuotes?: Record<string, CandidateLiveQuote>;
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
  onMethodSelect?: (family: string) => void;
  emptyMessage?: string;
}) {
  return (
    <TooltipProvider>
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
            header: "标的",
            cell: ({ row: { original: r } }) => {
              const freshness = rowFreshness(r);
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
                <div className="max-w-[20rem] min-w-0 space-y-1">
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
                  {warnings.length > 0 && (
                    <p
                      className="truncate text-sub text-nc-warn"
                      title={warnings.join(" · ")}
                    >
                      {warnings.join(" · ")}
                    </p>
                  )}
                </div>
              );
            },
          },
          {
            id: "strategy",
            header: "对应策略",
            cell: ({ row: { original: r } }) => {
              const detailTitle = sourceDetailTitle(r);
              const methods = methodFamiliesOf(r);
              return (
                <div className="max-w-[18rem] min-w-0 space-y-1">
                  <p className="flex flex-wrap items-center gap-1">
                    {methods.map((m) =>
                      onMethodSelect ? (
                        <button
                          key={m.family}
                          type="button"
                          onClick={() => onMethodSelect(m.family)}
                          className="inline-flex cursor-pointer items-center rounded bg-nc-inset px-1.5 py-0.5 text-xs font-medium text-nc-text-2 hover:bg-nc-border-soft"
                          title={m.ruleSummary}
                        >
                          【{m.label}】
                        </button>
                      ) : (
                        <span
                          key={m.family}
                          className="inline-flex items-center rounded bg-nc-inset px-1.5 py-0.5 text-xs font-medium text-nc-text-2"
                          title={m.ruleSummary}
                        >
                          【{m.label}】
                        </span>
                      ),
                    )}
                  </p>
                  <span
                    className="block truncate text-sub text-nc-text-3"
                    title={detailTitle}
                  >
                    {r.sources
                      .map(
                        (s) =>
                          `${strategyDisplayName(s.strategyId)} · ${shortScanDate(s.scanAt)}`,
                      )
                      .join(" / ")}{" "}
                    · {r.bar}
                  </span>
                </div>
              );
            },
          },
          {
            id: "reason",
            header: "交易理由",
            cell: ({ row: { original: r } }) => {
              const reasonTitle = sourceDetailTitle(r);
              const triggerReason = triggerReasonOf(r);
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="block max-w-[14rem] truncate text-nc-text-3"
                      title={`入选依据：${triggerReason}`}
                      tabIndex={0}
                    >
                      <span className="sr-only">入选依据：</span>
                      {triggerReason}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-md whitespace-pre-wrap break-words text-left leading-relaxed">
                    <p>入选依据：{triggerReason}</p>
                    {reasonTitle && (
                      <p className="mt-1 whitespace-pre-wrap opacity-80">
                        {reasonTitle}
                      </p>
                    )}
                  </TooltipContent>
                </Tooltip>
              );
            },
          },
          {
            id: "priceEma",
            header: () => (
              <span className="block text-right">当前价 / EMA5 / EMA20</span>
            ),
            cell: ({ row: { original: r } }) => {
              const live =
                r.market === "cn-equity" ? liveQuotes?.[r.symbol] : null;
              const livePrice = usablePrice(live?.price);
              const closePrice = usablePrice(r.marketMetrics?.currentPrice);
              const ema5 = r.marketMetrics?.ema5 ?? null;
              const ema20 = r.marketMetrics?.ema20 ?? null;
              const asOf = r.marketMetrics?.asOfDate ?? null;
              // A live quote may only replace a dated local close when it
              // carries a date at least as new as that close. TDX fallback
              // stamps can be time-of-day only, which cannot prove recency.
              const liveDate = quoteDate(live?.quoteTime);
              const quoteDateUnverified =
                livePrice !== null && liveDate === null;
              const useLive =
                livePrice !== null &&
                (asOf === null ||
                  closePrice === null ||
                  (liveDate !== null && liveDate >= asOf));
              const currentPrice = useLive ? livePrice : closePrice;
              const adjustment =
                r.marketMetrics?.adjustment === "forward"
                  ? "前复权"
                  : r.marketMetrics?.adjustment === "none"
                    ? "不复权"
                    : null;
              const clock = quoteClock(live?.quoteTime);
              const liveLabel = `实时价 ${formatNumber(livePrice)}（${live?.source ?? "实时行情"}${clock ? ` · ${clock}` : ""}）`;
              const closeLabel = `最新收盘 ${formatNumber(closePrice)}（${asOf ?? "日期未知"}）`;
              let priceTitle = "当前价：暂不可用";
              if (useLive) {
                priceTitle = `当前价：${liveLabel}`;
                if (quoteDateUnverified) priceTitle += "；实时报价日期未核验";
              } else if (closePrice !== null) {
                priceTitle = `当前价：${closeLabel}`;
                if (quoteDateUnverified) {
                  priceTitle += "；实时报价日期未核验，已保留本地收盘";
                } else if (livePrice !== null) {
                  priceTitle += "；实时报价早于本地收盘日期，已忽略";
                }
              }
              const emaDetail = [adjustment, asOf ? `截至 ${asOf}` : null]
                .filter(Boolean)
                .join(" · ");
              const emaTitle =
                ema5 === null && ema20 === null
                  ? "日线 EMA5 / EMA20：暂不可用（数据不足或本地日线未就绪）"
                  : `日线 EMA5 / EMA20：${formatNumber(ema5)} / ${formatNumber(ema20)}${emaDetail ? `（${emaDetail}）` : ""}`;
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="block text-right tabular-nums"
                      title={`${priceTitle}\n${emaTitle}`}
                      tabIndex={0}
                    >
                      {formatNumber(currentPrice)} / {formatNumber(ema5)} /{" "}
                      {formatNumber(ema20)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs whitespace-pre-wrap text-left leading-relaxed">
                    <p>{priceTitle}</p>
                    <p className="mt-1">{emaTitle}</p>
                  </TooltipContent>
                </Tooltip>
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
                        ? ` · 既有未归属持仓已计入市场总占用（${formatNumber(snapshot.unassignedValue)}）`
                        : ""
                    }`
                  : null,
              ]
                .filter(Boolean)
                .join("\n");
              return (
                <span className="block text-right tabular-nums" title={title}>
                  {formatNumber(r.quantity, r.market === "crypto" ? 6 : 0)}
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
    </TooltipProvider>
  );
}
