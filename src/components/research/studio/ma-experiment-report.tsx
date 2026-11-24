import Link from "next/link";
import { tradeChartHref } from "~/lib/chart/chart-trade-marks";
import {
  MaReportEvidence,
  MaReportOverview,
  type BaselineReport,
} from "../../backtest/ma-experiment-report";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import type { Dispatch, SetStateAction } from "react";
import {
  DownloadSimple as ArrowDownToLine,
  Copy,
  ChartBar as FileChartColumn,
  Info,
} from "@phosphor-icons/react/ssr";
import type { RouterOutputs } from "~/trpc/react";
import type { BaselineFill, BaselineOrder } from "quant-backtest";
import {
  orderStatusLabels,
  type OrderFilter,
  type ReportTab,
} from "~/lib/backtest/ma-workspace";
import { Button } from "../../ui/button";
import { DataTable, type DataTableColumn } from "../../ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { MaEvaluationPanel } from "../../backtest/ma-evaluation-panel";

type Pagination = { pageIndex: number; pageSize: number };
const money = (value: number) =>
  value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const fillsColumns: DataTableColumn<BaselineFill>[] = [
  {
    id: "order",
    header: "订单",
    cell: ({ row }) => `#${row.original.orderId}`,
  },
  {
    id: "signal",
    header: "信号确认",
    cell: ({ row }) => row.original.signalAt.slice(0, 16).replace("T", " "),
  },
  {
    id: "date",
    header: "模拟成交",
    cell: ({ row }) => row.original.executedAt.slice(0, 16).replace("T", " "),
  },
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
  { id: "quantity", header: "股数", cell: ({ row }) => row.original.shares },
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
const ordersColumns: DataTableColumn<BaselineOrder>[] = [
  { id: "id", header: "订单", cell: ({ row }) => `#${row.original.id}` },
  {
    id: "date",
    header: "信号确认",
    cell: ({ row }) => row.original.signalAt.slice(0, 16).replace("T", " "),
  },
  {
    id: "side",
    header: "方向",
    cell: ({ row }) => (row.original.side === "buy" ? "买入" : "退出"),
  },
  {
    id: "status",
    header: "状态",
    cell: ({ row }) => orderStatusLabels[row.original.status],
  },
  {
    id: "attempts",
    header: "尝试次数",
    cell: ({ row }) => row.original.attempts,
  },
  {
    id: "reason",
    header: "未成交原因",
    cell: ({ row }) => (
      <span className="inline-block min-w-40 whitespace-normal">
        {row.original.reason ??
          (row.original.status === "filled"
            ? "已成交"
            : "窗口结束，尚无下一根行情")}
      </span>
    ),
  },
];

export function MaExperimentReport({
  id,
  data,
  modified,
  tab,
  onTabChange,
  onReuse,
  onExport,
  onMarkdown,
  exporting,
  fillPagination,
  onFillPaginationChange,
  fillsLoading,
  fillsError,
  onRetryFills,
  activity,
  onActivityChange,
  orderFilter,
  onOrderFilterChange,
  orders,
  ordersLoading,
  ordersError,
  onRetryOrders,
  orderPagination,
  onOrderPaginationChange,
}: {
  id: string;
  data: BaselineReport;
  modified: boolean;
  tab: ReportTab;
  onTabChange: (tab: ReportTab) => void;
  onReuse: () => void;
  onExport: () => void;
  onMarkdown: () => void;
  exporting: boolean;
  fillPagination: Pagination;
  onFillPaginationChange: Dispatch<SetStateAction<Pagination>>;
  fillsLoading: boolean;
  fillsError?: string;
  onRetryFills: () => void;
  activity: "fills" | "orders";
  onActivityChange: (value: "fills" | "orders") => void;
  orderFilter: OrderFilter;
  onOrderFilterChange: (value: OrderFilter) => void;
  orders: RouterOutputs["maBaselineOrders"] | undefined;
  ordersLoading: boolean;
  ordersError?: string;
  onRetryOrders: () => void;
  orderPagination: Pagination;
  onOrderPaginationChange: Dispatch<SetStateAction<Pagination>>;
}) {
  return (
    <section
      aria-label="实验报告"
      className="min-w-0 rounded-lg border border-nc-border bg-nc-card p-4"
    >
      {modified && (
        <p
          role="status"
          className="mb-4 flex gap-2 rounded-lg border border-nc-accent-700 bg-nc-accent-900 p-3 text-sm text-nc-accent-light"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          当前配置已修改，报告仍来自所选历史实验。运行后才会产生新结果。
        </p>
      )}
      <header className="mb-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-base font-medium">
              <FileChartColumn
                className="size-4 shrink-0 text-nc-accent"
                aria-hidden="true"
              />
              实验报告 · {data.manifest.symbol.toUpperCase()}
            </h3>
            <p className="mt-1 text-sm tabular-nums text-nc-text-2">
              {data.manifest.start.slice(0, 10)} 至{" "}
              {data.manifest.end.slice(0, 10)}
            </p>
            <p className="mt-1 text-xs text-nc-text-3">
              {data.summary.input.strategy?.name ?? "SMA 5 / 20"} · 已完成 ·
              规则自检
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="min-h-10" onClick={onReuse}>
              <Copy className="size-4" aria-hidden="true" />
              复用此配置
            </Button>
            <Button
              variant="outline"
              className="min-h-10"
              onClick={onExport}
              disabled={exporting}
            >
              <ArrowDownToLine className="size-4" aria-hidden="true" />
              {exporting ? "正在导出…" : "导出完整实验"}
            </Button>
            <Button variant="outline" disabled={exporting} onClick={onMarkdown}>
              导出 Markdown
            </Button>
          </div>
        </div>
        <p className="break-all text-xs text-nc-text-3">实验编号 {id}</p>
      </header>
      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as ReportTab)}
      >
        <TabsList
          aria-label="实验报告标签"
          className="mb-3 w-full flex-wrap justify-start gap-2"
        >
          <TabsTrigger className="min-h-10" value="overview">
            概览
          </TabsTrigger>
          <TabsTrigger className="min-h-10" value="evaluation">
            绩效评价
          </TabsTrigger>
          <TabsTrigger className="min-h-10" value="activity">
            成交与订单
          </TabsTrigger>
          <TabsTrigger className="min-h-10" value="evidence">
            复现依据
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <MaReportOverview data={data} />
        </TabsContent>
        <TabsContent value="evaluation">
          <MaEvaluationPanel key={id} id={id} />
        </TabsContent>
        <TabsContent value="activity">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              <Button
                variant={activity === "fills" ? "default" : "outline"}
                className="min-h-10"
                aria-pressed={activity === "fills"}
                onClick={() => onActivityChange("fills")}
              >
                成交记录 · {displayNumber(data.fillCount, 0)}
              </Button>
              <Button
                variant={activity === "orders" ? "default" : "outline"}
                className="min-h-10"
                aria-pressed={activity === "orders"}
                onClick={() => onActivityChange("orders")}
              >
                订单诊断 · {displayNumber(data.orderCount, 0)}
              </Button>
            </div>
            {activity === "orders" && (
              <Select
                value={orderFilter}
                onValueChange={(value) =>
                  onOrderFilterChange(value as OrderFilter)
                }
              >
                <SelectTrigger
                  aria-label="订单状态"
                  className="min-h-10 w-full lg:w-40"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(orderStatusLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="min-w-0 tabular-nums">
            {activity === "fills" ? (
              <DataTable
                columns={[
                  ...fillsColumns,
                  {
                    id: "chart",
                    header: "复盘",
                    cell: ({ row }) => (
                      <Button asChild size="sm" variant="ghost">
                        <Link
                          href={tradeChartHref({
                            symbol: data.manifest.symbol,
                            at: row.original.executedAt.slice(0, 10),
                          })}
                          aria-label={`看K线 ${data.manifest.symbol} ${row.original.executedAt.slice(0, 10)}`}
                          prefetch={false}
                          scroll={false}
                        >
                          看K线
                        </Link>
                      </Button>
                    ),
                  },
                ]}
                data={data.fills}
                rowCount={data.fillCount}
                pagination={fillPagination}
                sorting={[]}
                onPaginationChange={onFillPaginationChange}
                onSortingChange={() => {}}
                getRowId={(row) => String(row.orderId)}
                label="策略逐笔成交"
                loading={fillsLoading}
                error={fillsError}
                onRetry={onRetryFills}
                emptyMessage="本次没有成交，可切换订单诊断核对拒绝或待执行原因。"
              />
            ) : (
              <DataTable
                columns={ordersColumns}
                data={orders?.orders ?? []}
                rowCount={orders?.rowCount ?? 0}
                pagination={orderPagination}
                sorting={[]}
                onPaginationChange={onOrderPaginationChange}
                onSortingChange={() => {}}
                getRowId={(row) => String(row.id)}
                label="策略订单诊断"
                loading={ordersLoading}
                error={ordersError}
                onRetry={onRetryOrders}
                emptyMessage="当前筛选没有订单。无交叉可能不产生请求，并非记录丢失。"
              />
            )}
          </div>
          <p className="mt-3 text-xs text-nc-text-3">
            每页 50
            条，按信号时间顺序。只有成交才改变账户；订单拒绝和待执行不会被补为成交。
          </p>
        </TabsContent>
        <TabsContent value="evidence">
          <MaReportEvidence data={data} id={id} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
