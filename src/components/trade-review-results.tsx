"use client";

import { useEffect, useRef } from "react";
import type { RouterOutputs } from "~/trpc/react";
import type { ReviewValue, CostMethod } from "~/lib/trade-review";
import {
  DataTable,
  type DataTableColumn,
  type DataTableProps,
} from "./ui/data-table";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import {
  ReviewDisclosure,
  ReviewDiagnostics,
} from "./trade-review-diagnostics";
import { Badge } from "./ui/badge";

export type TradeReviewData = RouterOutputs["tradeReviewSnapshot"];
type Round = TradeReviewData["rounds"][number];
const metric = (v: ReviewValue, percent = false) =>
  v.value === null
    ? `不可得：${v.reason || "证据不足"}`
    : percent
      ? `${(v.value * 100).toFixed(2)}%`
      : v.value.toFixed(2);
const dimensions: Record<string, string> = {
  security: "标的",
  instrument: "品种",
  holdingPeriod: "持有期",
  rps: "RPS 分档",
  industry: "行业",
  concept: "概念",
  weekday: "星期",
  position: "仓位",
};
const feeLabels = {
  netAmount: "按发生金额反推",
  components: "按分项求和",
  missing: "费用证据缺失",
} as const;

const roundColumns: DataTableColumn<Round>[] = [
  {
    accessorKey: "security",
    header: "标的",
    cell: (c) => (
      <span>
        {c.row.original.security}
        {c.row.original.openingUnknown && (
          <Badge variant="outline">openingUnknown</Badge>
        )}
      </span>
    ),
  },
  {
    accessorKey: "openingDate",
    header: "开仓日",
    cell: (c) => c.row.original.openingDate ?? "不可得：建仓证据不足",
  },
  {
    accessorKey: "closingDate",
    header: "平仓日",
    cell: (c) => c.row.original.closingDate ?? "尚未平仓",
  },
  ...(
    [
      ["holdingTradingDays", "持有交易日"],
      ["buyAveragePrice", "买均价"],
      ["sellAveragePrice", "卖均价"],
    ] as const
  ).map(([key, header]) => ({
    accessorKey: key,
    header,
    cell: (c: { row: { original: Round } }) => metric(c.row.original[key]),
  })),
  { accessorKey: "quantity", header: "数量" },
  ...(
    [
      ["totalFees", "费用"],
      ["netProfit", "净收益"],
      ["netReturn", "收益率"],
    ] as const
  ).map(([key, header]) => ({
    accessorKey: key,
    header,
    cell: (c: { row: { original: Round } }) =>
      metric(c.row.original[key], key === "netReturn"),
  })),
];

export function TradeReviewCaveats({
  data,
}: {
  data: Pick<
    TradeReviewData,
    "unexplainedCashResidual" | "excludedCashFlows" | "basis"
  >;
}) {
  const known = data.excludedCashFlows.filter((row) => row.amount !== null);
  return (
    <Card className="border-primary">
      <CardHeader>
        <CardTitle>资金与收益口径</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-lg font-semibold">
          未解释资金残差：{metric(data.unexplainedCashResidual)} 元
        </p>
        <p>残差独立展示，不自动平账，不生成补造流水。</p>
        <p>
          openingUnknown：中签建仓等证据不足的回合，开仓成本与收益留空；不按零成本计算利润。
        </p>
        <p>
          已排除作废流水 {data.excludedCashFlows.length} 笔 ·{" "}
          {known.length === data.excludedCashFlows.length
            ? "金额合计"
            : "已知金额小计"}{" "}
          {known.reduce((sum, row) => sum + row.amount!, 0).toFixed(2)}{" "}
          元（有符号发生额）；金额缺失{" "}
          {data.excludedCashFlows.length - known.length} 笔。
        </p>
        <ReviewDisclosure
          label={`作废流水明细，共 ${data.excludedCashFlows.length} 笔`}
        >
          {data.excludedCashFlows.map((row, i) => (
            <p key={i}>
              第 {row.rowIndex} 行 · {row.reason} ·{" "}
              {row.amount === null
                ? row.amountReason
                : `${row.amount.toFixed(2)} 元`}
            </p>
          ))}
        </ReviewDisclosure>
        {Object.values(data.basis).map((text, i) => (
          <p key={i} className="text-sm text-muted-foreground">
            {text}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

function NavCurve({ days }: { days: TradeReviewData["nav"]["days"] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const paint = () => {
      const width = canvas.clientWidth,
        height = 180,
        ratio = window.devicePixelRatio || 1;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(ratio, ratio);
      const values = days.flatMap((d) =>
        d.nav.value === null ? [] : [d.nav.value],
      );
      if (!values.length) return;
      const min = Math.min(...values),
        max = Math.max(...values),
        range = max - min || 1;
      ctx.strokeStyle = getComputedStyle(canvas).color;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let connected = false;
      days.forEach((day, i) => {
        if (day.nav.value === null) {
          connected = false;
          return;
        }
        const x = 12 + (i / Math.max(1, days.length - 1)) * (width - 24),
          y = 12 + (1 - (day.nav.value - min) / range) * 156;
        if (connected && day.dailyReturn.value !== null) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        ctx.fillRect(x - 1, y - 1, 3, 3);
        connected = true;
      });
      ctx.stroke();
    };
    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [days]);
  const values = days.flatMap((d) =>
    d.nav.value === null ? [] : [d.nav.value],
  );
  return (
    <div className="space-y-2">
      <canvas
        ref={ref}
        className="h-45 w-full text-primary"
        role="img"
        aria-label="账户每日净值曲线，缺失和收益中断处断开；明细见下方"
      />
      <p className="text-sm text-muted-foreground">
        {days[0]?.date ?? "无起始日期"} — {days.at(-1)?.date ?? "无结束日期"} ·{" "}
        {values.length
          ? `已知净值范围 ${Math.min(...values).toFixed(2)} — ${Math.max(...values).toFixed(2)} 元`
          : "净值不可得：缺少有效估值"}{" "}
        · 缺失处不补零、不跨缺口连线。
      </p>
    </div>
  );
}

export function TradeReviewResults({
  data,
  method,
  onMethodChange,
  pagination,
  sorting,
  onPaginationChange,
  onSortingChange,
  loading,
  monthPagination,
  onMonthPaginationChange,
  pointTable,
  attributionTable,
}: {
  data: TradeReviewData;
  pointTable: Pick<
    DataTableProps<TradeReviewData["tradePoints"][number]>,
    "pagination" | "sorting" | "onPaginationChange" | "onSortingChange"
  >;
  attributionTable: Pick<
    DataTableProps<TradeReviewData["attribution"][number]>,
    "pagination" | "sorting" | "onPaginationChange" | "onSortingChange"
  >;
  method: CostMethod;
  onMethodChange: (method: CostMethod) => void;
  monthPagination: DataTableProps<Round>["pagination"];
  onMonthPaginationChange: DataTableProps<Round>["onPaginationChange"];
} & Pick<
  DataTableProps<Round>,
  | "pagination"
  | "sorting"
  | "onPaginationChange"
  | "onSortingChange"
  | "loading"
>) {
  const nav = data.nav;
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">{data.account} · 交易复盘</h2>
      <p className="text-sm text-muted-foreground">
        交易日历：{data.calendar.source} · {data.calendar.start} —{" "}
        {data.calendar.end}。复盘截止账户最后一笔流水；未平仓头寸不延伸到今天。
      </p>
      <TradeReviewCaveats data={data} />
      <Tabs
        value={method}
        onValueChange={(value) => onMethodChange(value as CostMethod)}
      >
        <TabsList aria-label="成本口径">
          <TabsTrigger disabled={loading} value="movingAverage">
            移动加权
          </TabsTrigger>
          <TabsTrigger disabled={loading} value="fifo">
            FIFO
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <DataTable
        label="交易回合"
        columns={roundColumns}
        data={data.rounds}
        rowCount={data.rowCount}
        pagination={pagination}
        sorting={sorting}
        onPaginationChange={onPaginationChange}
        onSortingChange={onSortingChange}
        getRowId={(row) => row.id}
        loading={loading}
      />
      <section className="space-y-3">
        <h3 className="text-lg font-semibold">费用来源</h3>
        <ReviewDisclosure label={`费用来源，共 ${data.feeSources.length} 笔`}>
          {data.feeSources.length ? (
            data.feeSources.map((fill) => (
              <p key={fill.index}>
                {fill.date} · {fill.security} ·{" "}
                {fill.sources
                  .map(
                    (source) =>
                      `${feeLabels[source.source]}：${source.amount === null ? "不可得：费用证据缺失" : source.amount.toFixed(2)} 元；${source.warnings.join("；")}`,
                  )
                  .join("；") || "不可得：该成交未进入可分析回合"}
              </p>
            ))
          ) : (
            <p>无成交费用记录。</p>
          )}
        </ReviewDisclosure>
      </section>
      <section className="space-y-3">
        <h3 className="text-lg font-semibold">
          买卖点（按移动加权回合确定区间）
        </h3>
        <DataTable
          label="买卖点"
          data={data.tradePoints}
          rowCount={data.pointCount}
          {...pointTable}
          loading={loading}
          getRowId={(row) => String(row.fillIndex)}
          columns={[
            { accessorKey: "security", header: "标的" },
            {
              accessorKey: "fillIndex",
              header: "成交序号",
              cell: (c) => c.row.original.fillIndex + 1,
            },
            {
              id: "metrics",
              header: "买卖点分析",
              enableSorting: false,
              cell: ({ row: { original: point } }) => (
                <div className="space-y-1">
                  <p>{point.basis}</p>
                  <p>
                    日内位置：{metric(point.intradayPosition, true)} · MFE：
                    {metric(point.mfe, true)} · MAE：{metric(point.mae, true)}
                  </p>
                  <p>
                    区间位置：
                    {Object.entries(point.intervalPositions)
                      .map(([period, v]) => `${period} 日：${metric(v, true)}`)
                      .join("；")}
                  </p>
                  <p>
                    卖后走势：
                    {Object.entries(point.afterSale)
                      .map(([period, v]) => `${period} 日：${metric(v, true)}`)
                      .join("；")}
                  </p>
                  {point.warnings.map((w, i) => (
                    <p key={i}>{w}</p>
                  ))}
                </div>
              ),
            },
          ]}
        />
        <h4 className="font-medium">因缺行情无法分析</h4>
        <ReviewDisclosure
          label={`缺行情明细，共 ${data.missingMarketData.length} 项`}
        >
          {data.missingMarketData.length ? (
            data.missingMarketData.map((row) => (
              <p key={row.security}>
                {row.security}：{row.details.join("；")}
              </p>
            ))
          ) : (
            <p>无缺行情标的。</p>
          )}
        </ReviewDisclosure>
      </section>
      <section className="space-y-3">
        <h3 className="text-lg font-semibold">资金曲线与风险</h3>
        <NavCurve days={nav.days} />
        <p>TWR：{metric(nav.twr, true)}</p>
        <ReviewDiagnostics rows={nav.twr.reasons} />
        <p>
          实际使用的交易日数：{nav.usedTradingDays}；每日收益观察数：
          {nav.usedReturnObservations}；年化因子：{nav.basis.annualization}
          ；无风险年利率：{(nav.basis.annualRiskFreeRate * 100).toFixed(2)}%。
        </p>
        {nav.skippedIntervals.length > 0 && (
          <div role="note" className="rounded-lg border p-3">
            <p className="font-semibold">
              净值/收益中断：全区间夏普、最大回撤、Sortino、Calmar
              不可得；以下仅展示连续段结果。
            </p>
            <ReviewDisclosure
              label={`净值/收益中断区间，共 ${nav.skippedIntervals.length} 段`}
            >
              {nav.skippedIntervals.map((gap, i) => (
                <p key={i}>
                  {gap.start} — {gap.end}：{gap.reason}
                </p>
              ))}
            </ReviewDisclosure>
          </div>
        )}
        {!nav.segments.length && (
          <p>最大回撤、夏普、Sortino、Calmar 不可得：没有连续有效净值段。</p>
        )}
        <ReviewDisclosure
          preview={1}
          label={`连续段风险指标（最大回撤、夏普、Sortino、Calmar），共 ${nav.segments.length} 段`}
        >
          {nav.segments.map((segment, i) => (
            <Card key={i}>
              <CardHeader>
                <CardTitle>
                  {segment.start} — {segment.end} · {segment.tradingDays}{" "}
                  个交易日 / {segment.returnObservations} 个收益观察
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p>分段 TWR：{metric(segment.totalReturn, true)}</p>
                <p>
                  最大回撤：{metric(segment.maxDrawdown, true)} · 夏普：
                  {metric(segment.sharpe)} · Sortino：{metric(segment.sortino)}{" "}
                  · Calmar：{metric(segment.calmar)}
                </p>
                <h4 className="font-medium">回撤区间明细</h4>
                <ReviewDisclosure
                  label={`回撤区间，共 ${segment.drawdowns.length} 段`}
                >
                  {segment.drawdowns.length ? (
                    segment.drawdowns.map((drawdown, j) => (
                      <p key={j}>
                        峰值日 {drawdown.peakDate} · 谷底日{" "}
                        {drawdown.troughDate} · 恢复日{" "}
                        {drawdown.recoveryDate ?? "尚未恢复"} · 回撤{" "}
                        {(drawdown.drawdown * 100).toFixed(2)}% · 水下{" "}
                        {drawdown.underwaterTradingDays} 个交易日
                      </p>
                    ))
                  ) : (
                    <p>该连续段没有回撤区间。</p>
                  )}
                </ReviewDisclosure>
              </CardContent>
            </Card>
          ))}
        </ReviewDisclosure>
        <h4 className="font-medium">月度收益表</h4>
        <DataTable
          label="月度收益"
          data={nav.monthlyReturns}
          rowCount={data.monthCount}
          pagination={monthPagination}
          onPaginationChange={onMonthPaginationChange}
          sorting={[]}
          onSortingChange={() => {}}
          getRowId={(row) => row.month}
          loading={loading}
          columns={[
            { accessorKey: "month", header: "月份", enableSorting: false },
            {
              accessorKey: "tradingDays",
              header: "交易日数",
              enableSorting: false,
            },
            {
              accessorKey: "return",
              header: "月度收益率",
              enableSorting: false,
              cell: (cell) => (
                <>
                  <p>{metric(cell.row.original.return, true)}</p>
                  <ReviewDisclosure label="月度收益原因">
                    <ReviewDiagnostics
                      rows={cell.row.original.return.reasons}
                    />
                  </ReviewDisclosure>
                </>
              ),
            },
          ]}
        />
        <ReviewDisclosure
          label={`每日资金与净值明细，共 ${nav.days.length} 天`}
        >
          {nav.days.map((day) => (
            <p key={day.date}>
              {day.date} · 现金 {metric(day.cash)} · 市值{" "}
              {metric(day.marketValue)} · 净值 {metric(day.nav)} · 日收益{" "}
              {metric(day.dailyReturn, true)}
            </p>
          ))}
        </ReviewDisclosure>
        <ReviewDisclosure label={`净值诊断，共 ${nav.warnings.length} 条`}>
          {nav.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </ReviewDisclosure>
      </section>
      <section className="space-y-3">
        <h3 className="text-lg font-semibold">
          归因 · {method === "fifo" ? "FIFO" : "移动加权"}
        </h3>
        <p className="font-medium">分组是描述性的，不代表因果。</p>
        <DataTable
          label="归因分组"
          data={data.attribution}
          rowCount={data.attributionCount}
          {...attributionTable}
          loading={loading}
          getRowId={(row) => row.id}
          columns={[
            {
              accessorKey: "dimension",
              header: "分组维度",
              cell: (c) =>
                dimensions[c.row.original.dimension] ??
                c.row.original.dimension,
            },
            { accessorKey: "name", header: "分组" },
            { accessorKey: "sampleCount", header: "有效样本" },
            {
              accessorKey: "netProfitTotal",
              header: "净收益合计",
              cell: (c) =>
                c.row.original.netProfitTotal?.toFixed(2) ??
                "不可得：无有效已平仓收益样本",
            },
            {
              id: "note",
              header: "样本说明",
              enableSorting: false,
              cell: (c) => (
                <>
                  {c.row.original.sampleNote} {c.row.original.warning}
                </>
              ),
            },
          ]}
        />
      </section>
      <section className="space-y-2">
        <h3 className="text-lg font-semibold">诊断与待核对证据</h3>
        <ReviewDisclosure
          label={`诊断与待核对，共 ${data.warnings.length + data.exceptions.length + data.pendingRows.length} 条`}
        >
          {data.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
          {data.exceptions.map((row, i) => (
            <p key={i}>
              第 {row.fill.rowIndex} 行 · {row.reason}
            </p>
          ))}
          {data.pendingRows.map((row, i) => (
            <p key={i}>
              第 {row.rowIndex} 行 · {row.reason}
            </p>
          ))}
          {!data.warnings.length &&
            !data.exceptions.length &&
            !data.pendingRows.length && <p>无额外诊断。</p>}
        </ReviewDisclosure>
      </section>
    </div>
  );
}
