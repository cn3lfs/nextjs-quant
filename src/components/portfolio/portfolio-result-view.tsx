"use client";

import { useState, type ReactNode } from "react";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import { EquityChart } from "../backtest/equity-chart";
import { MonthlyReturnsHeatmap } from "../backtest/monthly-returns-heatmap";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

export type PortfolioResultFill = {
  orderId: number;
  symbol: string;
  side: "buy" | "sell";
  date: string;
  price: number;
  quantity: number;
  fee: number;
  cashAfter: number;
};
export type PortfolioResultRejection = {
  orderId: number;
  date: string;
  reason: string;
};
export type PortfolioResultPerformance = {
  totalReturn: { value: number | null };
  annualReturn: { value: number | null };
  maxDrawdown: { value: number | null };
  sharpe: { value: number | null };
};
export type PortfolioResultSummary = {
  performance: PortfolioResultPerformance;
  buys: number;
  sells: number;
  fees: number;
  rejections: number;
  observations: number;
  openPositions: number;
};

const percent = (value: number | null) =>
  value === null ? "—" : `${displayNumber(value * 100, 2)}%`;
const money = (value: number) =>
  value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
/** A 股口径：红涨绿跌；缺失保持中性，不伪装成 0。 */
function trendTone(value: number | null) {
  return value === null
    ? "text-nc-text"
    : value > 0
      ? "text-nc-up"
      : value < 0
        ? "text-nc-down"
        : "text-nc-text";
}
function Kpi({
  label,
  tone = "text-nc-text",
  note,
  children,
}: {
  label: string;
  tone?: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2">
      <dt className="text-sub text-nc-text-3">{label}</dt>
      <dd
        className={`mt-0.5 truncate text-base font-semibold tabular-nums ${tone}`}
      >
        {children}
      </dd>
      {note && <dd className="mt-0.5 text-sub text-nc-text-4">{note}</dd>}
    </div>
  );
}
function SummaryKpis({ summary }: { summary: PortfolioResultSummary }) {
  const performance = summary.performance;
  return (
    <dl className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
      <Kpi
        label="累计收益"
        tone={trendTone(performance.totalReturn.value)}
        note="相对期初本金"
      >
        {percent(performance.totalReturn.value)}
      </Kpi>
      <Kpi label="年化收益" tone={trendTone(performance.annualReturn.value)}>
        {percent(performance.annualReturn.value)}
      </Kpi>
      <Kpi label="最大回撤">{percent(performance.maxDrawdown.value)}</Kpi>
      <Kpi label="夏普">
        {performance.sharpe.value === null
          ? "—"
          : displayNumber(performance.sharpe.value, 2)}
      </Kpi>
      <Kpi label="成交 / 费用">
        成交 {summary.buys + summary.sells}
        <span className="text-sub font-normal text-nc-text-3">
          （费用 {money(summary.fees)} 元）
        </span>
      </Kpi>
      <Kpi label="拒绝 / 持仓" note={`观察 ${summary.observations}`}>
        拒绝 {summary.rejections}
        <span className="text-sub font-normal text-nc-text-3">
          {" "}
          · 期末持仓 {summary.openPositions}
        </span>
      </Kpi>
    </dl>
  );
}
const fillColumns: DataTableColumn<PortfolioResultFill>[] = [
  {
    id: "date",
    header: "模拟成交",
    cell: ({ row }) => row.original.date.slice(0, 10),
  },
  { id: "symbol", header: "证券", cell: ({ row }) => row.original.symbol },
  {
    id: "side",
    header: "方向",
    cell: ({ row }) => (
      <span
        className={row.original.side === "buy" ? "text-nc-up" : "text-nc-down"}
      >
        {row.original.side === "buy" ? "买入" : "卖出"}
      </span>
    ),
  },
  {
    id: "price",
    header: "价格（元）",
    cell: ({ row }) => displayNumber(row.original.price, 4),
  },
  {
    id: "quantity",
    header: "股数",
    cell: ({ row }) => displayNumber(row.original.quantity, 0),
  },
  {
    id: "fee",
    header: "费用（元）",
    cell: ({ row }) => money(row.original.fee),
  },
  {
    id: "cash",
    header: "现金（元）",
    cell: ({ row }) => money(row.original.cashAfter),
  },
];
/** Leading marker column used only when a caller supplies a focus target. */
function focusColumn<T extends object>(
  match: (row: T) => boolean,
): DataTableColumn<T> {
  return {
    id: "focus",
    header: "定位",
    cell: ({ row }) =>
      match(row.original) ? (
        <span
          data-result-focus
          className="inline-flex items-center gap-1 whitespace-nowrap text-nc-accent"
        >
          <span aria-hidden="true" className="h-3.5 w-1 rounded bg-nc-accent" />
          定位
        </span>
      ) : null,
  };
}
const sameDate = (left: string, right: string | null | undefined) =>
  right !== null &&
  right !== undefined &&
  left.slice(0, 10) === right.slice(0, 10);
const rejectionColumns: DataTableColumn<PortfolioResultRejection>[] = [
  { id: "date", header: "日期", cell: ({ row }) => row.original.date },
  {
    id: "order",
    header: "订单",
    cell: ({ row }) => `#${row.original.orderId}`,
  },
  {
    id: "reason",
    header: "未成交原因",
    cell: ({ row }) => (
      <span className="inline-block min-w-48 whitespace-normal">
        {row.original.reason}
      </span>
    ),
  },
];

/** Shared result view for portfolio-style runs. The caller owns server
 * pagination; this component never loads the full fill list client-side. */
export function PortfolioResultView({
  equity,
  initial,
  summary,
  fills,
  rejections,
  fillPage,
  rejectionPage,
  pageSize,
  onFillPage,
  onRejectionPage,
  highlightedDate = null,
  highlightedOrderId = null,
}: {
  equity: { date: string; value: number }[];
  initial: number;
  summary?: PortfolioResultSummary | null;
  fills: { rows: PortfolioResultFill[]; total: number };
  rejections: { rows: PortfolioResultRejection[]; total: number };
  fillPage: number;
  rejectionPage: number;
  pageSize: number;
  onFillPage: (page: number) => void;
  onRejectionPage: (page: number) => void;
  /** Focus target from the diagnostic checks drawer; markers only, no reorder. */
  highlightedDate?: string | null;
  highlightedOrderId?: number | null;
}) {
  const [tab, setTab] = useState("fills"),
    [sorting, setSorting] = useState<{ id: string; desc: boolean }[]>([]);
  const pagination = (page: number) => ({ pageIndex: page, pageSize });
  const focusing = highlightedDate !== null || highlightedOrderId !== null;
  const matches = (row: { date: string; orderId: number }) =>
    (highlightedDate === null || sameDate(row.date, highlightedDate)) &&
    (highlightedOrderId === null || row.orderId === highlightedOrderId);
  const fillCols = focusing
    ? [focusColumn<PortfolioResultFill>(matches), ...fillColumns]
    : fillColumns;
  const rejectionCols = focusing
    ? [focusColumn<PortfolioResultRejection>(matches), ...rejectionColumns]
    : rejectionColumns;
  return (
    <div className="space-y-3">
      {summary && <SummaryKpis summary={summary} />}
      {equity.length > 0 && <EquityChart equity={equity} initial={initial} />}
      {equity.length > 0 && (
        <MonthlyReturnsHeatmap equity={equity} initial={initial} />
      )}
      {focusing && (
        <p role="status" className="text-sub text-nc-text-3">
          {(tab === "rejections" ? rejections.rows : fills.rows).some(matches)
            ? "已定位 "
            : "当前页未找到 "}
          {highlightedOrderId !== null ? `订单 #${highlightedOrderId}` : ""}
          {highlightedOrderId !== null && highlightedDate ? " · " : ""}
          {highlightedDate ?? ""}
        </p>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="fills">成交 {fills.total}</TabsTrigger>
          <TabsTrigger value="rejections">拒绝 {rejections.total}</TabsTrigger>
        </TabsList>
        <TabsContent
          value="fills"
          className="[&_tr:has([data-result-focus])]:bg-nc-inset"
        >
          <DataTable
            columns={fillCols}
            data={fills.rows}
            rowCount={fills.total}
            pagination={pagination(fillPage)}
            sorting={sorting}
            onPaginationChange={(updater) => {
              const next =
                typeof updater === "function"
                  ? updater(pagination(fillPage))
                  : updater;
              onFillPage(next.pageIndex);
            }}
            onSortingChange={setSorting}
            getRowId={(row) =>
              `${row.orderId}-${row.symbol}-${row.date}-${row.side}-${row.cashAfter}`
            }
            label="财务回放成交"
            emptyMessage="没有成交。"
          />
        </TabsContent>
        <TabsContent
          value="rejections"
          className="[&_tr:has([data-result-focus])]:bg-nc-inset"
        >
          <DataTable
            columns={rejectionCols}
            data={rejections.rows}
            rowCount={rejections.total}
            pagination={pagination(rejectionPage)}
            sorting={sorting}
            onPaginationChange={(updater) => {
              const next =
                typeof updater === "function"
                  ? updater(pagination(rejectionPage))
                  : updater;
              onRejectionPage(next.pageIndex);
            }}
            onSortingChange={setSorting}
            getRowId={(row) => `${row.orderId}-${row.date}-${row.reason}`}
            label="财务回放拒绝订单"
            emptyMessage="没有拒绝订单。"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
