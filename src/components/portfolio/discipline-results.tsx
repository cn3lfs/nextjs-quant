import {
  disciplineNotice,
  disciplineScope,
} from "~/lib/discipline-counterfactual";
import type { disciplineStatus } from "~/server/portfolio/discipline-service";
import { DataTable, type DataTableColumn } from "../ui/data-table";

export type DisciplinePage = ReturnType<typeof disciplineStatus>;
type Point = NonNullable<DisciplinePage["result"]>["points"][number];
const number = (n: number | null) => (n === null ? "不可得" : n.toFixed(2));
const percent = (n: number | null) =>
  n === null ? "不可得" : `${(n * 100).toFixed(2)}%`;
const columns: DataTableColumn<Point>[] = [
  {
    id: "maxAddOns",
    header: "加仓上限",
    accessorFn: (p) => p.rules.maxAddOns ?? "不限",
    enableSorting: false,
  },
  {
    id: "stopLossPct",
    header: "止损线",
    accessorFn: (p) =>
      p.rules.stopLossPct === null ? "不启用" : percent(p.rules.stopLossPct),
    enableSorting: false,
  },
  {
    id: "netProfit",
    header: "回合净盈亏（元）",
    accessorFn: (p) => number(p.netProfit),
    enableSorting: false,
  },
  { accessorKey: "roundCount", header: "回合数", enableSorting: false },
  {
    id: "winRate",
    header: "胜率",
    accessorFn: (p) => percent(p.winRate),
    enableSorting: false,
  },
  {
    id: "payoffRatio",
    header: "盈亏比（收益率）",
    accessorFn: (p) => number(p.payoffRatio),
    enableSorting: false,
  },
  {
    id: "profitFactor",
    header: "利润因子（金额）",
    accessorFn: (p) => number(p.profitFactor),
    enableSorting: false,
  },
  {
    id: "maxDrawdown",
    header: "最大回撤（TWR）",
    accessorFn: (p) =>
      p.maxDrawdown.value === null
        ? `不可得：${p.maxDrawdown.reason}`
        : percent(p.maxDrawdown.value),
    enableSorting: false,
  },
  { accessorKey: "stoppedRounds", header: "止损回合", enableSorting: false },
  {
    accessorKey: "skippedRounds",
    header: "资金不足未发生",
    enableSorting: false,
  },
  {
    accessorKey: "excludedCrossed",
    header: "跨除权退出统计",
    enableSorting: false,
  },
  {
    accessorKey: "excludedUnknown",
    header: "未知退出统计",
    enableSorting: false,
  },
];
export function DisciplineResults({ data }: { data: DisciplinePage }) {
  const r = data.result;
  return (
    <div className="space-y-3 text-sm">
      <p>{disciplineNotice}</p>
      <p>{disciplineScope}</p>
      {data.error && <p role="alert">{data.error}</p>}
      {r && (
        <>
          <p>
            A 口径正确性：{r.checks.a.count} 回合，
            {number(r.checks.a.netProfit)} 元；校验
            {r.checks.a.passed ? "通过" : "失败"}。
          </p>
          <p>
            B 可比基线：{r.checks.b.count} 回合，{number(r.checks.b.netProfit)}{" "}
            元；校验{r.checks.b.passed ? "通过" : "失败"}。跨除权退出统计{" "}
            {r.excludedCrossed}，未知 {r.excludedUnknown}；现金流原样保留。
          </p>
          <p>
            GBBQ 覆盖截止日 {r.coverageEnd}；期初现金 {number(r.openingCash)}{" "}
            元。
          </p>
          <p>
            新增止损实验费用：佣金 {r.stopCosts.commissionBps} BP，最低{" "}
            {r.stopCosts.minimumCommission} 元，股票卖出税{" "}
            {r.stopCosts.sellTaxBps} BP。不是历史费率证明。
          </p>
          <p className="text-muted-foreground">{r.basis}</p>
          <p role="status">
            V5 记账：
            {data.usageRecorded
              ? "已记录 20 个候选"
              : "写入失败，本次运行可能未记录"}
            。
          </p>
          <DataTable
            columns={columns}
            data={r.points}
            rowCount={20}
            pagination={{ pageIndex: 0, pageSize: 20 }}
            sorting={[]}
            onPaginationChange={() => {}}
            onSortingChange={() => {}}
            getRowId={(p) => `${p.rules.maxAddOns}:${p.rules.stopLossPct}`}
            label="纪律反事实全部 20 点"
            showPagination={false}
          />
          {data.warnings.length > 0 && (
            <details>
              <summary>数据缺口（{data.warnings.length}）</summary>
              {data.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </details>
          )}
        </>
      )}
    </div>
  );
}
