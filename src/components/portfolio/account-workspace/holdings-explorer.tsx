"use client";
import Link from "next/link";
import { api } from "~/trpc/react";
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
import { Segmented } from "../../panels";
import { Input } from "../../ui/input";
import { DataTable, type DataTableColumn } from "../../ui/data-table";
import { CryptoRiskNotes } from "../crypto-risk-notes";
import { PositionCostPrice } from "../position-cost-price";
import { AccountPositionDetail } from "./position-detail";
import { pct, sourceLabels, type Position } from "./shared";

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
    <>
      <CryptoRiskNotes />
      <UnifiedPositions search={search} filters={filters} update={update} />
    </>
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
      header: "市值",
      cell: ({ row }) =>
        `${formatNumber(row.original.value)} ${row.original.currency}`,
    },
    {
      id: "costPrice",
      header: "成本 / 估值价",
      cell: ({ row }) => <PositionCostPrice {...row.original} />,
    },
    {
      id: "stop",
      header: "距止损 / R",
      cell: ({ row }) => {
        const status = stopStatusFor(row.original);
        return status === "unknown" ? (
          <span>待核对</span>
        ) : (
          <span className={status === "touched" ? "text-nc-bad" : ""}>
            {pct(row.original.stopDistance)} /{" "}
            {formatNumber(row.original.rMultiple)}
          </span>
        );
      },
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
      <h2 className="text-xl font-semibold">
        统一持仓与风险
        {kind === "real" && (
          <span className="ml-2 text-sm font-normal text-nc-text-3">
            来源：{sourceLabels[source]}
          </span>
        )}
      </h2>
      <p className="text-sm text-nc-text-3">
        默认仅真实账户；纸面、模拟交易所分别标记。CNY/USDT不换算相加。手工与导入账本为独立事实，请勿重复登记同一成交。
      </p>
      <p className="text-sm text-nc-text-3">
        按已读取的价格与记录的止损比较。缺少有效价格或止损的持仓显示为「待核对」。
      </p>
      <Segmented
        label="账户类型"
        value={kind}
        options={[
          { value: "real", label: "真实账户" },
          { value: "paper", label: "纸面账户" },
          { value: "exchange-simulation", label: "模拟交易所" },
          { value: "all", label: "全部类型" },
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
      {kind === "real" && (
        <Segmented
          label="持仓来源"
          value={source}
          options={[
            { value: "all", label: "全部来源" },
            { value: "delivery", label: "券商交割单" },
            { value: "local", label: "手工账本" },
          ]}
          onChange={(v) => update({ source: v, page: 0 })}
        />
      )}
      <Segmented
        label="市场"
        value={market}
        options={[
          { value: "all", label: "全部市场" },
          { value: "cn-equity", label: "A股" },
          { value: "crypto", label: "数字货币" },
        ]}
        onChange={(v) => update({ market: v, page: 0 })}
      />
      <Segmented
        label="止损状态"
        value={stopStatus}
        options={[
          { value: "all", label: "全部" },
          { value: "touched", label: "所示价格已到止损位" },
          { value: "unknown", label: "待核对" },
        ]}
        onChange={(v) => update({ stopStatus: v, page: 0 })}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="分组方式"
          value={group}
          options={[
            { value: "market", label: "按市场" },
            { value: "sleeve", label: "按分仓" },
            { value: "kind", label: "按类型" },
          ]}
          onChange={(v) => update({ group: v, page: 0 })}
        />
        <Input
          aria-label="分仓筛选"
          placeholder="分仓ID，空为全部"
          value={sleeve}
          onChange={(e) => update({ sleeve: e.target.value, page: 0 })}
          className="max-w-56"
        />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {query.data?.totals.map((t) => (
          <p key={t.currency} className="rounded border p-3">
            {t.currency} 持仓市值 {formatNumber(t.value)} · {t.count} 笔持仓 ·{" "}
            {t.missing} 笔估值未知
          </p>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        <p>行业组可重叠，各组独立校验；行业市值不相加为账户总额。</p>
        {query.data?.exposure.map((e) => (
          <p key={`${e.dimension}:${e.key}`}>
            {e.dimension} / {e.key}：{formatNumber(e.value)}
          </p>
        ))}
      </div>
      {query.data?.missingAccounts.map((m) => (
        <p key={m} role="status">
          {m}
        </p>
      ))}
      <DataTable
        label="统一持仓列表"
        columns={columns}
        data={query.data?.items ?? []}
        rowCount={query.data?.total ?? 0}
        emptyMessage={
          stopStatus === "touched"
            ? "当前范围没有所示价格已到止损位的持仓；按已读取价格与记录止损比较。"
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
    </section>
  );
}
