"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { api } from "~/trpc/react";
import { formatNumber } from "trading-strategy-core/format-number";
import {
  buildScanToLabHandoffHref,
  monthlyReviewHandoffSymbols,
} from "~/lib/research/diagnose-contract";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

export function MonthlyReview() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7)),
    query = api.accountMonthlyReview.useQuery(month);
  const handoff = useMemo(
    () =>
      monthlyReviewHandoffSymbols(
        (query.data?.rounds.items ?? [])
          .filter((item) => item.market === "cn-equity")
          .map((item) => item.symbol),
      ),
    [query.data?.rounds.items],
  );
  // Pure navigation only: never registers, promotes, writes settings or trades.
  const diagnoseHref =
    handoff.symbols.length > 0
      ? buildScanToLabHandoffHref({
          scope: "portfolio-diagnose",
          handoffSource: "account-review",
          symbols: handoff.symbols,
          returnTo: "/accounts/review",
        })
      : null;
  return (
    <section className="space-y-4">
      <h2>月度纪律自查</h2>
      <Input
        type="month"
        aria-label="自查月份"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        className="max-w-56"
      />
      <p>{query.data?.notice}</p>
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.data?.unavailable.map((r, i) => (
        <p key={`${r.account}:${r.security}:${i}`}>
          {r.account} / {r.security}：{r.reason}
        </p>
      ))}
      <p>
        未计划交易 {query.data?.unlinked ?? "—"} 个回合 · 已关联计划{" "}
        {query.data?.rounds.planned ?? "—"} 个回合 · 未知开仓{" "}
        {query.data?.rounds.unknownOpening ?? "—"} 个回合（单列，不当作守纪）。
        金额覆盖沪深 CNY；crypto 仅计回合，来源顺序不足另列未覆盖证据。
      </p>
      {query.data &&
        (diagnoseHref ? (
          <div className="space-y-1">
            <Button asChild variant="outline" size="sm">
              <Link
                data-testid="monthly-review-diagnose-link"
                href={diagnoseHref}
              >
                用当月标的跑组合诊断（{handoff.symbols.length} 只）
              </Link>
            </Button>
            {handoff.truncatedCount > 0 && (
              <p className="text-sub text-nc-text-3">
                当月沪深 A 股标的超过 12 只，已按顺序取前 12 只。
              </p>
            )}
            {handoff.droppedInvalidCount > 0 && (
              <p className="text-sub text-nc-text-3">
                另有 {handoff.droppedInvalidCount} 个非沪深 A
                股代码未纳入组合诊断。
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-nc-text-3">
            当月暂无沪深 A 股标的，暂不能带入组合诊断。
          </p>
        ))}
      {query.data?.items.map((r) => (
        <article key={`${r.account}:${r.kind}`} className="rounded border p-3">
          <h3>
            {r.account} ·{" "}
            {
              { stop: "跌破止损仍持有", oversize: "超仓", chase: "追高" }[
                r.kind as "stop" | "oversize" | "chase"
              ]
            }
          </h3>
          <p>
            {r.count} 次 · 实际回合盈亏 {formatNumber(r.actual)} CNY · 按纪律{" "}
            {formatNumber(r.counterfactual)} CNY · 金额改善{" "}
            {formatNumber(r.impact)} CNY
          </p>
          <p>{r.reason}</p>
          <p className="text-xs text-nc-text-3">{r.basis}</p>
        </article>
      ))}
      <Link href="/accounts/review" className="underline">
        交割单现金逐日核对、原有纪律网格与详细归因
      </Link>
    </section>
  );
}
