"use client";
import Link from "next/link";
import { useId, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  accountKindLabels,
  industryGroupsFor,
  stopStatusFor,
} from "~/lib/portfolio/account-workspace";
import {
  holdingsChartHref,
  holdingsHref,
  readHoldingsFilters,
  type HoldingsFilters,
} from "~/lib/portfolio/account-holdings-url";
import { formatNumber } from "trading-strategy-core/format-number";
import {
  FilterDivider,
  FilterGroup,
  FilterToolbar,
  MethodologyPopover,
  MetricCard,
  Pill,
  Segmented,
  type MethodologyItem,
} from "../../panels";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../../ui/table";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { DataTable, type DataTableColumn } from "../../ui/data-table";
import { CryptoRiskNotes } from "../crypto-risk-notes";
import { PositionCostPrice } from "../position-cost-price";
import { RiskDistanceBar } from "../risk-distance-bar";
import { AccountPositionDetail } from "./position-detail";
import { sourceLabels, type Position } from "./shared";

/**
 * The URL is the only list state. Filter changes replace the current entry and
 * keep the other parameters; opening a position pushes an entry that carries
 * the same filters, so Back/Forward and the return link restore that view. A
 * direct or default `/accounts` entry has no holdings parameters.
 */
export function HoldingsExplorer({
  search,
  position,
}: {
  search: string;
  position: string | null;
}) {
  const filters = readHoldingsFilters(search);
  const update = (patch: Partial<HoldingsFilters>) => {
    // Merge onto the live entry, not this render's snapshot: two controls
    // clicked before React commits the first replace still keep both values.
    const live = window.location.search,
      next = { ...readHoldingsFilters(live), ...patch };
    // `null` (not history.state) lets Next sync useSearchParams; its patched
    // replaceState copies the internal state itself.
    window.history.replaceState(null, "", holdingsHref(live, next));
  };
  return position ? (
    <AccountPositionDetail
      key={position}
      id={position}
      search={search}
      filters={filters}
    />
  ) : (
    <UnifiedPositions search={search} filters={filters} update={update} />
  );
}

const exposureDimensionLabels: Record<string, string> = {
  market: "市场",
  sleeve: "策略分仓",
  industry: "行业",
};

const kindLabels: Record<HoldingsFilters["kind"], string> = {
  real: "真实账户",
  paper: "本地模拟",
  "exchange-simulation": "币圈模拟",
  all: "全部",
};

const reconciliationModes = {
  "upper-bound": "含重叠上限",
  "delivery-first": "券商优先",
  "local-first": "手工优先",
} as const;
type ReconciliationMode = keyof typeof reconciliationModes;

type Reconciliation = NonNullable<
  RouterOutputs["accountPositions"]["reconciliation"]
>;

const known = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "—" : formatNumber(value);

const rangeText = (
  lower: number | null | undefined,
  upper: number | null | undefined,
) =>
  lower == null || upper == null
    ? "—"
    : `[${formatNumber(lower)}, ${formatNumber(upper)}]`;

/** `currency:group` is the exposure key shape; the group may itself contain
 *  separators, so only the first colon is the currency boundary. */
function splitExposureKey(key: string) {
  const index = key.indexOf(":");
  return index < 0
    ? { currency: "", group: key }
    : { currency: key.slice(0, index), group: key.slice(index + 1) };
}

function previewValue(
  summary: Reconciliation["summaryByCurrency"][number],
  mode: ReconciliationMode,
) {
  return mode === "delivery-first"
    ? summary.deliveryTotal
    : mode === "local-first"
      ? summary.localTotal
      : summary.grossTotal;
}

function previewLabel(mode: ReconciliationMode) {
  return mode === "delivery-first"
    ? "券商账本合计（预览）"
    : mode === "local-first"
      ? "手工账本合计（预览）"
      : "毛合计（保守上限）";
}

/**
 * Two real ledgers can describe the same fill. This read-only strip keeps the
 * gross preview, the deduplicated interval and the per-symbol overlap on one
 * thin row; switching the view never edits either ledger.
 */
function ReconciliationStrip({
  reconciliation,
  mode,
  onModeChange,
  preferenceError,
  saveError,
}: {
  reconciliation: Reconciliation;
  mode: ReconciliationMode;
  onModeChange: (mode: ReconciliationMode) => void;
  preferenceError?: string;
  saveError?: string;
}) {
  const [showOverlaps, setShowOverlaps] = useState(false);
  const helpId = useId();
  const overlaps = reconciliation.overlapSymbols;
  return (
    <section
      aria-label="双账重叠核对"
      aria-describedby={helpId}
      className="rounded-lg border border-nc-border-soft bg-nc-card px-2.5"
    >
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 py-1">
        {overlaps.length > 0 ? (
          <span className="text-sub whitespace-nowrap text-nc-warn">
            检测到 {overlaps.length} 只标的券商/手工同时存在
          </span>
        ) : (
          <span className="text-sub whitespace-nowrap text-nc-text-3">
            双账无重叠标的
          </span>
        )}
        {overlaps.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-1.5"
            aria-expanded={showOverlaps}
            onClick={() => setShowOverlaps((value) => !value)}
          >
            {showOverlaps ? "收起重叠明细" : "展开重叠明细"}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Segmented
            label="汇总视角"
            value={mode}
            options={(
              Object.keys(reconciliationModes) as ReconciliationMode[]
            ).map((key) => ({ value: key, label: reconciliationModes[key] }))}
            onChange={onModeChange}
          />
        </div>
      </div>
      <p id={helpId} className="sr-only">
        仅切换预览口径，不修改原始账本。人民币与 USDT
        分币种核对，绝不相加；缺失价格显示为「—」。行业 30%
        限额按保守上限核对（当前口径：
        {reconciliation.industryLimitBasis === "upper-bound"
          ? "含重叠上限"
          : reconciliation.industryLimitBasis}
        ）。
      </p>
      {preferenceError && (
        <p role="alert" className="pb-1 text-sub text-nc-warn">
          汇总视角偏好读取失败：{preferenceError}
          。当前按含重叠上限显示。
        </p>
      )}
      {saveError && (
        <p role="alert" className="pb-1 text-sub text-nc-warn">
          汇总视角未保存：{saveError}
          。当前页仍按上次口径显示，原始账本未变化。
        </p>
      )}
      {showOverlaps && overlaps.length > 0 && (
        <div className="overflow-x-auto pb-2">
          <Table className="w-full text-sm">
            <TableHeader>
              <TableRow>
                <TableHead>标的</TableHead>
                <TableHead>市场 / 币种</TableHead>
                <TableHead className="text-right">券商市值</TableHead>
                <TableHead className="text-right">手工市值</TableHead>
                <TableHead className="text-right">毛合计</TableHead>
                <TableHead className="text-right">去重区间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overlaps.map((row) => (
                <TableRow key={`${row.market}:${row.symbol}:${row.currency}`}>
                  <TableCell className="border-l-2 border-nc-warn pl-2">
                    <span className="block">{row.name ?? row.symbol}</span>
                    <span className="block font-mono text-xs text-nc-text-3">
                      {row.symbol}
                    </span>
                  </TableCell>
                  <TableCell>
                    {row.market === "cn-equity" ? "A股" : "数字货币"} /{" "}
                    {row.currency}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {known(row.deliveryValue)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {known(row.localValue)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {known(row.grossTotal)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {rangeText(row.lowerBound, row.upperBound)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function UnifiedPositions({
  search,
  filters,
  update,
}: {
  search: string;
  filters: HoldingsFilters;
  update: (patch: Partial<HoldingsFilters>) => void;
}) {
  const { kind, market, source, stopStatus, group, sleeve, page } = filters;
  const query = api.accountPositions.useQuery({
    kind,
    market,
    group,
    sleeve,
    source,
    stopStatus,
    page,
  });
  // The reconciliation preview is only meaningful for the real ledger.
  const preferences = api.workspacePreferences.useQuery(undefined, {
    enabled: kind === "real",
  });
  const save = api.saveWorkspacePreferences.useMutation({
    onSuccess: () => void preferences.refetch(),
  });
  const mode: ReconciliationMode =
    preferences.data?.holdingsReconciliation ?? "upper-bound";
  const reconciliation =
    kind === "real" ? query.data?.reconciliation : undefined;

  const rows = query.data?.items ?? [];
  const missingAccounts = query.data?.missingAccounts ?? [];
  const stopCounts = rows.reduce(
    (counts, row) => {
      counts[stopStatusFor(row)] += 1;
      return counts;
    },
    { touched: 0, above: 0, unknown: 0 },
  );
  const exposures = query.data?.exposure ?? [];
  const knownExposures = exposures.filter(
    (item): item is typeof item & { value: number } =>
      item.value !== null && Number.isFinite(item.value),
  );
  const topExposure = knownExposures.reduce<
    (typeof knownExposures)[number] | null
  >((top, item) => (!top || item.value > top.value ? item : top), null);
  const unknownExposureCount = exposures.length - knownExposures.length;
  const exposureMeta = (["market", "sleeve", "industry"] as const).flatMap(
    (dimension) => {
      const best = knownExposures
        .filter((item) => item.dimension === dimension)
        .sort((a, b) => b.value - a.value)[0];
      return best
        ? [
            <Pill key={dimension}>
              {exposureDimensionLabels[dimension]}/
              {splitExposureKey(best.key).group} {formatNumber(best.value)}
            </Pill>,
          ]
        : [];
    },
  );

  const methodologyItems: readonly MethodologyItem[] = [
    {
      label: "账户范围",
      detail:
        "默认只看真实账户；本地模拟与币圈模拟单独标记，不混入真实持仓，切换账户类型时来源条件会重置为全部来源。",
    },
    {
      label: "币种与双账",
      detail:
        "人民币与 USDT 分币种显示、绝不相加。券商交割单与手工账本是两本独立账本，同一笔成交可能两边都有；页面给出重叠区间，不会自动去重，也不修改原始账本。",
    },
    {
      label: "汇总口径",
      detail:
        "汇总视角只切换预览口径，不改账本：区间下限取两账较大者，上限为两账相加，默认真实持仓市值按含重叠上限（保守）展示。行业 30% 限额按保守上限核对（当前口径：含重叠上限）；若两账记录的是同一持仓，按上限可能显示超限，实际未必超限。行业组可重叠，各组独立校验，行业市值不相加为账户总额。",
    },
    {
      label: "止损核对",
      detail:
        "按已读取的价格与记录的止损比较：缺少有效价格或止损的持仓显示「未设止损」或「待核对」，绝不按 0 处理；所示价格已到止损位只表示读取时点，不是实时触发。",
    },
  ];

  const columns: DataTableColumn<Position>[] = [
    {
      id: "symbol",
      header: "持仓",
      cell: ({ row }) => (
        <Link
          className="underline"
          href={holdingsHref(search, filters, row.original.id)}
        >
          {row.original.symbol} ·{" "}
          {row.original.market === "cn-equity" ? "A股" : "数字货币"}
        </Link>
      ),
    },
    {
      id: "account",
      header: "账户 / 类型",
      cell: ({ row }) => (
        <span
          className={
            row.original.kind === "real" ? "text-nc-text-1" : "text-nc-accent"
          }
        >
          {row.original.account} · {accountKindLabels[row.original.kind]}
        </span>
      ),
    },
    {
      id: "sleeve",
      header: "分仓 / 行业",
      cell: ({ row }) =>
        `${row.original.sleeve} / ${industryGroupsFor(row.original).join("、") || "未知"}`,
    },
    {
      id: "value",
      header: () => <span className="block text-right">市值</span>,
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">
          {formatNumber(row.original.value)} {row.original.currency}
        </span>
      ),
    },
    {
      id: "costPrice",
      header: () => <span className="block text-right">成本 / 现价</span>,
      cell: ({ row }) => <PositionCostPrice {...row.original} />,
    },
    {
      id: "stop",
      header: () => <span className="block text-right">距止损 / R</span>,
      cell: ({ row }) => (
        <div className="flex justify-end tabular-nums">
          <RiskDistanceBar
            price={row.original.price}
            stop={row.original.stop}
            cost={row.original.cost}
            rMultiple={row.original.rMultiple}
            compact
          />
        </div>
      ),
    },
    {
      id: "chart",
      header: "图表",
      cell: ({ row }) => {
        const href = holdingsChartHref(row.original);
        return href ? (
          <Link
            className="underline"
            href={href}
            aria-label={`打开 ${row.original.symbol} 图表`}
          >
            图表
          </Link>
        ) : (
          "—"
        );
      },
    },
  ];
  return (
    <section aria-label="统一持仓" className="space-y-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-xl font-semibold">统一持仓与风险</h2>
        <Pill>{kind === "real" ? sourceLabels[source] : kindLabels[kind]}</Pill>
        <div className="ml-auto flex items-center gap-3">
          <MethodologyPopover items={methodologyItems} align="end" />
          <Link
            className="text-sub whitespace-nowrap text-nc-text-3 underline hover:text-nc-text"
            href="/accounts?tab=ledger"
          >
            手工记账
          </Link>
          <Link
            className="text-sub whitespace-nowrap text-nc-text-3 underline hover:text-nc-text"
            href="/accounts/review"
          >
            交割单复盘
          </Link>
        </div>
      </header>

      <FilterToolbar label="持仓筛选">
        <FilterGroup>
          <Segmented
            label="账户类型"
            value={kind}
            options={[
              { value: "real", label: "真实账户" },
              { value: "paper", label: "本地模拟" },
              { value: "exchange-simulation", label: "币圈模拟" },
              { value: "all", label: "全部" },
            ]}
            onChange={(v) => {
              // Sources only exist on real accounts; leaving real resets to all.
              update({
                kind: v,
                page: 0,
                ...(v === "real" ? {} : { source: "all" as const }),
              });
            }}
          />
        </FilterGroup>
        <FilterDivider />
        {kind === "real" && (
          <FilterGroup>
            <Select
              value={source}
              onValueChange={(value) =>
                update({
                  source: value as HoldingsFilters["source"],
                  page: 0,
                })
              }
            >
              <SelectTrigger size="sm" aria-label="持仓来源">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部来源</SelectItem>
                <SelectItem value="delivery">券商交割单</SelectItem>
                <SelectItem value="local">手工账本</SelectItem>
              </SelectContent>
            </Select>
          </FilterGroup>
        )}
        <FilterGroup>
          <Select
            value={market}
            onValueChange={(value) =>
              update({
                market: value as HoldingsFilters["market"],
                page: 0,
              })
            }
          >
            <SelectTrigger size="sm" aria-label="市场">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部市场</SelectItem>
              <SelectItem value="cn-equity">A股</SelectItem>
              <SelectItem value="crypto">数字货币</SelectItem>
            </SelectContent>
          </Select>
        </FilterGroup>
        <FilterGroup>
          <Select
            value={stopStatus}
            onValueChange={(value) =>
              update({
                stopStatus: value as HoldingsFilters["stopStatus"],
                page: 0,
              })
            }
          >
            <SelectTrigger size="sm" aria-label="止损状态">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="touched">已触及止损</SelectItem>
              <SelectItem value="unknown">待核对</SelectItem>
            </SelectContent>
          </Select>
        </FilterGroup>
        <FilterGroup>
          <Select
            value={group}
            onValueChange={(value) =>
              update({
                group: value as HoldingsFilters["group"],
                page: 0,
              })
            }
          >
            <SelectTrigger size="sm" aria-label="分组方式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="market">按市场</SelectItem>
              <SelectItem value="sleeve">按分仓</SelectItem>
              <SelectItem value="kind">按类型</SelectItem>
            </SelectContent>
          </Select>
        </FilterGroup>
        <FilterGroup>
          <Input
            aria-label="分仓筛选"
            placeholder="筛选分仓ID..."
            value={sleeve}
            onChange={(e) => update({ sleeve: e.target.value, page: 0 })}
            className="h-8 w-40"
          />
        </FilterGroup>
      </FilterToolbar>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(["CNY", "USDT"] as const).map((currency) => {
          const summary = reconciliation?.summaryByCurrency.find(
            (item) => item.currency === currency,
          );
          const totals = query.data?.totals.find(
            (item) => item.currency === currency,
          );
          const value = summary
            ? previewValue(summary, mode)
            : (totals?.value ?? null);
          return (
            <MetricCard
              key={currency}
              label={summary ? previewLabel(mode) : "持仓市值"}
              value={value}
              unit={currency}
              note={
                summary
                  ? mode === "upper-bound"
                    ? `${currency} 真实持仓 · 含重叠上限（保守）`
                    : `${currency} · 仅预览口径，不改账本`
                  : `${currency} · ${totals?.count ?? 0} 笔持仓 · ${totals?.missing ?? 0} 笔估值未知`
              }
              meta={
                summary && summary.overlapCount > 0 ? (
                  <span>
                    去重区间{" "}
                    {rangeText(
                      summary.deduplicatedLowerBound,
                      summary.grossTotal,
                    )}{" "}
                    · {summary.overlapCount} 笔重叠
                  </span>
                ) : undefined
              }
            />
          );
        })}
        <MetricCard
          label="止损状态（本页）"
          value={query.data ? String(stopCounts.touched) : null}
          unit="笔已触及"
          tone={stopCounts.touched > 0 ? "warn" : "neutral"}
          note={
            query.data
              ? `安全 ${stopCounts.above} · 待核对 ${stopCounts.unknown}`
              : "正在读取…"
          }
          meta={
            missingAccounts.length > 0 ? (
              <span>钱包快照缺失 {missingAccounts.length} 个</span>
            ) : undefined
          }
        />
        <MetricCard
          label="最高敞口"
          value={topExposure?.value ?? null}
          unit={
            topExposure ? splitExposureKey(topExposure.key).currency : undefined
          }
          note={
            topExposure
              ? `${exposureDimensionLabels[topExposure.dimension] ?? topExposure.dimension} / ${splitExposureKey(topExposure.key).group}`
              : "暂无已知估值持仓"
          }
          meta={
            exposureMeta.length > 0 || unknownExposureCount > 0 ? (
              <>
                {exposureMeta}
                {unknownExposureCount > 0 && (
                  <span>另有 {unknownExposureCount} 项估值未知</span>
                )}
              </>
            ) : undefined
          }
        />
      </div>

      {reconciliation && (
        <ReconciliationStrip
          reconciliation={reconciliation}
          mode={mode}
          onModeChange={(value) => {
            save.reset();
            save.mutate({ holdingsReconciliation: value });
          }}
          preferenceError={preferences.error?.message}
          saveError={save.error?.message}
        />
      )}

      <DataTable
        label="统一持仓列表"
        columns={columns}
        data={rows}
        rowCount={query.data?.total ?? 0}
        emptyMessage={
          stopStatus === "touched"
            ? "当前范围没有已触及止损的持仓；按已读取价格与记录止损比较。"
            : stopStatus === "unknown"
              ? "当前范围没有待核对的持仓。"
              : kind === "real" && source !== "all"
                ? `当前范围（${sourceLabels[source]}）无持仓。`
                : undefined
        }
        pagination={{ pageIndex: page, pageSize: 20 }}
        sorting={[]}
        onSortingChange={() => {}}
        onPaginationChange={(u) =>
          update({
            page: (typeof u === "function"
              ? u({ pageIndex: page, pageSize: 20 })
              : u
            ).pageIndex,
          })
        }
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error?.message}
        onRetry={() => void query.refetch()}
      />

      {(market === "crypto" || market === "all") && (
        <details className="rounded-lg border border-nc-border-soft bg-nc-card px-3 py-2">
          <summary className="cursor-pointer text-sub text-nc-text-3">
            数字货币资金与机器人风控状态
          </summary>
          <div className="mt-2 space-y-2">
            {missingAccounts.map((message) => (
              <p key={message} role="status" className="text-sub">
                {message}
              </p>
            ))}
            <CryptoRiskNotes />
          </div>
        </details>
      )}
    </section>
  );
}
