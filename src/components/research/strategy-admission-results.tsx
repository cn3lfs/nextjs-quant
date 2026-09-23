"use client";

import type { RouterOutputs } from "~/trpc/react";
import type { ReviewValue } from "~/lib/portfolio/trade-review";
import { admissionConclusion } from "~/lib/strategy-facts/strategy-admission";
import {
  DataTable,
  type DataTableColumn,
  type DataTableProps,
} from "../ui/data-table";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";

export type AdmissionData = RouterOutputs["tradeReviewAdmission"];
type Year = AdmissionData["yearly"]["rows"][number];
const show = (v: ReviewValue) =>
  v.value === null
    ? `不可得：${v.reason}`
    : v.value.toLocaleString("zh-CN", { maximumFractionDigits: 6 });
const passed = (value: boolean) => (value ? "满足" : "未满足");
const columns: DataTableColumn<Year>[] = [
  { accessorKey: "year", header: "年份" },
  { accessorKey: "tradingDays", header: "交易日数" },
  {
    id: "isCompleteYear",
    header: "完整年",
    enableSorting: false,
    cell: ({ row }) => (row.original.isCompleteYear ? "是" : "否"),
  },
  ...(
    [
      ["absReturn", "绝对收益"],
      ["alphaReturn", "超额收益"],
      ["alphaMaxDrawdown", "超额最大回撤（绝对差）"],
    ] as const
  ).map(([key, header]) => ({
    id: key,
    header,
    cell: ({ row }: { row: { original: Year } }) => show(row.original[key]),
  })),
  ...(
    [
      ["condAbsReturnPassed", "绝对收益 > 0"],
      ["condAlphaReturnPassed", "超额收益 > 0"],
      ["condAlphaDrawdownPassed", "超额回撤 < 阈值"],
      ["yearPassed", "年度三选一"],
    ] as const
  ).map(([key, header]) => ({
    id: key,
    header,
    enableSorting: false,
    cell: ({ row }: { row: { original: Year } }) => passed(row.original[key]),
  })),
];
function Facts({ items }: { items: [string, string][] }) {
  return (
    <dl className="grid gap-3 md:grid-cols-3">
      {items.map(([label, value]) => (
        <div
          key={label}
          className="rounded-lg border border-border bg-card p-3"
        >
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="break-words font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function StrategyAdmissionResults({
  data,
  table,
}: {
  data: AdmissionData;
  table: Pick<
    DataTableProps<Year>,
    | "pagination"
    | "sorting"
    | "onPaginationChange"
    | "onSortingChange"
    | "loading"
  >;
}) {
  const h = data.history,
    r = data.recent;
  return (
    <Card>
      <CardHeader>
        <CardTitle>准入判定</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p>{data.thresholdSource}</p>
        <p className="text-sm text-muted-foreground">
          判定口径为单利，与页面净值曲线的复利口径不同。basis={h.basis}；rf=
          {h.annualRiskFreeRate}；年化因子 {h.params.yearlyDays}
          。收益为小数，回撤为单利累计收益绝对差。
        </p>
        <p className="text-sm text-muted-foreground">{data.note}</p>
        <p className="text-base font-medium">
          history：{admissionConclusion(h)} · 数据可信度：{h.evidenceLevel}
        </p>
        {h.evidenceLevel !== "真实账户交割单" && (
          <p>
            输入不是真实账户交割单，结论只在该数据前提下成立，不能当作账户业绩判定。
          </p>
        )}
        <Facts
          items={[
            ["完整自然年数", String(h.completeYearCount)],
            ["全样本超额最大回撤", show(h.historyAlphaMaxDrawdown)],
            ["全样本超额 Sharpe", show(h.historyAlphaSharpe)],
            ["condYearsPassed · 全部完整年三选一", passed(h.condYearsPassed)],
            [
              "condAlphaDrawdownPassed · 全样本回撤 ≤ 阈值",
              passed(h.condAlphaDrawdownPassed),
            ],
            [
              "condSharpePassed · 全样本 Sharpe > 阈值",
              passed(h.condSharpePassed),
            ],
            ["多头年化波动率", show(h.longAnnualVolatility)],
            ["基准年化波动率", show(h.benchAnnualVolatility)],
            [
              "alphaDegenerate",
              h.alphaDegenerate ? "是（超额指标留空）" : "否",
            ],
            [
              "多头 / 基准全样本缩放",
              `${show(h.longScale)} / ${show(h.benchScale)}`,
            ],
            ["longIsStrategy", h.longIsStrategy ? "是" : "否"],
            [
              "观察 / 策略缺失 / 多头缺失 / 基准缺失日数",
              `${h.coverage.observedDays} / ${h.coverage.strategyMissingDays} / ${h.coverage.longMissingDays} / ${h.coverage.benchMissingDays}`,
            ],
          ]}
        />
        <ul aria-label="history 条件未满足原因">
          {h.reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
        <DataTable
          label="准入年度分指标"
          data={data.yearly.rows}
          columns={columns}
          rowCount={data.yearly.rowCount}
          {...table}
          getRowId={(row) => row.year}
        />
        {r && (
          <section className="space-y-3" aria-label="recent 准入分指标">
            <p className="text-base font-medium">
              recent：{admissionConclusion(r)} · 数据可信度：{r.evidenceLevel}
            </p>
            <Facts
              items={[
                [
                  "近期起止与实际日数",
                  `${r.recentStartDate ?? "无"} 至 ${r.recentEndDate ?? "无"} / ${r.recentActualDays} 日`,
                ],
                ["近期绝对收益", show(r.recentAbsReturn)],
                ["近期超额收益", show(r.recentAlphaReturn)],
                ["近期超额最大回撤", show(r.recentAlphaMaxDrawdown)],
                [
                  "剔除近期后的历史超额最大回撤",
                  show(r.historyAlphaMaxDrawdownExclRecent),
                ],
                ["historyWindowEmpty", r.historyWindowEmpty ? "是" : "否"],
                [
                  "condAbsReturnPassed · 绝对收益 > 0",
                  passed(r.condAbsReturnPassed),
                ],
                [
                  "condAlphaReturnPassed · 超额收益 > 0",
                  passed(r.condAlphaReturnPassed),
                ],
                [
                  "condAlphaDrawdownPassed · 回撤 < 阈值",
                  passed(r.condAlphaDrawdownPassed),
                ],
                ["condReturnPassed · 近期三选一", passed(r.condReturnPassed)],
                [
                  "condImprovementPassed · 近期回撤严格小于历史",
                  passed(r.condImprovementPassed),
                ],
              ]}
            />
            <ul aria-label="recent 条件未满足原因">
              {r.reasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          </section>
        )}
        <details>
          <summary>本次判定全部参数（完整回显）</summary>
          <pre className="overflow-auto text-sm">
            {JSON.stringify(h.params, null, 2)}
          </pre>
        </details>
      </CardContent>
    </Card>
  );
}
