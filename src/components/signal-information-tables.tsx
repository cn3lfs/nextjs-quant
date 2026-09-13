"use client";
import { DataTable } from "~/components/ui/data-table";
import type { SignalInformation } from "~/lib/signal-information";
export type SignalInformationDisplay = {
  groups: (Omit<SignalInformation["groups"][number], "daily"> & {
    sectionReasons: Record<string, number>;
  })[];
  decay: SignalInformation["decay"];
};
const number = (n: number | null) => (n === null ? "—" : n.toFixed(4));
const percent = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)}%`);
function DisplayTable({
  label,
  headers,
  rows,
}: {
  label: string;
  headers: string[];
  rows: string[][];
}) {
  return (
    <DataTable<{ id: string; values: string[] }>
      label={label}
      data={rows.map((values, id) => ({ id: String(id), values }))}
      columns={headers.map((header, i) => ({
        id: String(i),
        header,
        enableSorting: false,
        cell: ({ row }) => row.original.values[i],
      }))}
      getRowId={(r) => r.id}
      rowCount={rows.length}
      pagination={{ pageIndex: 0, pageSize: Math.max(1, rows.length) }}
      sorting={[]}
      onPaginationChange={() => {}}
      onSortingChange={() => {}}
      showPagination={false}
    />
  );
}
export function SignalInformationTables({
  groups,
  decay,
}: SignalInformationDisplay) {
  return (
    <div className="space-y-4">
      <DisplayTable
        label="IC汇总"
        headers={[
          "期限",
          "IC均值",
          "IC标准差(ddof=1)",
          "ICIR",
          "t值",
          "正IC占比",
          "有效/总截面",
          "说明",
        ]}
        rows={groups.map((g) => [
          `T+${g.horizon}`,
          number(g.icMean),
          number(g.icStd),
          number(g.icir),
          number(g.icTStat),
          percent(g.positiveRatio === null ? null : g.positiveRatio * 100),
          `${g.sections.valid}/${g.sections.total}`,
          g.reasons.join("；") || "—",
        ])}
      />
      <DisplayTable
        label="评分分层"
        headers={[
          "期限",
          "分组",
          "条数",
          "均值收益",
          "中位收益",
          "胜率",
          "评分范围",
          "说明",
        ]}
        rows={groups.flatMap((g) =>
          g.stratification.groups.length
            ? g.stratification.groups.map((s) => [
                `T+${g.horizon}`,
                `Q${s.quantile}/${g.stratification.q}`,
                String(s.count),
                percent(s.meanReturn),
                percent(s.medianReturn),
                percent(s.winRate),
                s.scoreRange?.join("～") ?? "—",
                s.reason ?? "—",
              ])
            : [
                [
                  `T+${g.horizon}`,
                  `Q=${g.stratification.q}`,
                  "—",
                  "—",
                  "—",
                  "—",
                  "—",
                  g.stratification.reason ?? "—",
                ],
              ],
        )}
      />
      {groups.map((g) => (
        <p key={g.horizon}>
          T+{g.horizon}：请求 Q={g.stratification.requestedQ}，实际 Q=
          {g.stratification.q}；并列跨界：
          {g.stratification.tiedBoundary ? "是，整体归低组" : "否"}；单调性{" "}
          {number(g.stratification.monotonicity)}；最高减最低{" "}
          {percent(g.stratification.topMinusBottom)}；
          {g.stratification.reason ?? "分层按全部可用样本的分位数"}
        </p>
      ))}
      <DisplayTable
        label="持有期衰减三点"
        headers={["期限", "IC均值", "最高减最低"]}
        rows={decay.flatMap((d) =>
          d.decay.map((p) => [
            `T+${p.horizon}`,
            number(p.icMean),
            percent(p.topMinusBottom),
          ]),
        )}
      />
      <DisplayTable
        label="排除计数与原因"
        headers={[
          "期限",
          "原始/参与/排除",
          "重复",
          "未到期",
          "收益为空",
          "含除权",
          "等待回填",
          "非有限数",
          "空收益原因分布",
          "截面留空原因",
        ]}
        rows={groups.map((g) => [
          `T+${g.horizon}`,
          `${g.samples}/${g.valid}/${g.excluded}`,
          String(g.exclusions.duplicate),
          String(g.exclusions.unsettled),
          String(g.exclusions.nullReturn),
          String(g.exclusions.corporateAction),
          String(g.exclusions.missingOutcome),
          String(g.exclusions.nonFinite),
          Object.entries(g.exclusions.reasons)
            .map(([r, n]) => `${r}：${n}`)
            .join("；") || "—",
          Object.entries(g.sectionReasons)
            .map(([r, n]) => `${r}：${n}`)
            .join("；") || "—",
        ])}
      />
    </div>
  );
}
