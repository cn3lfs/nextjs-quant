"use client";
import { ChartBar } from "@phosphor-icons/react/ssr";
import { useState } from "react";
import { formatNumber } from "trading-strategy-core/format-number";
import {
  type SwSectorLevel,
  type SwSectorValuationRow,
  type SwSectorValuationSort,
} from "~/lib/financial/sw-sector-valuation";
import { cn } from "~/lib/common/classnames";
import { api } from "~/trpc/react";
import {
  GridTable,
  PageGrid,
  Panel,
  PanelEmpty,
  Segmented,
  type Column,
} from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { usePanelVisible } from "../workbench/keep-alive";

const sortLabels: Record<SwSectorValuationSort, string> = {
  pePct: "PE 历史分位",
  pe: "PE-TTM",
  pbPct: "PB 历史分位",
  pb: "PB-LF",
  divPct: "股息率分位",
  div: "股息率-TTM",
};

const sortOptions = Object.entries(sortLabels) as [
  SwSectorValuationSort,
  string,
][];

const levelLabels: Record<SwSectorLevel, string> = {
  l1: "申万一级行业",
  l2: "申万二级行业",
};

const readTime = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
});

/** 上月/去年对比值；都缺失时不渲染 tooltip。 */
function prevHint(prevM: number | null, prevY: number | null, unit = "") {
  const parts: string[] = [];
  if (prevM !== null) parts.push(`上月 ${formatNumber(prevM, 2)}${unit}`);
  if (prevY !== null) parts.push(`去年 ${formatNumber(prevY, 2)}${unit}`);
  return parts.length ? parts.join(" · ") : undefined;
}

function isPercentile(value: number | null): value is number {
  return value !== null && value >= 0 && value <= 100;
}

/** PE/PB 分位越高越贵。 */
function valuationTone(value: number, cheap: number, expensive: number) {
  if (value <= cheap) return "text-nc-ok";
  if (value >= expensive) return "text-nc-warn";
  return "text-nc-text";
}

/** 股息率分位越高通常代表估值越便宜，贵贱方向与 PE/PB 相反。 */
function dividendTone(value: number) {
  if (value >= 85) return "text-nc-ok";
  if (value <= 15) return "text-nc-warn";
  return "text-nc-text";
}

function buildColumns(
  onDrill: (name: string) => void,
): Column<SwSectorValuationRow>[] {
  return [
    {
      key: "sector",
      header: "行业",
      width: "1.7fr",
      cell: (row) => (
        <div className="min-w-0">
          {row.level === "l1" ? (
            <button
              type="button"
              title="查看下属申万二级细分"
              className="block max-w-full cursor-pointer truncate text-left font-semibold underline-offset-2 hover:underline"
              onClick={() => onDrill(row.name)}
            >
              {row.name}
            </button>
          ) : (
            <span className="block truncate font-semibold" title={row.name}>
              {row.name}
            </span>
          )}
          <div className="truncate text-xs text-nc-text-3">
            {row.swCode}
            {row.level === "l2" && row.parentL1 ? ` · ${row.parentL1}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "pe",
      header: "PE-TTM",
      align: "right",
      cell: (row) => {
        if (row.pe === null) return <span className="text-nc-text-3">—</span>;
        if (row.pe < 0)
          return (
            <span
              className="text-nc-warn tabular-nums"
              title="行业整体亏损，不以 PE 判贵贱"
            >
              亏损({formatNumber(row.pe, 2)})
            </span>
          );
        return (
          <span
            className="tabular-nums"
            title={prevHint(row.pePrevM, row.pePrevY)}
          >
            {formatNumber(row.pe, 2)}
          </span>
        );
      },
    },
    {
      key: "pePct",
      header: "PE 历史分位",
      align: "right",
      cell: (row) => {
        if (!isPercentile(row.pePct))
          return <span className="text-xs text-nc-text-3">不可得</span>;
        if (row.pe !== null && row.pe < 0)
          return <span className="text-xs text-nc-text-3">亏损不计</span>;
        return (
          <span
            className={cn("tabular-nums", valuationTone(row.pePct, 20, 85))}
          >
            {formatNumber(row.pePct, 2)}%
          </span>
        );
      },
    },
    {
      key: "pb",
      header: "PB-LF",
      align: "right",
      cell: (row) =>
        row.pb === null ? (
          <span className="text-nc-text-3">—</span>
        ) : (
          <span
            className="tabular-nums"
            title={prevHint(row.pbPrevM, row.pbPrevY)}
          >
            {formatNumber(row.pb, 2)}
          </span>
        ),
    },
    {
      key: "pbPct",
      header: "PB 历史分位",
      align: "right",
      cell: (row) =>
        !isPercentile(row.pbPct) ? (
          <span className="text-xs text-nc-text-3">不可得</span>
        ) : (
          <span
            className={cn("tabular-nums", valuationTone(row.pbPct, 15, 85))}
          >
            {formatNumber(row.pbPct, 2)}%
          </span>
        ),
    },
    {
      key: "div",
      header: "股息率-TTM",
      align: "right",
      cell: (row) =>
        row.div === null ? (
          <span className="text-nc-text-3">—</span>
        ) : (
          <span
            className="tabular-nums"
            title={prevHint(row.divPrevM, row.divPrevY, "%")}
          >
            {formatNumber(row.div, 2)}%
          </span>
        ),
    },
    {
      key: "divPct",
      header: "股息率分位",
      align: "right",
      cell: (row) => {
        const percentile = row.divPct;
        const available = isPercentile(percentile);
        return (
          <span
            className={
              available
                ? cn("tabular-nums", dividendTone(percentile))
                : "text-xs text-nc-text-3"
            }
            title="股息率分位越高通常代表估值越便宜"
          >
            {available ? `${formatNumber(percentile, 2)}%` : "不可得"}
          </span>
        );
      },
    },
    {
      key: "endDate",
      header: "数据截止",
      align: "right",
      cell: (row) => (
        <span className="tabular-nums text-nc-text-3">
          {row.endDate ?? "—"}
        </span>
      ),
    },
  ];
}

/** 板块估值：腾讯自选股（westock-data）申万一级/二级行业估值与历史分位。 */
export function SectorValuationView() {
  const visible = usePanelVisible();
  const [level, setLevel] = useState<SwSectorLevel>("l1");
  const [parentL1, setParentL1] = useState("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SwSectorValuationSort>("pePct");
  const [descending, setDescending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const utils = api.useUtils();
  const input = {
    level,
    parentL1: level === "l2" && parentL1 !== "all" ? parentL1 : undefined,
    search: search.trim(),
    sort,
    descending,
  };
  const query = api.swSectorValuation.useQuery(input, {
    enabled: visible,
    retry: false,
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const fresh = await utils.swSectorValuation.fetch(
        { ...input, refresh: true },
        { staleTime: 0 },
      );
      utils.swSectorValuation.setData(input, fresh);
      if (fresh.available) void utils.swSectorValuation.invalidate();
    } catch {
      setRefreshError("刷新失败，请稍后重试。");
    } finally {
      setRefreshing(false);
    }
  }
  function drillDown(name: string) {
    setLevel("l2");
    setParentL1(name);
    setSearch("");
  }
  const current = query.isPlaceholderData ? undefined : query.data;
  const counts = query.data?.counts;
  const l1Names = query.data?.l1Names ?? [];
  const busy = refreshing || query.isFetching;
  const error =
    refreshError ??
    (query.isError ? "读取申万行业估值失败，请重试。" : null) ??
    (current && !current.available
      ? (current.reason ?? "申万行业估值暂不可得")
      : null);
  const alert = error ?? current?.warning;
  const columns = buildColumns(drillDown);
  return (
    <PageGrid>
      <Panel
        span={12}
        icon={ChartBar}
        title="板块估值"
        tag={
          current?.available
            ? `${current.total} 个行业`
            : current || query.isError
              ? "不可用"
              : undefined
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="行业层级"
              value={level}
              onChange={(next) => setLevel(next)}
              options={[
                {
                  value: "l1",
                  label: `申万一级${counts ? ` ${counts.l1}` : ""}`,
                },
                {
                  value: "l2",
                  label: `申万二级${counts ? ` ${counts.l2}` : ""}`,
                },
              ]}
            />
            {level === "l2" && (
              <Select value={parentL1} onValueChange={setParentL1}>
                <SelectTrigger size="sm" aria-label="筛选一级行业">
                  <SelectValue>
                    {parentL1 === "all" ? "全部一级" : parentL1}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部一级</SelectItem>
                  {l1Names.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Input
              className="h-8 w-36"
              aria-label="搜索行业"
              placeholder="搜行业名/代码"
              maxLength={40}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select
              value={sort}
              onValueChange={(value) => setSort(value as SwSectorValuationSort)}
            >
              <SelectTrigger size="sm" aria-label="板块估值排序">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sortOptions.map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Segmented
              label="排序方向"
              value={descending ? "desc" : "asc"}
              onChange={(value) => setDescending(value === "desc")}
              options={[
                { value: "asc", label: "升序" },
                { value: "desc", label: "降序" },
              ]}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {refreshing ? "刷新中…" : "刷新"}
            </Button>
          </div>
        }
        note="数据来源：腾讯自选股（westock-data · 申万2021一级/二级行业指数），与财联社板块分析脚本同源。PE/PB 分位越高越贵，股息率分位越高通常越便宜；亏损行业 PE 标「亏损」，缺分位标「不可得」，绝不补零。"
      >
        {(current || alert) && (
          <div className="mb-3 space-y-2 text-sm text-nc-text-3">
            {current && (
              <p role="status">
                {levelLabels[current.level]} · 共 {current.total} 个 · 数据截止{" "}
                {current.asOfDate ?? "—"} · 排序：{sortLabels[current.sort]}（
                {current.descending ? "降序" : "升序"}）
                {current.fetchedAt
                  ? ` · 读取于 ${readTime.format(current.fetchedAt)}`
                  : ""}
              </p>
            )}
            {alert && (
              <div
                className={cn(
                  "flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-nc-text",
                  error
                    ? "border-nc-bad-edge bg-nc-bad/10"
                    : "border-nc-warn/40 bg-nc-warn/10",
                )}
              >
                <span role="alert">{alert}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void refresh()}
                >
                  重试
                </Button>
              </div>
            )}
          </div>
        )}
        {!current && query.isFetching && (
          <div role="status">
            <PanelEmpty>正在读取申万行业估值…</PanelEmpty>
          </div>
        )}
        {current && (
          <GridTable
            label="申万行业估值"
            columns={columns}
            rows={current.rows}
            rowKey={(row) => row.code}
            rowClassName={(row) => (row.missing ? "text-nc-text-3" : undefined)}
            minWidth={1120}
            empty="当前条件下没有匹配的申万行业。"
          />
        )}
      </Panel>
    </PageGrid>
  );
}
