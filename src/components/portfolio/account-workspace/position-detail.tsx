"use client";
import { useState } from "react";
import Link from "next/link";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  accountKindLabels,
  industryGroupsFor,
  stopStatusFor,
} from "~/lib/portfolio/account-workspace";
import {
  holdingsHref,
  type HoldingsFilters,
} from "~/lib/portfolio/account-holdings-url";
import { formatNumber } from "trading-strategy-core/format-number";
import { Button } from "../../ui/button";
import { AttributionRows } from "./attribution";
import { TradeSources } from "./trade-sources";
import { pct } from "./shared";

export function AccountPositionDetail({
  id,
  search,
  filters,
}: {
  id: string;
  search: string;
  filters: HoldingsFilters;
}) {
  const [page, setPage] = useState(0);
  const query = api.accountPosition.useQuery({ id, page });
  const readError = query.error?.message;
  return (
    <section aria-label="持仓归因与衰减" className="space-y-4">
      <Link
        href={holdingsHref(search, filters, null)}
        scroll={false}
        className="underline"
      >
        返回统一持仓
      </Link>
      {/* Keep each branch in a fixed sibling slot so a background refetch
          failure never unmounts the loaded content, its drafts or receipts. */}
      {query.isLoading ? <p role="status">正在读取持仓归因…</p> : null}
      {readError ? (
        <p role="alert">
          {query.data
            ? `刷新失败，以下为最近一次读取的结果。${readError}`
            : readError}{" "}
          <Button onClick={() => void query.refetch()}>重试</Button>
        </p>
      ) : null}
      {query.data ? (
        <PositionDetailContent
          data={query.data}
          page={page}
          setPage={setPage}
          fetching={query.isFetching}
          readError={!!readError}
        />
      ) : null}
    </section>
  );
}

function PositionDetailContent({
  data: d,
  page,
  setPage,
  fetching,
  readError,
}: {
  data: RouterOutputs["accountPosition"];
  page: number;
  setPage: (page: number) => void;
  fetching: boolean;
  readError: boolean;
}) {
  const p = d.position;
  const status = stopStatusFor(p);
  return (
    <>
      <h2 className="text-xl font-semibold">
        {p.symbol} · {accountKindLabels[p.kind]} · {p.account}
      </h2>
      <p>
        数量 {formatNumber(p.quantity, 6)} · 市值 {formatNumber(p.value)}{" "}
        {p.currency} ·{" "}
        {(() => {
          return status === "unknown" ? (
            "距止损 待核对"
          ) : (
            <span className={status === "touched" ? "text-nc-bad" : ""}>
              距止损 {pct(p.stopDistance)} · R {formatNumber(p.rMultiple)}
            </span>
          );
        })()}
      </p>
      <p>
        原价时点 {p.at ?? "未知"} · 分仓 {p.sleeve} · 行业组{" "}
        {industryGroupsFor(p).join("、") || "未知"}
      </p>
      {p.reasons.map((r) => (
        <p key={r} className="text-sm text-nc-text-3">
          {r}
        </p>
      ))}
      <h3 className="text-lg font-semibold">归因与衰减</h3>
      {p.strategyId === null ? (
        <p>尚未关联策略；下方按来源建议确认或手工关联。</p>
      ) : (
        <AttributionRows rows={d.attribution} />
      )}
      <h3>持仓相关性与集中度</h3>
      <p>
        同市场同类型价格日收益相关；缺少20个相邻市场日或零方差留空。历史行业未知不补造。集中度仅使用导入账本的重放净值，其他账户缺完整现金事实时留空。
      </p>
      <p>
        平均相关性 {formatNumber(d.correlation.averagePairwise.value)} ·
        有效证券对 {d.correlation.pairCount.available} · 最大权重{" "}
        {pct(d.concentration.summary.maxSingleWeight)}
      </p>
      {d.correlation.rows
        .find((r) => r.symbol === p.symbol)
        ?.cells.map((c, i) => (
          <p key={i}>
            {p.symbol} / {d.correlation.symbols[i]}：{formatNumber(c.value)} ·{" "}
            {c.overlapDays}日 {c.reason}
          </p>
        ))}
      <TradeSources
        trades={d.trades}
        suggestions={d.suggestions}
        total={d.tradeCount}
        page={page}
        setPage={setPage}
        fetching={fetching}
        readError={readError}
      />
    </>
  );
}
