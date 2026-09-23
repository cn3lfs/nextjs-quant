"use client";
import type { keyTrades, KeyTrade, KeyTradeRanking } from "~/lib/key-trades";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../ui/collapsible";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

type Row = KeyTrade & { side: string; rank: number };
const columns: DataTableColumn<Row>[] = [
  { accessorKey: "side", header: "头尾" },
  { accessorKey: "rank", header: "名次" },
  { accessorKey: "security", header: "证券" },
  {
    id: "opening",
    header: "开仓日",
    cell: (c: { row: { original: Row } }) =>
      c.row.original.openingDate ?? "未知",
  },
  { accessorKey: "closingDate", header: "平仓日" },
  { accessorKey: "quantity", header: "数量" },
  {
    id: "holding",
    header: "持有交易日",
    cell: (c: { row: { original: Row } }) =>
      c.row.original.holdingTradingDays.value ??
      c.row.original.holdingTradingDays.reason,
  },
  {
    id: "amount",
    header: "净收益金额（元）",
    cell: (c: { row: { original: Row } }) =>
      c.row.original.netProfit.value!.toFixed(2),
  },
  {
    id: "rate",
    header: "净收益率",
    cell: (c: { row: { original: Row } }) =>
      `${(c.row.original.netReturn.value! * 100).toFixed(2)}%`,
  },
].map((column) => ({ ...column, enableSorting: false }));
function Ranking({
  ranking,
  label,
}: {
  ranking: KeyTradeRanking;
  label: string;
}) {
  const data = [
    ...ranking.highest.map((r, i) => ({ ...r, side: "最高", rank: i + 1 })),
    ...ranking.lowest.map((r, i) => ({ ...r, side: "最低", rank: i + 1 })),
  ];
  return (
    <div className="space-y-2">
      <h4 className="font-medium">{label}</h4>
      <DataTable
        label={label}
        columns={columns}
        data={data}
        rowCount={data.length}
        pagination={{ pageIndex: 0, pageSize: data.length || 1 }}
        sorting={[]}
        onPaginationChange={() => {}}
        onSortingChange={() => {}}
        getRowId={(r) => `${r.side}-${r.id}`}
        showPagination={false}
      />
    </div>
  );
}
export function KeyTradesResults({
  data,
  onNChange,
  loading,
}: {
  data: ReturnType<typeof keyTrades>;
  onNChange: (n: number) => void;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>关键交易</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Label htmlFor="key-trades-n">每侧笔数 N（1–20，默认 3）</Label>
        <Input
          id="key-trades-n"
          type="number"
          min={1}
          max={20}
          defaultValue={data.n}
          key={data.n}
          disabled={loading}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (Number.isInteger(n) && n >= 1 && n <= 20) onNChange(n);
            else e.target.value = String(data.n);
          }}
        />
        <p className="text-sm text-muted-foreground">
          按平仓年份分组；金额按净收益数值排序，收益率按百分比排序。各取最高与最低
          N
          笔，不按正负筛选；样本较少时头尾可能重合。同值保留原回合顺序。未复权，沿用所选成本口径。
        </p>
        <p>
          未平仓排除 {data.openCount} 笔；已平仓但指标缺失排除{" "}
          {data.missingCount} 笔。
        </p>
        {data.missingReasons.map((item) => (
          <p key={item.reason} className="text-sm text-muted-foreground">
            {item.reason}：{item.count} 笔（原因可重叠）
          </p>
        ))}
        {!data.years.length && <p>暂无可入榜的已平仓回合。</p>}
        {data.years.map((year) => (
          <Collapsible key={year.year}>
            <CollapsibleTrigger asChild>
              <Button variant="outline">
                {year.year} 年 · {year.count} 笔可用回合 · 展开/收起
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              <Ranking
                label={`${year.year} 金额榜（按净收益金额）`}
                ranking={year.amount}
              />
              <Ranking
                label={`${year.year} 收益率榜（按净收益率）`}
                ranking={year.returnRate}
              />
            </CollapsibleContent>
          </Collapsible>
        ))}
      </CardContent>
    </Card>
  );
}
