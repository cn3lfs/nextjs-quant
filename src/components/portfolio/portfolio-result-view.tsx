"use client";

import { useState } from "react";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import { EquityChart } from "../backtest/equity-chart";
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
}) {
  const [tab, setTab] = useState("fills"),
    [sorting, setSorting] = useState<{ id: string; desc: boolean }[]>([]);
  const pagination = (page: number) => ({ pageIndex: page, pageSize });
  return (
    <div className="space-y-3">
      {equity.length > 0 && <EquityChart equity={equity} initial={initial} />}
      {summary && (
        <p className="text-sm">
          累计收益 {percent(summary.performance.totalReturn.value)} · 年化{" "}
          {percent(summary.performance.annualReturn.value)} · 最大回撤{" "}
          {percent(summary.performance.maxDrawdown.value)} · 夏普{" "}
          {summary.performance.sharpe.value === null
            ? "—"
            : displayNumber(summary.performance.sharpe.value, 2)}{" "}
          · 成交 {summary.buys + summary.sells}（费用 {money(summary.fees)} 元）
          · 拒绝 {summary.rejections} · 期末持仓 {summary.openPositions} · 观察{" "}
          {summary.observations}
        </p>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="fills">成交 {fills.total}</TabsTrigger>
          <TabsTrigger value="rejections">拒绝 {rejections.total}</TabsTrigger>
        </TabsList>
        <TabsContent value="fills">
          <DataTable
            columns={fillColumns}
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
        <TabsContent value="rejections">
          <DataTable
            columns={rejectionColumns}
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
