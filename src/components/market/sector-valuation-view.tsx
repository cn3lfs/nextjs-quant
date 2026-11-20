"use client";
import { useState } from "react";
import { ChartBar } from "@phosphor-icons/react/ssr";
import { formatNumber } from "trading-strategy-core/format-number";
import {
  sectorValuationSorts,
  type SectorValuationCategory,
  type SectorValuationMetric,
  type SectorValuationRow,
  type SectorValuationSort,
  type SectorValuationWindow,
} from "~/lib/financial/sector-valuation";
import { api } from "~/trpc/react";
import {
  GridTable,
  PageGrid,
  Panel,
  PanelEmpty,
  Pill,
  Segmented,
  type Column,
} from "../panels";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { usePanelVisible } from "../workbench/keep-alive";
import { chartSymbolHref } from "~/lib/chart/chart-symbol";
import {
  useAccumulatedPages,
  useIntersectionLoadMore,
} from "../ui/use-infinite-table";
import { BrowseSource, useOpenChart } from "./open-chart";

const categoryLabels: Record<SectorValuationCategory, string> = {
  industry: "行业",
  concept: "概念",
};
const sortLabels: Record<SectorValuationSort, string> = {
  pe: "PE 倍数",
  pe5: "PE 5年分位",
  pe10: "PE 10年分位",
  peAll: "PE 全历史分位",
  pb: "PB 倍数",
  pb5: "PB 5年分位",
  pb10: "PB 10年分位",
  pbAll: "PB 全历史分位",
};
const missingLabels: Record<
  Exclude<SectorValuationMetric["missing"], null>,
  string
> = {
  "no-file": "未下载序列",
  "no-record": "无有效记录",
  duplicate: "同日重复，歧义",
  "missing-date": "无有效日期",
  "missing-on-date": "当日无该值",
};

function windowNote(window: SectorValuationWindow) {
  if (window.percentile !== null)
    return `N=${window.samples} · ≤当前 ${window.notAbove} · ${window.windowStart} 起`;
  if (!window.complete) return `历史不足 · 有效样本 ${window.samples}`;
  return `${window.reason ?? "分位不可用"} · 有效样本 ${window.samples}`;
}

function MetricCell({ metric }: { metric: SectorValuationMetric }) {
  if (metric.value === null)
    return (
      <span className="text-xs text-nc-text-3">
        {metric.missing ? missingLabels[metric.missing] : "—"}
      </span>
    );
  const positive = metric.value > 0;
  return (
    <span
      className={positive ? "tabular-nums" : "tabular-nums text-nc-warn"}
      title={positive ? undefined : "当前倍数非正，保留原值但不计算分位"}
    >
      {formatNumber(metric.value, 2)}
    </span>
  );
}

function PercentileCell({
  window,
  metric,
}: {
  window?: SectorValuationWindow;
  metric: SectorValuationMetric;
}) {
  if (!window) return <span className="text-nc-text-3">—</span>;
  const value =
    window.percentile === null ? "—" : `${formatNumber(window.percentile, 2)}%`;
  return (
    <div title={window.reason ?? undefined}>
      <span
        className={
          window.percentile === null
            ? "text-nc-text-3"
            : "tabular-nums text-nc-text"
        }
      >
        {value}
      </span>
      <span className="block text-xs text-nc-text-3">
        {metric.value === null ? "当前值不可用" : windowNote(window)}
      </span>
    </div>
  );
}

function SectorLink({ symbol, name }: { symbol: string; name: string }) {
  const open = useOpenChart();
  return (
    <a
      href={chartSymbolHref(symbol)}
      className="text-primary underline underline-offset-2 hover:no-underline"
      onClick={(event) => {
        if (
          !open ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        open(symbol);
      }}
    >
      {name}
    </a>
  );
}

const sectorKey = (row: SectorValuationRow) =>
  `${row.category}:${row.code ?? row.name}`;

function columns(): Column<SectorValuationRow>[] {
  return [
    {
      key: "sector",
      header: "板块（通达信代码）",
      width: "1.5fr",
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium" title={row.name}>
            {row.symbol ? (
              <SectorLink symbol={row.symbol} name={row.name} />
            ) : (
              row.name
            )}
          </div>
          <div className="text-xs text-nc-text-3">
            {row.code ?? "无代码"} · {categoryLabels[row.category]}
          </div>
        </div>
      ),
    },
    {
      key: "pe",
      header: "PE-TTM 整体法",
      align: "right",
      cell: (row) => <MetricCell metric={row.pe} />,
    },
    {
      key: "pe5",
      header: "PE 5年分位",
      align: "right",
      cell: (row) => <PercentileCell window={row.pe.y5} metric={row.pe} />,
    },
    {
      key: "pe10",
      header: "PE 10年分位",
      align: "right",
      cell: (row) => <PercentileCell window={row.pe.y10} metric={row.pe} />,
    },
    {
      key: "peAll",
      header: "PE 全历史分位",
      align: "right",
      cell: (row) => <PercentileCell window={row.pe.yAll} metric={row.pe} />,
    },
    {
      key: "pb",
      header: "PB-MRQ 整体法",
      align: "right",
      cell: (row) => <MetricCell metric={row.pb} />,
    },
    {
      key: "pb5",
      header: "PB 5年分位",
      align: "right",
      cell: (row) => <PercentileCell window={row.pb.y5} metric={row.pb} />,
    },
    {
      key: "pb10",
      header: "PB 10年分位",
      align: "right",
      cell: (row) => <PercentileCell window={row.pb.y10} metric={row.pb} />,
    },
    {
      key: "pbAll",
      header: "PB 全历史分位",
      align: "right",
      cell: (row) => <PercentileCell window={row.pb.yAll} metric={row.pb} />,
    },
    {
      key: "date",
      header: "截止日 / 原因",
      width: "1.2fr",
      cell: (row) =>
        row.status === "unavailable" ? (
          <span
            className="text-xs text-nc-warn"
            title={row.reason ?? undefined}
          >
            {row.reason ?? "序列不可用"}
          </span>
        ) : (
          <span className="tabular-nums">{row.date ?? "—"}</span>
        ),
    },
  ];
}

const PAGE_SIZE = 50;

/** 板块估值：同花顺式行业/概念切换，但只使用通达信本地 BK5/BK6。 */
export function SectorValuationView() {
  const visible = usePanelVisible();
  const [category, setCategory] = useState<SectorValuationCategory>("industry");
  const [sort, setSort] = useState<SectorValuationSort>("pe5");
  const [descending, setDescending] = useState(false);
  const [page, setPage] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const utils = api.useUtils();
  const input = {
    category,
    sort,
    descending,
    pageIndex: page,
    pageSize: PAGE_SIZE,
  };
  const query = api.sectorValuation.useQuery(input, {
    enabled: visible && !refreshing,
    retry: false,
    staleTime: page === 0 ? 30_000 : 0,
  });
  // 刷新必须写回当前普通 key；切到 refresh:true 的新 key 再切回会读到旧缓存。
  async function refreshLocal() {
    setRefreshing(true);
    setRefreshError(null);
    setPage(0);
    const firstPage = { ...input, pageIndex: 0 };
    try {
      const fresh = await utils.sectorValuation.fetch(
        {
          ...firstPage,
          refresh: true,
        },
        { staleTime: 0 },
      );
      utils.sectorValuation.setData(firstPage, fresh);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  }
  const data = query.data;
  // 只有与当前分类/排序/方向/页次一致的响应才能作为结果展示。
  const result =
    query.isSuccess &&
    (page === 0 || !query.isFetching) &&
    !query.isPlaceholderData &&
    data &&
    data.category === category &&
    data.sort === sort &&
    data.descending === descending &&
    data.pageIndex === page
      ? data
      : undefined;
  const batches = useAccumulatedPages({
    resetKey: JSON.stringify([category, sort, descending]),
    pageIndex: page,
    responsePageIndex: result?.pageIndex,
    items: result?.rows,
    total: result?.total,
    getKey: sectorKey,
    metadata: result,
  });
  const current = batches.metadata;
  const counts = current?.counts;
  const loadingMore = refreshing || query.isFetching;
  const loadMore = () => setPage(page + 1);
  const sentinel = useIntersectionLoadMore({
    enabled: visible && batches.hasMore && !query.isError,
    loading: loadingMore,
    onLoadMore: loadMore,
  });
  const isPe10 = current?.sort === "pe10";
  const isPb10 = current?.sort === "pb10";
  const showInsufficient10yBanner =
    Boolean(current) &&
    (isPe10 || isPb10) &&
    Boolean(current!.coverage.first) &&
    Boolean(current!.observation.window10) &&
    current!.observation.window10! < current!.coverage.first!;
  function selectCategory(next: SectorValuationCategory) {
    setCategory(next);
    setPage(0);
  }
  function selectSort(next: SectorValuationSort) {
    setSort(next);
    setPage(0);
  }
  return (
    <PageGrid>
      <Panel
        span={12}
        icon={ChartBar}
        title="板块估值"
        tag={
          current ? (
            <Pill tone="idle">
              {current.available ? `${current.total} 个板块` : "不可用"}
            </Pill>
          ) : undefined
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="板块分类"
              value={category}
              onChange={selectCategory}
              options={[
                {
                  value: "industry",
                  label: `行业${counts ? ` ${counts.industry}` : ""}`,
                },
                {
                  value: "concept",
                  label: `概念${counts ? ` ${counts.concept}` : ""}`,
                },
              ]}
            />
            <Select
              value={sort}
              onValueChange={(value) =>
                selectSort(value as SectorValuationSort)
              }
            >
              <SelectTrigger aria-label="板块估值排序">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sectorValuationSorts.map((key) => (
                  <SelectItem key={key} value={key}>
                    {sortLabels[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Segmented
              label="排序方向"
              value={descending ? "desc" : "asc"}
              onChange={(value) => {
                setDescending(value === "desc");
                setPage(0);
              }}
              options={[
                { value: "asc", label: "升序" },
                { value: "desc", label: "降序" },
              ]}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={refreshing || query.isFetching}
              onClick={() => void refreshLocal()}
            >
              {refreshing ? "刷新中…" : "刷新本地"}
            </Button>
          </div>
        }
        note="数据：通达信本地 gpsh<板块代码>.dat，BK5 首列 PE-TTM、BK6 首列 PB-MRQ，均为整体法。分位 = 不高于当前值的有效样本数 / 有效样本数，并列都计；只计同源、同日去重清晰、正有限历史值。非正倍数保留原值、分位留空并排在末尾。序列起点不足 5 或 10 年时保留选项但标历史不足，不伪算。"
      >
        <div className="mb-3 space-y-1 text-sm text-nc-text-3">
          {current ? (
            <>
              <p role="status">
                {categoryLabels[current.category]} · 板块定义 {current.total} ·
                可读 {current.coverage.readable} · 源覆盖{" "}
                {current.coverage.first ?? "—"} ~ {current.coverage.last ?? "—"}{" "}
                · 5年窗口 {current.observation.window5 ?? "—"} 起 · 10年窗口{" "}
                {current.observation.window10 ?? "—"} 起
              </p>
              <p>
                排序：{sortLabels[current.sort]} ·{" "}
                {current.descending ? "降序" : "升序"} · 未知与非正置后
                {query.dataUpdatedAt
                  ? ` · 读取于 ${new Date(query.dataUpdatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`
                  : ""}
              </p>
            </>
          ) : (
            <p role="status">正在读取所选分类…</p>
          )}
          {current?.warning && (
            <p className="text-nc-warn">{current.warning}</p>
          )}
          {refreshError && (
            <p role="alert" className="text-nc-bad">
              刷新失败：{refreshError}
            </p>
          )}
          {current && !current.available && (
            <p role="alert" className="text-nc-bad">
              {current.reason}
            </p>
          )}
        </div>
        {query.isError && (
          <p role="alert" className="text-[13px] text-nc-bad">
            读取失败：{query.error.message}{" "}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void query.refetch()}
            >
              重试
            </Button>
          </p>
        )}
        {!current ? (
          query.isError ? null : (
            <PanelEmpty>正在读取所选分类、排序与页次…</PanelEmpty>
          )
        ) : batches.rows.length === 0 ? (
          <PanelEmpty>当前分类没有板块定义，或本地板块主档不可用。</PanelEmpty>
        ) : (
          <>
            {showInsufficient10yBanner && (
              <div
                role="status"
                className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-nc-warn/40 bg-nc-warn/10 px-3 py-2 text-sm text-nc-text"
              >
                <span>
                  当前本地通达信数据起点为 {current.coverage.first}，未满 10
                  年窗口（需 {current.observation.window10} 起），因此 10
                  年分位按不伪算口径留空。
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => selectSort(isPe10 ? "peAll" : "pbAll")}
                  >
                    改按 {isPe10 ? "PE" : "PB"} 全历史分位
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => selectSort(isPe10 ? "pe5" : "pb5")}
                  >
                    改按 {isPe10 ? "PE" : "PB"} 5年分位
                  </Button>
                </div>
              </div>
            )}
            <BrowseSource
              label={`板块估值 · ${categoryLabels[current.category]}`}
              symbols={batches.rows
                .map((r) => r.symbol)
                .filter((s): s is string => Boolean(s))}
            >
              <GridTable
                label={`${categoryLabels[current.category]}板块估值`}
                columns={columns()}
                rows={batches.rows}
                rowKey={sectorKey}
                rowClassName={(row) =>
                  row.status === "unavailable" ? "text-nc-text-3" : undefined
                }
                minWidth={1360}
                empty="当前分类没有可展示的板块。"
              />
            </BrowseSource>
            <div ref={sentinel} aria-hidden="true" className="h-px" />
            <nav
              aria-label="板块估值分页"
              className="mt-4 flex items-center justify-between gap-2"
            >
              <span className="text-sm text-nc-text-3" aria-live="polite">
                已加载 {batches.rows.length} / 共 {batches.total} 个板块
              </span>
              {batches.hasMore && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loadingMore || query.isError}
                  onClick={loadMore}
                >
                  {loadingMore ? "加载中…" : "加载更多"}
                </Button>
              )}
            </nav>
          </>
        )}
      </Panel>
    </PageGrid>
  );
}
