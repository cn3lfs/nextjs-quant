import { formatEvidenceText } from "~/lib/common/evidence-text";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import type { Dispatch, SetStateAction } from "react";
import {
  DownloadSimple as ArrowDownToLine,
  Copy,
  ChartBar as FileChartColumn,
  Info,
  Trash as Trash2,
} from "@phosphor-icons/react/ssr";
import type { RouterOutputs } from "~/trpc/react";
import type { BaselineFill, BaselineOrder } from "quant-backtest";
import {
  orderStatusLabels,
  type OrderFilter,
  type ReportTab,
} from "~/lib/backtest/ma-workspace";
import { Button } from "../ui/button";
import { DialogTrigger } from "../ui/dialog";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { EquityChart } from "./equity-chart";
import { MaEvaluationPanel } from "./ma-evaluation-panel";

export type BaselineReport = NonNullable<RouterOutputs["maBaselineResult"]>;
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

export function MaReportOverview({ data }: { data: BaselineReport }) {
  const { summary } = data;
  const finalEquity = summary.equity.at(-1)?.value;
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="区间收益"
          value={`${summary.totalReturn > 0 ? "+" : ""}${displayNumber(summary.totalReturn, 2)}%`}
          note="相对期初本金，已计实验费用"
          tone={
            summary.totalReturn > 0
              ? "text-nc-up"
              : summary.totalReturn < 0
                ? "text-nc-down"
                : "text-nc-text"
          }
        />
        <Metric
          label="五分钟最大回撤"
          value={`${displayNumber(summary.maxDrawdown, 2)}%`}
          note="逐根收盘估值的最大损失幅度"
        />
        <Metric
          label="成交笔数"
          value={`${data.fillCount} 笔`}
          note={`${data.orderCount} 个订单 · ${data.rejectedCount} 个拒单`}
        />
        <Metric
          label="期末持仓"
          value={`${summary.shares.toLocaleString("zh-CN")} 股`}
          note={`现金 ${money(summary.cash)} 元`}
        />
      </dl>
      <section
        className="min-w-0 rounded-lg border border-nc-border-soft p-3"
        aria-label="日末收益与回撤"
      >
        <div className="mb-2 flex flex-wrap justify-between gap-2">
          <h4 className="text-sm font-medium">日末收益与回撤</h4>
          <span className="text-xs tabular-nums text-nc-text-3">
            {summary.equity.length} 个交易日 · 期末权益{" "}
            {finalEquity === undefined ? "—" : money(finalEquity)} 元
          </span>
        </div>
        <EquityChart equity={summary.equity} initial={summary.input.initial} />
        <p className="mt-2 text-xs leading-relaxed text-nc-text-3">
          图中按日末净值绘制收益与回撤；上方最大回撤按五分钟逐根估值计算，两者观察频率不同。窗口结束不强制平仓。
        </p>
      </section>
      {data.fillCount === 0 && (
        <div
          className="rounded-lg border border-nc-warn-edge bg-nc-inset p-3 text-sm"
          role="status"
        >
          <p className="font-medium text-nc-warn">本次实验没有成交</p>
          <p className="mt-1 text-nc-text-2">
            零成交不代表任务失败。可能没有形成有效交叉、资金不足一手或成交条件受阻；请在“成交与订单”核对订单及真实拒绝原因。
          </p>
        </div>
      )}
      {data.pending.length > 0 && (
        <section
          className="rounded-lg border border-nc-warn-edge p-3 text-sm"
          aria-label="待执行订单"
        >
          <h4 className="mb-2 font-medium text-nc-warn">期末仍有待执行请求</h4>
          <ul className="space-y-2">
            {data.pending.map((order) => (
              <li key={order.id} className="break-words">
                <span className="font-medium">
                  #{order.id} · {order.side === "sell" ? "退出" : "买入"}
                </span>{" "}
                · {order.signalAt.slice(0, 16).replace("T", " ")}
                <p className="text-nc-text-2">
                  {order.reason ?? "窗口结束，尚无下一根行情"} · 已尝试{" "}
                  {order.attempts} 次
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  note,
  tone = "text-nc-text",
}: {
  label: string;
  value: string;
  note: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-nc-border-soft bg-nc-inset p-3">
      <dt className="text-xs text-nc-text-3">{label}</dt>
      <dd className={`mt-2 text-xl font-semibold tabular-nums ${tone}`}>
        {value}
      </dd>
      <dd className="mt-2 break-words text-xs text-nc-text-3">{note}</dd>
    </div>
  );
}
export function MaReportEvidence({
  data,
  id,
}: {
  data: BaselineReport;
  id: string;
}) {
  const { manifest, summary } = data;
  const rows = [
    ["实验编号", id],
    ["策略", summary.input.strategy?.name ?? "双均线 SMA5/20 基线"],
    ["策略标识", summary.strategyId],
    ["证券 / 周期 / 复权", `${manifest.symbol.toUpperCase()} / 5分钟 / 不复权`],
    ["请求窗口", `${summary.input.start} 至 ${summary.input.end}`],
    ["实际窗口（北京时间）", `${manifest.start} 至 ${manifest.end}`],
    ["期初资金", `${money(summary.input.initial)} 元`],
    [
      "实验费用",
      `佣金万分之 ${summary.input.costs.commissionBps}，最低 ${summary.input.costs.minimumCommission} 元；卖出税费万分之 ${summary.input.costs.sellTaxBps}；单边滑点万分之 ${summary.input.costs.slippageBps}`,
    ],
    [
      "预热 / 回放",
      `${manifest.warmupBars} 根预热 / ${summary.evaluated} 根研究行情`,
    ],
    [
      "读取与核验 / 计算",
      `${displayNumber(manifest.sourceMs, 1)} ms / ${displayNumber(manifest.computeMs, 1)} ms`,
    ],
    ["引擎版本", summary.engineVersion],
    ["引擎指纹", summary.engineHash],
    ["冻结行情指纹", manifest.dataHash],
    ["源文件指纹", manifest.sourceFileHash],
    ["交易日历指纹", manifest.calendarHash],
    ["公司行动来源指纹", manifest.actionHash ?? "未记录"],
  ];
  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-nc-warn-edge p-3 text-sm text-nc-warn">
        规则自检：历史交易状态、公司行动与成交容量尚未完整还原，不能作为可信策略业绩。
      </p>
      <dl className="divide-y divide-nc-border-soft">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="grid min-w-0 gap-1 py-3 text-sm lg:grid-cols-3"
          >
            <dt className="text-nc-text-3">{label}</dt>
            <dd className="min-w-0 break-all tabular-nums text-nc-text-2 lg:col-span-2">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {summary.input.strategy && (
        <section>
          <h4 className="mb-2 text-sm font-medium">冻结的因子与条件配置</h4>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-nc-inset p-3 text-xs text-nc-text-2">
            {formatEvidenceText(summary.input.strategy)}
          </pre>
        </section>
      )}
      <section>
        <h4 className="mb-2 text-sm font-medium">规则与数据假设</h4>
        <ul className="list-disc space-y-2 pl-5 text-sm text-nc-text-2">
          {summary.assumptions.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
export function MaExperimentReport({
  id,
  data,
  modified,
  tab,
  onTabChange,
  onReuse,
  onExport,
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
  onDelete,
}: {
  id: string;
  data: BaselineReport;
  modified: boolean;
  tab: ReportTab;
  onTabChange: (tab: ReportTab) => void;
  onReuse: () => void;
  onExport: () => void;
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
  onDelete: () => void;
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
                成交记录 · {data.fillCount}
              </Button>
              <Button
                variant={activity === "orders" ? "default" : "outline"}
                className="min-h-10"
                aria-pressed={activity === "orders"}
                onClick={() => onActivityChange("orders")}
              >
                订单诊断 · {data.orderCount}
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
                columns={fillsColumns}
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
      <footer className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-nc-border-soft pt-4">
        <p className="text-xs text-nc-text-3">本次结果仅用于规则与数据核对。</p>
        <DialogTrigger asChild>
          <Button
            variant="danger"
            className="min-h-10"
            onClick={onDelete}
            disabled={exporting}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            删除实验
          </Button>
        </DialogTrigger>
      </footer>
    </section>
  );
}
