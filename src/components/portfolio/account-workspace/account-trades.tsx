"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "~/trpc/react";
import { Segmented } from "../../panels";
import { Input } from "../../ui/input";
import { BulkTradeLinks } from "../account-review-panels";
import { TradeSources } from "./trade-sources";

export function AccountTrades() {
  const search = useSearchParams(),
    [page, setPage] = useState(0),
    [symbol, setSymbol] = useState(search.get("symbol") ?? ""),
    [kind, setKind] = useState<
      "real" | "paper" | "exchange-simulation" | "all"
    >("real");
  const query = api.accountTrades.useQuery({
    page,
    symbol,
    kind,
    tradeId: search.get("trade") ?? undefined,
  });
  return (
    <section className="space-y-4">
      <h2>全部成交与来源</h2>
      <BulkTradeLinks batchId={search.get("batch") ?? undefined} />
      <p>包含已清仓交易；建议不自动确认，纸面成交归属固定。</p>
      <Segmented
        label="成交账户类型"
        value={kind}
        options={[
          { value: "real", label: "真实" },
          { value: "paper", label: "纸面" },
          { value: "exchange-simulation", label: "模拟交易所" },
          { value: "all", label: "全部" },
        ]}
        onChange={(v) => {
          setKind(v);
          setPage(0);
        }}
      />
      <Input
        aria-label="成交品种筛选"
        value={symbol}
        onChange={(e) => {
          setSymbol(e.target.value);
          setPage(0);
        }}
        placeholder="证券代码或币对"
        className="max-w-56"
      />
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.isLoading && <p role="status">正在读取成交…</p>}
      <TradeSources
        trades={query.data?.trades ?? []}
        suggestions={query.data?.suggestions ?? []}
        total={query.data?.tradeCount ?? 0}
        page={page}
        setPage={setPage}
        fetching={query.isFetching}
        readError={!!query.error}
      />
    </section>
  );
}
