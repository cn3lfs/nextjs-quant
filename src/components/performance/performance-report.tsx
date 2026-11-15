"use client";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { useEffect, useRef } from "react";
import type {
  PerformanceEvaluation,
  PerformanceMetric,
  PerformanceFrequency,
  PerformancePeriod,
  PerformanceReportPage,
} from "quant-performance";
import { Button } from "../ui/button";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

export type PerformanceReportData = PerformanceReportPage;
const labels = { year: "年度", quarter: "季度", month: "月度" } as const;
const percent = (value: number) =>
  `${value > 0 ? "+" : ""}${displayNumber(value * 100, 2)}%`;
const tone = (value: number | null) =>
  value === null || value === 0
    ? "text-nc-text"
    : value > 0
      ? "text-nc-up"
      : "text-nc-down";

function Metric({
  label,
  data,
  unit = "ratio",
  directional = false,
  note,
}: {
  label: string;
  data: PerformanceMetric;
  unit?: "percent" | "drawdown" | "ratio" | "days" | "money" | "rate";
  directional?: boolean;
  note: string;
}) {
  const value =
    data.value === null
      ? "—"
      : unit === "percent"
        ? percent(data.value)
        : unit === "drawdown" || unit === "rate"
          ? `${displayNumber(data.value * 100, 2)}%`
          : unit === "days"
            ? `${data.value} 天`
            : unit === "money"
              ? `${data.value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 元`
              : displayNumber(data.value, 2);
  return (
    <div className="min-w-0 rounded-lg border border-nc-border-soft bg-nc-inset p-3">
      <dt className="text-xs text-nc-text-3">{label}</dt>
      <dd
        className={`mt-2 text-xl font-semibold tabular-nums ${directional ? tone(data.value) : ""}`}
      >
        {value}
      </dd>
      <dd className="mt-2 break-words text-xs text-nc-text-3">
        {data.reason ?? note}
      </dd>
    </div>
  );
}

function RecoveryDetails({
  evaluation,
}: {
  evaluation: PerformanceEvaluation;
}) {
  const episode = evaluation.maxDrawdownEpisode;
  return (
    <div className="space-y-3 rounded-lg border border-nc-border-soft p-3">
      <h5 className="text-sm font-medium">最大回撤与修复轨迹</h5>
      {episode ? (
        <dl className="grid gap-3 text-sm lg:grid-cols-2 xl:grid-cols-4">
          <div>
            <dt className="text-xs text-nc-text-3">此前峰值日</dt>
            <dd className="mt-1 tabular-nums">{episode.peakDate}</dd>
          </div>
          <div>
            <dt className="text-xs text-nc-text-3">谷底日 / 回撤幅度</dt>
            <dd className="mt-1 tabular-nums">
              {episode.valleyDate} / {displayNumber(episode.depth * 100, 2)}%
            </dd>
          </div>
          <div>
            <dt className="text-xs text-nc-text-3">首次修复日</dt>
            <dd className="mt-1 tabular-nums">
              {episode.recoveryDate ?? "截至本期末未修复"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-nc-text-3">谷底至修复（自然日）</dt>
            <dd className="mt-1 tabular-nums">
              {episode.recoveryDays === null
                ? `未修复，已观察${episode.observedRecoveryDays}天`
                : `${episode.recoveryDays}天`}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-sm text-nc-text-3">
          {evaluation.days
            ? "本期没有回撤，修复时间不适用。"
            : "没有日收盘净值。"}
        </p>
      )}
      <p className="text-xs leading-relaxed text-nc-text-3">
        修复只观察到本期末，不引用未来数据。分期回撤从本期期初重新计算；全程跨月、跨季度的风险请看上方全程指标。
      </p>
    </div>
  );
}

export function PerformanceReport({
  data,
  frequency,
  period,
  onFrequency,
  onYear,
  onPeriod,
}: {
  data: PerformanceReportData;
  frequency: PerformanceFrequency;
  period?: string;
  onFrequency: (value: PerformanceFrequency) => void;
  onYear: (value: number) => void;
  onPeriod: (value: string, frequency?: PerformanceFrequency) => void;
}) {
  const o = data.overview;
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (data.selected) detailRef.current?.focus();
  }, [data.selected?.key]);
  const columns: DataTableColumn<PerformancePeriod>[] = [
    {
      id: "period",
      header: "期间",
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {row.original.key}
          {row.original.boundary && (
            <span className="ml-1 text-xs text-nc-text-3">窗口边界</span>
          )}
        </span>
      ),
    },
    ...(
      [
        ["totalReturn", "策略收益"],
        ["benchmarkReturn", "价格持有对照"],
        ["excessReturn", "相差百分点"],
        ["maxDrawdown", "最大回撤"],
      ] as const
    ).map(([id, header]) => ({
      id,
      header,
      cell: ({ row }: { row: { original: PerformancePeriod } }) => {
        const m = row.original.evaluation[id];
        return (
          <span
            title={m.reason ?? undefined}
            className={`whitespace-nowrap tabular-nums ${id === "maxDrawdown" ? "text-nc-text" : tone(m.value)}`}
          >
            {m.value === null
              ? "—"
              : id === "excessReturn"
                ? `${displayNumber(m.value * 100, 2)} 个百分点`
                : id === "maxDrawdown"
                  ? `${displayNumber(m.value * 100, 2)}%`
                  : percent(m.value)}
          </span>
        );
      },
    })),
    ...(
      [
        ["sharpe", "夏普"],
        ["informationRatio", "信息比率"],
      ] as const
    ).map(([id, header]) => ({
      id,
      header,
      cell: ({ row }: { row: { original: PerformancePeriod } }) => (
        <span
          title={row.original.evaluation[id].reason ?? "日频年化；短样本仅描述"}
          className="tabular-nums"
        >
          {displayNumber(row.original.evaluation[id].value, 2) ?? "—"}
        </span>
      ),
    })),
    {
      id: "days",
      header: "交易日",
      cell: ({ row }) => row.original.evaluation.days,
    },
    {
      id: "open",
      header: "详情",
      cell: ({ row }) => (
        <Button
          variant={period === row.original.key ? "default" : "outline"}
          className="min-h-10"
          aria-label={`查看 ${row.original.key}`}
          aria-pressed={period === row.original.key}
          onClick={() => onPeriod(row.original.key)}
        >
          {period === row.original.key ? "已选中" : "查看"}
        </Button>
      ),
    },
  ];
  return (
    <div className="min-w-0 space-y-4" aria-label="绩效评价内容">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-nc-text-3">
        <span>
          全程评价 · {o.start ?? "无样本"} 至 {o.end ?? "—"} · {o.days} 个交易日
        </span>
        <span className="text-nc-warn">规则自检，不代表可信策略业绩</span>
      </div>
      <dl className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="区间收益"
          directional
          data={o.totalReturn}
          unit="percent"
          note="日收盘权益，已扣实验费用"
        />
        <Metric
          label="年化复合收益"
          directional
          data={o.annualReturn}
          unit="percent"
          note="252个交易日复利年化"
        />
        <Metric
          label="夏普比率"
          data={o.sharpe}
          note="相对2%无风险假设的风险收益效率"
        />
        <Metric
          label="信息比率"
          data={o.informationRatio}
          note="相对同标的价格持有对照"
        />
        <Metric
          label="日收盘最大回撤"
          data={o.maxDrawdown}
          unit="drawdown"
          note="包含期初本金的最大损失幅度"
        />
        <Metric
          label="Calmar 比率"
          data={o.calmar}
          note="年化复合收益 / 最大回撤"
        />
        <Metric
          label="最大回撤修复天数"
          data={o.recoveryDays}
          unit="days"
          note="最大回撤谷底至恢复前高，自然日"
        />
        <Metric
          label="最长水下期"
          data={o.longestUnderwaterDays}
          unit="days"
          note="此前峰值至修复或截至期末，自然日"
        />
      </dl>
      {data.trades ? (
        <section
          aria-label="全程交易轮次评价"
          className="space-y-3 rounded-lg border border-nc-border-soft p-3"
        >
          <h4 className="text-sm font-medium">全程交易轮次评价</h4>
          <p className="text-xs text-nc-text-3">
            已闭合 {data.trades.closedTrades} 轮：盈利{" "}
            {data.trades.winningTrades}、亏损 {data.trades.losingTrades}、持平{" "}
            {data.trades.flatTrades}；未平仓 {data.trades.openTrades}{" "}
            轮不计胜率。
          </p>
          <dl className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            <Metric
              label="平均盈利额"
              data={data.trades.averageWin}
              unit="money"
              note="盈利闭合轮次净损益均值"
            />
            <Metric
              label="平均亏损额（绝对值）"
              data={data.trades.averageLoss}
              unit="money"
              note="亏损闭合轮次损失绝对值均值"
            />
            <Metric
              label="交易盈亏比"
              data={data.trades.payoffRatio}
              note="平均盈利额 / 平均亏损额"
            />
            <Metric
              label="交易胜率"
              data={data.trades.winRate}
              unit="rate"
              note="盈利轮次 / 全部已闭合轮次（含持平）"
            />
            <Metric
              label="利润因子"
              data={data.trades.profitFactor}
              note="总盈利 / 总亏损绝对值；不同于盈亏比"
            />
            <Metric
              label="每轮平均净损益"
              data={data.trades.expectancy}
              unit="money"
              directional
              note="全部已闭合轮次净损益均值"
            />
          </dl>
          <p className="text-xs text-nc-text-3">
            同一股票从建仓到清仓算一轮，加减仓合并，含模型已记费用与现金分配；金额不是单笔收益率。未平仓及部分止盈不会独立计为胜笔；不是逐买单FIFO配对。
          </p>
        </section>
      ) : (
        <p className="text-xs text-nc-text-3">
          未提供配对交易数据，交易胜率与盈亏比不可用。
        </p>
      )}
      <p
        className="rounded-lg border border-nc-border-soft p-3 text-sm leading-relaxed"
        role="status"
      >
        净收益{" "}
        {o.totalReturn.value === null
          ? "不可计算"
          : percent(o.totalReturn.value)}
        ；相对价格持有对照{" "}
        {o.excessReturn.value === null
          ? "缺少完整样本"
          : `${o.excessReturn.value >= 0 ? "领先" : "落后"} ${displayNumber(Math.abs(o.excessReturn.value * 100), 2)} 个百分点`}
        。{o.shortSample && "不足252个交易日，风险比率仅作短样本描述。"}{" "}
        本结果尚未证明样本外有效性。
      </p>
      <details className="rounded-lg border border-nc-border-soft p-3 text-sm">
        <summary className="cursor-pointer text-nc-accent-light">
          指标说明与计算口径
        </summary>
        <div className="mt-3 space-y-2 leading-relaxed text-nc-text-2">
          <p>
            日收盘净值、252交易日年化、样本标准差（N−1）。无风险收益统一假设年化2%，日利率为
            (1.02)^(1/252)−1，不向现金虚记利息。
          </p>
          <p>
            夏普＝日超额收益均值/样本标准差×√252；信息比率＝每日策略与对照收益之差的均值/样本标准差×√252。年化复合收益＝(期末/期初)^(252/交易日数)−1；Calmar＝年化复合收益/最大回撤。
          </p>
          <p>
            同标的价格持有对照从首个研究日开盘起算，不含费用、分红，既不是市场基准，也不是Alpha。回撤仅采用日收盘估值，与概览中的五分钟回撤分开。不足一年不展示年化复合收益和Calmar，零分母留空并说明。
          </p>
          <p>
            索提诺＝日超额收益均值×√252/下行偏差；下行偏差＝√(全部样本下超额负收益平方和/N)。月季收益复利衔接，不加总百分比。窗口边界仅标研究首尾覆盖，不能据有限日历认证完整自然期。
          </p>
          <dl className="grid gap-3 lg:grid-cols-3">
            <Metric
              label="索提诺比率"
              data={o.sortino}
              note="只惩罚低于目标的日收益"
            />
            <Metric
              label="年化波动率"
              data={o.annualVolatility}
              unit="percent"
              note="日样本标准差×√252"
            />
            <Metric
              label="跟踪误差"
              data={o.trackingError}
              unit="percent"
              note="日主动收益样本标准差×√252"
            />
          </dl>
          <RecoveryDetails evaluation={o} />
        </div>
      </details>
      <section
        className="min-w-0 space-y-4 rounded-lg border border-nc-border-soft p-3"
        aria-label="分期复盘"
      >
        <div className="flex flex-wrap items-center gap-3">
          <h4 className="text-sm font-medium">分期复盘</h4>
          <div className="flex flex-wrap gap-1" aria-label="评价频率">
            {(["year", "quarter", "month"] as const).map((f) => (
              <Button
                key={f}
                variant={frequency === f ? "default" : "outline"}
                className="min-h-10"
                aria-pressed={frequency === f}
                onClick={() => onFrequency(f)}
              >
                {labels[f]}
              </Button>
            ))}
          </div>
          <Select
            value={data.year === null ? undefined : String(data.year)}
            onValueChange={(value) => onYear(Number(value))}
          >
            <SelectTrigger aria-label="评价年份" className="min-h-10 w-32">
              <SelectValue placeholder="无年份" />
            </SelectTrigger>
            <SelectContent>
              {data.years.map((year) => (
                <SelectItem key={year} value={String(year)}>
                  {year} 年
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-nc-text-3">
          点击月份查看月度详情 · 正收益红 / 负收益绿 · 无样本为 —
        </p>
        <div
          className="grid grid-cols-3 gap-2 lg:grid-cols-4 xl:grid-cols-6"
          aria-label="月度收益热力图"
        >
          {Array.from({ length: 12 }, (_, i) => {
            const key = `${data.year}-${String(i + 1).padStart(2, "0")}`;
            const month = data.months.find((m) => m.key === key);
            return (
              <Button
                key={key}
                variant="outline"
                disabled={!month}
                aria-label={`${key} ${month?.value === undefined || month.value === null ? "无样本" : percent(month.value)}`}
                aria-pressed={period === key}
                className={`h-auto min-h-14 flex-col gap-1 ${month?.value ? (month.value > 0 ? "bg-nc-up/10" : "bg-nc-down/10") : ""}`}
                onClick={() => onPeriod(key, "month")}
              >
                <span className="text-xs text-nc-text-3">{i + 1}月</span>
                <span className={`tabular-nums ${tone(month?.value ?? null)}`}>
                  {month?.value === undefined || month.value === null
                    ? "—"
                    : percent(month.value)}
                </span>
              </Button>
            );
          })}
        </div>
        <p className="text-xs text-nc-warn">
          年、季、月各期均从本期期初重新计算回撤。月季样本较短，夏普与信息比率仅描述本期，不据此评级。
        </p>
        <DataTable
          columns={columns}
          data={data.periods}
          rowCount={data.periods.length}
          pagination={{ pageIndex: 0, pageSize: 12 }}
          sorting={[]}
          onPaginationChange={() => {}}
          onSortingChange={() => {}}
          getRowId={(row) => row.key}
          label={`${labels[frequency]}评价明细`}
          showPagination={false}
          emptyMessage="所选年份没有评价样本。"
        />
        {data.selected ? (
          <section
            aria-label="选中期间详情"
            tabIndex={-1}
            ref={detailRef}
            className="space-y-3 rounded-lg border border-nc-accent-700 p-3"
          >
            <h4 className="font-medium text-nc-accent-light">
              {data.selected.key} · {labels[frequency]}详情
            </h4>
            <p className="text-xs tabular-nums text-nc-text-3">
              {data.selected.evaluation.start} 至 {data.selected.evaluation.end}{" "}
              · {data.selected.evaluation.days} 个交易日 · 期初权益{" "}
              {data.selected.evaluation.initial.toLocaleString("zh-CN", {
                maximumFractionDigits: 2,
              })}{" "}
              元
            </p>
            {data.selected.boundary && (
              <p className="text-xs text-nc-warn">
                窗口边界：仅覆盖上述实际日期。
              </p>
            )}
            <dl className="grid gap-3 lg:grid-cols-3">
              <Metric
                label="本期策略收益"
                directional
                data={data.selected.evaluation.totalReturn}
                unit="percent"
                note="承接上期期末权益"
              />
              <Metric
                label="本期价格持有对照"
                directional
                data={data.selected.evaluation.benchmarkReturn}
                unit="percent"
                note="同一日历、同一期初"
              />
              <Metric
                label="本期最大回撤"
                data={data.selected.evaluation.maxDrawdown}
                unit="drawdown"
                note="从本期期初重新建峰"
              />
            </dl>
            <RecoveryDetails evaluation={data.selected.evaluation} />
          </section>
        ) : (
          <p className="text-sm text-nc-text-3">
            选择一行“查看”或点击月份，阅读该期收益与回撤修复详情。
          </p>
        )}
      </section>
    </div>
  );
}
